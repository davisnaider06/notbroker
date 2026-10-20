import type {
  CreateDepositInput,
  CreateWithdrawalInput,
  DepositDto,
  PaymentsDto,
  WithdrawalDto,
} from '@notbroker/contracts'
import { Decimal } from 'decimal.js'
import { and, count, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm'
import { z } from 'zod'
import type { Database, Executor } from '../db/client.ts'
import { deposits, wallets, withdrawals } from '../db/schema/index.ts'
import type { Logger } from '../market-data/provider.ts'
import { AppError } from '../shared/errors.ts'
import { walletOf } from '../trading/accounts.ts'
import {
  type ChargeStatus,
  GatewayRejectedError,
  GatewayUnavailableError,
  type PaymentGateway,
  type TransferStatus,
} from './vizzionpay.ts'

type DepositRow = typeof deposits.$inferSelect
type WithdrawalRow = typeof withdrawals.$inferSelect
type DepositListener = (userId: string, deposit: DepositDto) => void
type WithdrawalListener = (userId: string, withdrawal: WithdrawalDto) => void

const HISTORY_LIMIT = 20
/** QR Code sem prazo informado pelo gateway: tratado como vencido depois disso. */
const DEFAULT_PIX_TTL_MS = 30 * 60_000
/**
 * Cobranças abertas ao mesmo tempo por usuário. O gateway bloqueia a conta inteira com
 * TOO_MANY_REQUESTS quando há vendas pendentes demais; QR novo a cada clique esgota isso.
 */
const MAX_PENDING_DEPOSITS = 3
const SWEEP_EVERY_MS = 60_000
/** Intervalo mínimo entre duas consultas do mesmo registro: o gateway bloqueia polling. */
const RECHECK_AFTER_MS = 5 * 60_000
const SWEEP_BATCH = 10
/**
 * Saque que nunca chegou ao gateway (timeout na criação e a consulta não acha): passado esse
 * prazo, o valor volta ao saldo.
 */
const LOST_WITHDRAWAL_AFTER_MS = 15 * 60_000

export interface PaymentsUser {
  id: string
  name: string
  email: string
}

export interface PaymentsServiceOptions {
  /** URL pública do webhook. Sem ela (dev em localhost), só a consulta atualiza o status. */
  callbackUrl?: string | undefined
  now?: () => number
  /** Desligado nos testes, que chamam sweep() na mão. */
  autoSweep?: boolean
}

/**
 * Webhook da VizzionPay. Só serve de gatilho: o status que vale é o da consulta ao gateway, então
 * um POST forjado no endpoint público não credita nada. Os campos usados são poucos; o resto do
 * payload é ignorado.
 */
const webhookSchema = z.object({
  event: z.string(),
  transaction: z.object({ id: z.string().optional(), identifier: z.string().nullish() }).optional(),
  withdraw: z
    .object({ id: z.string().optional(), clientIdentifier: z.string().nullish() })
    .optional(),
})

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Dinheiro real: depósito Pix credita a carteira real, saque Pix debita. Todo movimento de saldo
 * acontece numa transação com lock na linha do depósito/saque e na carteira, e só na troca de
 * status: webhook repetido ou consulta simultânea não credita duas vezes.
 */
export class PaymentsService {
  readonly #db: Database
  readonly #gateway: PaymentGateway | undefined
  readonly #logger: Logger
  readonly #callbackUrl: string | undefined
  readonly #now: () => number
  readonly #autoSweep: boolean
  readonly #depositListeners = new Set<DepositListener>()
  readonly #withdrawalListeners = new Set<WithdrawalListener>()
  #timer: NodeJS.Timeout | undefined
  #sweeping = false

  constructor(
    db: Database,
    gateway: PaymentGateway | undefined,
    logger: Logger,
    options: PaymentsServiceOptions = {},
  ) {
    this.#db = db
    this.#gateway = gateway
    this.#logger = logger
    this.#callbackUrl = options.callbackUrl
    this.#now = options.now ?? Date.now
    this.#autoSweep = options.autoSweep ?? true
  }

  get enabled(): boolean {
    return this.#gateway !== undefined
  }

  start(): void {
    if (this.#gateway && this.#autoSweep) {
      this.#timer = setInterval(() => void this.sweep(), SWEEP_EVERY_MS)
    }
  }

  stop(): void {
    clearInterval(this.#timer)
  }

  onDepositUpdate(listener: DepositListener): () => void {
    this.#depositListeners.add(listener)
    return () => this.#depositListeners.delete(listener)
  }

  onWithdrawalUpdate(listener: WithdrawalListener): () => void {
    this.#withdrawalListeners.add(listener)
    return () => this.#withdrawalListeners.delete(listener)
  }

  async overview(userId: string): Promise<PaymentsDto> {
    const depositRows = await this.#db
      .select()
      .from(deposits)
      .where(eq(deposits.userId, userId))
      .orderBy(desc(deposits.createdAt))
      .limit(HISTORY_LIMIT)
    const withdrawalRows = await this.#db
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.userId, userId))
      .orderBy(desc(withdrawals.createdAt))
      .limit(HISTORY_LIMIT)
    return {
      enabled: this.enabled,
      deposits: depositRows.map(toDepositDto),
      withdrawals: withdrawalRows.map(toWithdrawalDto),
    }
  }

  async createDeposit(user: PaymentsUser, input: CreateDepositInput): Promise<DepositDto> {
    const gateway = this.#requireGateway()

    // QR vencido não conta: o sweeper ainda pode não ter fechado o depósito.
    const [pending] = await this.#db
      .select({ value: count() })
      .from(deposits)
      .where(
        and(
          eq(deposits.userId, user.id),
          eq(deposits.status, 'pending'),
          gt(deposits.expiresAt, new Date(this.#now())),
        ),
      )
    if ((pending?.value ?? 0) >= MAX_PENDING_DEPOSITS) {
      throw new AppError(
        409,
        'TOO_MANY_PENDING_DEPOSITS',
        `Você já tem ${MAX_PENDING_DEPOSITS} depósitos esperando pagamento. Pague ou espere vencer.`,
      )
    }

    const [created] = await this.#db
      .insert(deposits)
      .values({
        userId: user.id,
        amount: input.amount,
        document: input.document,
        createdAt: new Date(this.#now()),
      })
      .returning()
    const deposit = mustExist(created)

    let charge: Awaited<ReturnType<PaymentGateway['createPixCharge']>>
    try {
      charge = await gateway.createPixCharge({
        identifier: deposit.id,
        amount: input.amount,
        client: { name: user.name, email: user.email, document: input.document },
        callbackUrl: this.#callbackUrl,
      })
    } catch (error) {
      await this.#db.update(deposits).set({ status: 'failed' }).where(eq(deposits.id, deposit.id))
      throw gatewayAppError(error, 'Não foi possível gerar o Pix')
    }

    const failed = ['FAILED', 'REJECTED', 'CANCELED'].includes(charge.status)
    const [updated] = await this.#db
      .update(deposits)
      .set({
        gatewayId: charge.gatewayId,
        pixCode: charge.pixCode,
        expiresAt: charge.expiresAt ?? new Date(this.#now() + DEFAULT_PIX_TTL_MS),
        status: failed ? 'failed' : 'pending',
      })
      .where(eq(deposits.id, deposit.id))
      .returning()
    if (failed) {
      throw new AppError(
        502,
        'GATEWAY_REJECTED',
        `Pix recusado pelo gateway${charge.errorDescription ? `: ${charge.errorDescription}` : ''}`,
      )
    }
    this.#logger.info(
      { depositId: deposit.id, userId: user.id, amount: input.amount },
      `depósito criado: R$ ${input.amount}, esperando Pix`,
    )
    return toDepositDto(mustExist(updated))
  }

  /** "Já paguei": uma consulta ao gateway para o depósito do próprio usuário. */
  async refreshDeposit(userId: string, depositId: string): Promise<DepositDto> {
    if (!UUID.test(depositId)) throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Depósito não existe')
    const [row] = await this.#db
      .select()
      .from(deposits)
      .where(and(eq(deposits.id, depositId), eq(deposits.userId, userId)))
    if (!row) throw new AppError(404, 'DEPOSIT_NOT_FOUND', 'Depósito não existe')
    return toDepositDto(await this.#reconcileDeposit(row))
  }

  async createWithdrawal(
    user: PaymentsUser,
    input: CreateWithdrawalInput,
    ip: string,
  ): Promise<WithdrawalDto> {
    const gateway = this.#requireGateway()
    const ownerIp = ipv4Of(ip)
    if (!ownerIp) {
      throw new AppError(
        422,
        'IP_UNKNOWN',
        'Não foi possível identificar seu IPv4, exigido pelo gateway para o saque',
      )
    }
    const amount = new Decimal(input.amount)

    const withdrawal = await this.#db.transaction(async (tx) => {
      const [wallet] = await tx
        .select()
        .from(wallets)
        .where(walletOf(user.id, 'real'))
        .for('update')
      if (!wallet) throw new AppError(500, 'ACCOUNT_MISSING', 'Conta não encontrada')
      // Contado depois do lock na carteira: dois pedidos simultâneos não passam juntos.
      const [active] = await tx
        .select({ value: count() })
        .from(withdrawals)
        .where(
          and(
            eq(withdrawals.userId, user.id),
            inArray(withdrawals.status, ['requested', 'processing']),
          ),
        )
      if ((active?.value ?? 0) > 0) {
        throw new AppError(409, 'WITHDRAWAL_IN_PROGRESS', 'Já existe um saque em andamento')
      }
      const balance = new Decimal(wallet.balance)
      if (balance.lessThan(amount)) {
        throw new AppError(422, 'INSUFFICIENT_FUNDS', 'Saldo real insuficiente para esse saque')
      }
      await tx
        .update(wallets)
        .set({ balance: balance.minus(amount).toString() })
        .where(walletOf(user.id, 'real'))
      const [inserted] = await tx
        .insert(withdrawals)
        .values({
          userId: user.id,
          amount: amount.toString(),
          ownerName: input.name,
          document: input.document,
          pixKeyType: input.pixKeyType,
          pixKey: input.pixKey,
          createdAt: new Date(this.#now()),
        })
        .returning()
      return mustExist(inserted)
    })
    this.#logger.info(
      { withdrawalId: withdrawal.id, userId: user.id, amount: withdrawal.amount },
      `saque pedido: R$ ${input.amount}`,
    )

    try {
      const transfer = await gateway.createTransfer({
        identifier: withdrawal.id,
        amount: input.amount,
        pix: { type: input.pixKeyType, key: input.pixKey },
        owner: { ip: ownerIp, name: plainName(input.name), document: input.document },
        callbackUrl: this.#callbackUrl,
      })
      return toWithdrawalDto(
        await this.#applyTransfer(withdrawal.id, transfer.status, {
          gatewayId: transfer.gatewayId,
          fee: transfer.fee,
          reason: transfer.rejectedReason,
        }),
      )
    } catch (error) {
      if (error instanceof GatewayRejectedError) {
        await this.#failWithdrawal(withdrawal.id, error.message)
        throw new AppError(422, 'WITHDRAWAL_REJECTED', `Saque recusado: ${error.message}`)
      }
      if (error instanceof GatewayUnavailableError) {
        // O gateway pode ter recebido: o valor fica preso até a consulta decidir.
        this.#logger.warn(
          { err: error, withdrawalId: withdrawal.id },
          'saque sem resposta do gateway',
        )
        return toWithdrawalDto(withdrawal)
      }
      throw error
    }
  }

  /** Recebe o POST do gateway e confere o status por consulta antes de mexer em saldo. */
  async handleWebhook(payload: unknown): Promise<void> {
    const parsed = webhookSchema.safeParse(payload)
    if (!parsed.success) {
      this.#logger.warn('webhook com formato desconhecido ignorado')
      return
    }
    const { event, transaction, withdraw } = parsed.data
    this.#logger.info({ event }, `webhook recebido: ${event}`)

    if (event.startsWith('TRANSACTION_') && transaction) {
      const row = await this.#findDeposit(transaction.identifier, transaction.id)
      if (row) await this.#reconcileDeposit(row)
    } else if (event.startsWith('TRANSFER_') && withdraw) {
      const row = await this.#findWithdrawal(withdraw.clientIdentifier, withdraw.id)
      if (row) await this.#reconcileWithdrawal(row)
    }
  }

  /**
   * Rede de segurança para webhook perdido: consulta depósitos pendentes e saques em andamento
   * que não foram conferidos recentemente, poucos por rodada.
   */
  async sweep(): Promise<void> {
    if (!this.#gateway || this.#sweeping) return
    this.#sweeping = true
    try {
      const staleBefore = new Date(this.#now() - RECHECK_AFTER_MS)
      const notRecent = (column: typeof deposits.checkedAt | typeof withdrawals.checkedAt) =>
        or(isNull(column), lt(column, staleBefore))

      const pendingDeposits = await this.#db
        .select()
        .from(deposits)
        .where(
          and(
            eq(deposits.status, 'pending'),
            lt(deposits.createdAt, staleBefore),
            notRecent(deposits.checkedAt),
          ),
        )
        .limit(SWEEP_BATCH)
      for (const row of pendingDeposits) {
        await this.#reconcileDeposit(row).catch((error: unknown) =>
          this.#logger.error({ err: error, depositId: row.id }, 'falha ao conferir depósito'),
        )
      }

      const activeWithdrawals = await this.#db
        .select()
        .from(withdrawals)
        .where(
          and(
            inArray(withdrawals.status, ['requested', 'processing']),
            lt(withdrawals.createdAt, staleBefore),
            notRecent(withdrawals.checkedAt),
          ),
        )
        .limit(SWEEP_BATCH)
      for (const row of activeWithdrawals) {
        await this.#reconcileWithdrawal(row).catch((error: unknown) =>
          this.#logger.error({ err: error, withdrawalId: row.id }, 'falha ao conferir saque'),
        )
      }
    } finally {
      this.#sweeping = false
    }
  }

  async #reconcileDeposit(row: DepositRow): Promise<DepositRow> {
    const gateway = this.#requireGateway()
    if (!row.gatewayId) return row
    await this.#db
      .update(deposits)
      .set({ checkedAt: new Date(this.#now()) })
      .where(eq(deposits.id, row.id))

    const charge = await gateway.getCharge(row.gatewayId)
    if (!charge || (charge.clientIdentifier && charge.clientIdentifier !== row.id)) {
      this.#logger.error({ depositId: row.id }, 'depósito não confere com o gateway')
      return row
    }
    return this.#applyCharge(row.id, charge.status)
  }

  /** Aplica o status do gateway. Crédito e débito só na troca de status, sob lock. */
  async #applyCharge(depositId: string, status: ChargeStatus): Promise<DepositRow> {
    const now = this.#now()
    const result = await this.#db.transaction(async (tx) => {
      const [row] = await tx.select().from(deposits).where(eq(deposits.id, depositId)).for('update')
      const deposit = mustExist(row)

      if (status === 'COMPLETED' && deposit.status !== 'paid' && deposit.status !== 'refunded') {
        // Pix pago depois do vencimento local também credita: o dinheiro entrou.
        await addToWallet(tx, deposit.userId, new Decimal(deposit.amount))
        const [updated] = await tx
          .update(deposits)
          .set({ status: 'paid', paidAt: new Date(now) })
          .where(eq(deposits.id, depositId))
          .returning()
        return { row: mustExist(updated), changed: 'paid' as const }
      }
      if ((status === 'REFUNDED' || status === 'CHARGED_BACK') && deposit.status === 'paid') {
        // Estorno depois do crédito: o saldo pode ficar negativo, e isso precisa aparecer.
        await addToWallet(tx, deposit.userId, new Decimal(deposit.amount).negated())
        const [updated] = await tx
          .update(deposits)
          .set({ status: 'refunded' })
          .where(eq(deposits.id, depositId))
          .returning()
        return { row: mustExist(updated), changed: 'refunded' as const }
      }
      if (deposit.status === 'pending' && (status === 'FAILED' || status === 'EXPIRED')) {
        const [updated] = await tx
          .update(deposits)
          .set({ status: status === 'FAILED' ? 'failed' : 'expired' })
          .where(eq(deposits.id, depositId))
          .returning()
        return { row: mustExist(updated), changed: 'closed' as const }
      }
      return { row: deposit, changed: null }
    })

    if (result.changed) {
      const { row } = result
      const log = result.changed === 'refunded' ? this.#logger.error : this.#logger.info
      log.call(
        this.#logger,
        { depositId: row.id, userId: row.userId, amount: row.amount, status: row.status },
        result.changed === 'paid'
          ? `depósito pago: R$ ${row.amount} creditado na conta real`
          : result.changed === 'refunded'
            ? `depósito estornado no gateway: R$ ${row.amount} debitado da conta real`
            : `depósito encerrado sem pagamento: ${row.status}`,
      )
      this.#emitDeposit(row)
    }
    return result.row
  }

  async #reconcileWithdrawal(row: WithdrawalRow): Promise<WithdrawalRow> {
    const gateway = this.#requireGateway()
    await this.#db
      .update(withdrawals)
      .set({ checkedAt: new Date(this.#now()) })
      .where(eq(withdrawals.id, row.id))

    const transfer = await gateway.getTransfer(
      row.gatewayId ? { gatewayId: row.gatewayId } : { identifier: row.id },
    )
    if (!transfer) {
      if (!row.gatewayId && this.#now() - row.createdAt.getTime() > LOST_WITHDRAWAL_AFTER_MS) {
        return this.#failWithdrawal(row.id, 'O pedido não chegou ao gateway')
      }
      return row
    }
    if (transfer.clientIdentifier && transfer.clientIdentifier !== row.id) {
      this.#logger.error({ withdrawalId: row.id }, 'saque não confere com o gateway')
      return row
    }
    return this.#applyTransfer(row.id, transfer.status, {
      gatewayId: transfer.gatewayId,
      fee: null,
      reason: transfer.rejectedReason,
    })
  }

  async #applyTransfer(
    withdrawalId: string,
    status: TransferStatus,
    details: { gatewayId: string; fee: string | null; reason: string | null },
  ): Promise<WithdrawalRow> {
    if (status === 'CANCELED') {
      return this.#failWithdrawal(withdrawalId, details.reason ?? 'Cancelado pelo gateway', details)
    }
    const next = status === 'COMPLETED' ? 'completed' : 'processing'
    const result = await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.id, withdrawalId))
        .for('update')
      const withdrawal = mustExist(row)
      if (withdrawal.status === 'completed' || withdrawal.status === 'failed') {
        return { row: withdrawal, changed: false }
      }
      const [updated] = await tx
        .update(withdrawals)
        .set({
          status: next,
          gatewayId: details.gatewayId,
          ...(details.fee !== null ? { fee: details.fee } : {}),
          ...(next === 'completed' ? { completedAt: new Date(this.#now()) } : {}),
        })
        .where(eq(withdrawals.id, withdrawalId))
        .returning()
      return { row: mustExist(updated), changed: withdrawal.status !== next }
    })
    if (result.changed) {
      this.#logger.info(
        { withdrawalId, userId: result.row.userId, status: result.row.status },
        next === 'completed'
          ? `saque concluído: R$ ${result.row.amount}`
          : `saque em processamento no gateway: R$ ${result.row.amount}`,
      )
      this.#emitWithdrawal(result.row)
    }
    return result.row
  }

  /** Marca o saque como falho e devolve o valor à conta real, uma vez só. */
  async #failWithdrawal(
    withdrawalId: string,
    reason: string,
    details?: { gatewayId: string },
  ): Promise<WithdrawalRow> {
    const result = await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(withdrawals)
        .where(eq(withdrawals.id, withdrawalId))
        .for('update')
      const withdrawal = mustExist(row)
      if (withdrawal.status === 'completed' || withdrawal.status === 'failed') {
        return { row: withdrawal, changed: false }
      }
      await addToWallet(tx, withdrawal.userId, new Decimal(withdrawal.amount))
      const [updated] = await tx
        .update(withdrawals)
        .set({
          status: 'failed',
          failureReason: reason,
          ...(details ? { gatewayId: details.gatewayId } : {}),
        })
        .where(eq(withdrawals.id, withdrawalId))
        .returning()
      return { row: mustExist(updated), changed: true }
    })
    if (result.changed) {
      this.#logger.warn(
        { withdrawalId, userId: result.row.userId, reason },
        `saque falhou: R$ ${result.row.amount} devolvido à conta real`,
      )
      this.#emitWithdrawal(result.row)
    }
    return result.row
  }

  async #findDeposit(
    identifier: string | null | undefined,
    gatewayId: string | undefined,
  ): Promise<DepositRow | undefined> {
    if (identifier && UUID.test(identifier)) {
      const [row] = await this.#db.select().from(deposits).where(eq(deposits.id, identifier))
      if (row) return row
    }
    if (!gatewayId) return undefined
    const [row] = await this.#db.select().from(deposits).where(eq(deposits.gatewayId, gatewayId))
    return row
  }

  async #findWithdrawal(
    identifier: string | null | undefined,
    gatewayId: string | undefined,
  ): Promise<WithdrawalRow | undefined> {
    if (identifier && UUID.test(identifier)) {
      const [row] = await this.#db.select().from(withdrawals).where(eq(withdrawals.id, identifier))
      if (row) return row
    }
    if (!gatewayId) return undefined
    const [row] = await this.#db
      .select()
      .from(withdrawals)
      .where(eq(withdrawals.gatewayId, gatewayId))
    return row
  }

  #requireGateway(): PaymentGateway {
    if (!this.#gateway) {
      throw new AppError(503, 'PAYMENTS_DISABLED', 'Conta real indisponível neste servidor')
    }
    return this.#gateway
  }

  #emitDeposit(row: DepositRow): void {
    const dto = toDepositDto(row)
    for (const listener of this.#depositListeners) listener(row.userId, dto)
  }

  #emitWithdrawal(row: WithdrawalRow): void {
    const dto = toWithdrawalDto(row)
    for (const listener of this.#withdrawalListeners) listener(row.userId, dto)
  }
}

async function addToWallet(tx: Executor, userId: string, delta: Decimal): Promise<void> {
  const [wallet] = await tx.select().from(wallets).where(walletOf(userId, 'real')).for('update')
  if (!wallet) throw new AppError(500, 'ACCOUNT_MISSING', 'Conta não encontrada')
  await tx
    .update(wallets)
    .set({ balance: new Decimal(wallet.balance).plus(delta).toString() })
    .where(walletOf(userId, 'real'))
}

function gatewayAppError(error: unknown, action: string): Error {
  if (error instanceof GatewayRejectedError) {
    return new AppError(502, 'GATEWAY_REJECTED', `${action}: ${error.message}`)
  }
  if (error instanceof GatewayUnavailableError) {
    return new AppError(502, 'GATEWAY_UNAVAILABLE', `${action}: gateway indisponível`)
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** IPv4 do cliente; o gateway recusa IPv6. Aceita o formato mapeado (::ffff:1.2.3.4). */
export function ipv4Of(ip: string): string | null {
  const candidate = ip.startsWith('::ffff:') ? ip.slice(7) : ip
  return /^(\d{1,3})(\.\d{1,3}){3}$/.test(candidate) ? candidate : null
}

/** O gateway só aceita letras sem acento no nome do titular. */
export function plainName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function toDepositDto(row: DepositRow): DepositDto {
  return {
    id: row.id,
    amount: row.amount,
    status: row.status,
    pixCode: row.pixCode ?? '',
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
  }
}

function toWithdrawalDto(row: WithdrawalRow): WithdrawalDto {
  return {
    id: row.id,
    amount: row.amount,
    fee: row.fee,
    status: row.status,
    pixKeyType: row.pixKeyType,
    pixKey: row.pixKey,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  }
}

function mustExist<T>(row: T | undefined): T {
  if (row === undefined) throw new Error('escrita no banco não retornou a linha')
  return row
}
