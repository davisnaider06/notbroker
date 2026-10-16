# Coração da operação

A lógica inteira de uma opção binária no NotBroker, em portugol e num lugar só: abrir a compra ou
a venda, achar o preço de saída e decidir se ganhou, perdeu ou empatou.

É um resumo para leitura. O código que roda de verdade é:

| Parte | Arquivo |
|---|---|
| Abrir, liquidar, resultado e retorno | `apps/api/src/trading/binary-service.ts` |
| Regras da casa e hora do vencimento | `packages/contracts/src/trades.ts` |
| Próximo negócio (`proximo_negocio`) | `apps/api/src/market-data/hub.ts` |

Se mudar uma regra lá, atualize aqui.

```portugol
programa CoracaoDaOperacao

// ======================================================================
// REGRAS DA CASA
// ======================================================================

const real   PAYOUT              = 0.70   // acerto paga +70% do valor apostado
const real   VALOR_MINIMO        = 1.00   // em reais
const inteiro MAX_ABERTAS        = 20     // operações abertas ao mesmo tempo, por usuário
const inteiro CORTE_SEGUNDOS     = 30     // faltando menos que isso, vai para a vela seguinte

// Quanto tempo a abertura espera pelo próximo negócio do ativo
const inteiro ESPERA_ENTRADA_MS[CRIPTO] = 3000
const inteiro ESPERA_ENTRADA_MS[EUA]    = 10000

// Idade máxima de um negócio para valer como entrada ou saída
const inteiro IDADE_MAXIMA_MS[CRIPTO]   = 5000
const inteiro IDADE_MAXIMA_MS[EUA]      = 15000

// Com 70% de payout, só empata quem acerta 1 / 1,7 = 58,8% das operações.
// Acertando metade (chute), perde em média 15% de tudo o que apostar.


// ======================================================================
// 1. ABRIR UMA OPERAÇÃO (compra = aposta que sobe, venda = que desce)
// ======================================================================

funcao Operacao abrir(usuario, ativo, direcao, valor, expiracao)
inicio
    se ativo nao existe no catalogo entao
        erro "Ativo não existe"

    // B3 chega com ~15 min de atraso: o resultado já seria conhecido.
    se mercado_do(ativo) nao eh tempo_real entao
        erro "Binária indisponível nesse mercado: só o gráfico"

    agora <- relogio()                       // hora em que a ordem chegou

    // O preço de entrada é o PRIMEIRO negócio DEPOIS da ordem, nunca o último antes dela.
    // O último pode ter segundos de idade (feed travado, ação parada no IEX), e quem olha
    // outra fonte já sabe para onde o preço foi. O próximo, ninguém conhece ao clicar.
    negocio <- proximo_negocio(ativo, ESPERA_ENTRADA_MS[mercado_do(ativo)])

    se negocio = nenhum entao
        erro "Nenhum negócio novo: mercado parado ou feed travado. Tente de novo."

    // Negócio que chegou agora mas com horário velho (fila de reconexão) também não serve.
    se relogio() - negocio.horario > IDADE_MAXIMA_MS[mercado_do(ativo)] entao
        erro "Sem cotação recente: mercado fechado ou feed parado"

    // Tudo abaixo numa transação só, com a carteira travada: duas ordens simultâneas
    // não furam o saldo nem o limite de abertas.
    TRANSACAO
        carteira <- travar_carteira(usuario)

        se contar_abertas(usuario) >= MAX_ABERTAS entao
            erro "Limite de operações abertas"

        se carteira.saldo < valor entao
            erro "Saldo insuficiente"

        carteira.saldo <- carteira.saldo - valor     // o valor sai do saldo na hora

        operacao.direcao    <- direcao
        operacao.valor      <- valor
        operacao.payout     <- PAYOUT                // gravado: mudar a regra não afeta as abertas
        operacao.entrada    <- negocio.preco
        operacao.aberta_em  <- agora
        operacao.vence_em   <- vencimento(agora, expiracao)
        operacao.situacao   <- "aberta"
        gravar(operacao)
    FIM TRANSACAO

    avisar_tela(usuario, operacao)
    retorne operacao
fim


// ======================================================================
// 2. QUANDO A OPERAÇÃO VENCE
// ======================================================================

// A operação fecha junto com a vela do tempo escolhido (1m, 5m, 15m, 1h), com as velas
// alinhadas ao relógio UTC, igual ao gráfico.
funcao inteiro vencimento(agora_ms, expiracao)
inicio
    tamanho_vela <- segundos_de(expiracao) * 1000
    fim_da_vela  <- piso(agora_ms / tamanho_vela) * tamanho_vela + tamanho_vela

    // Faltando menos de 30 s, entrar agora seria quase adivinhar o fechamento.
    se fim_da_vela - agora_ms < CORTE_SEGUNDOS * 1000 entao
        retorne fim_da_vela + tamanho_vela
    senao
        retorne fim_da_vela
fim


// ======================================================================
// 3. PREÇO DE SAÍDA: o último negócio ATÉ o vencimento
// ======================================================================

// Roda a cada negócio que chega de qualquer ativo.
procedimento ao_chegar_negocio(negocio)
inicio
    anterior <- ultimo_negocio[negocio.ativo]

    para cada operacao em abertas faca
        se operacao.ativo = negocio.ativo
           e operacao.saida_capturada = nenhum
           e operacao.vence_em <= negocio.horario entao
            // Chegou o primeiro negócio depois do vencimento: o preço que valia NO
            // vencimento é o do negócio anterior a ele.
            se anterior <> nenhum entao
                operacao.saida_capturada <- anterior
            senao
                operacao.saida_capturada <- negocio
        fimse
    fimpara

    ultimo_negocio[negocio.ativo] <- negocio
fim

// Decide se o negócio de saída vale ou se a operação é estornada.
funcao preco_de_saida(operacao, negocio)
inicio
    se negocio = nenhum entao
        retorne nenhum                               // => estorno

    // Negócio longe demais do vencimento quer dizer feed parado naquele instante:
    // não sabemos o preço do vencimento, então não inventamos um resultado.
    se abs(operacao.vence_em - negocio.horario) <= IDADE_MAXIMA_MS[mercado_do(operacao.ativo)] entao
        retorne negocio.preco
    senao
        retorne nenhum                               // => estorno
fim


// ======================================================================
// 4. LIQUIDAR: roda a cada 200 ms
// ======================================================================

procedimento liquidar_vencidas()
inicio
    para cada operacao em abertas faca
        se operacao.vence_em <= relogio() entao
            // Sem negócio depois do vencimento, o último conhecido é o que valia nele.
            negocio <- operacao.saida_capturada
            se negocio = nenhum entao
                negocio <- ultimo_negocio[operacao.ativo]

            liquidar(operacao, preco_de_saida(operacao, negocio))
        fimse
    fimpara
fim

procedimento liquidar(operacao, saida)
inicio
    TRANSACAO
        se operacao.situacao <> "aberta" entao
            retorne                                  // já liquidada: não paga duas vezes

        se saida = nenhum entao
            situacao <- "estornada"
        senao
            situacao <- resultado(operacao.direcao, operacao.entrada, saida)

        devolver <- retorno(situacao, operacao.valor, operacao.payout)

        se devolver > 0 entao
            carteira <- travar_carteira(operacao.usuario)
            carteira.saldo <- carteira.saldo + devolver

        operacao.situacao    <- situacao
        operacao.saida       <- saida
        operacao.retorno     <- devolver
        operacao.liquidada_em <- relogio()
        gravar(operacao)
    FIM TRANSACAO

    avisar_tela(operacao.usuario, operacao)
fim


// ======================================================================
// 5. GANHOU, PERDEU OU EMPATOU  <-- a decisão em si
// ======================================================================

funcao cadeia resultado(direcao, entrada, saida)
inicio
    se saida = entrada entao
        retorne "empate"

    subiu <- saida > entrada

    se (direcao = "compra" e subiu) ou (direcao = "venda" e nao subiu) entao
        retorne "ganhou"
    senao
        retorne "perdeu"
fim

// Quanto volta para o saldo (o valor já tinha saído na abertura).
funcao real retorno(situacao, valor, payout)
inicio
    escolha situacao
        caso "ganhou":                  retorne arredondar(valor + valor * payout, 2)
        caso "empate", "estornada":     retorne valor
        caso "perdeu":                  retorne 0
    fimescolha
fim


// ======================================================================
// 6. SERVIDOR REINICIOU
// ======================================================================

procedimento ao_iniciar_servidor()
inicio
    para cada operacao em operacoes_com_situacao("aberta") faca
        se operacao.vence_em <= relogio() entao
            // Venceu com o servidor fora do ar: não temos o preço daquele instante.
            liquidar(operacao, nenhum)              // => estorno, o valor volta
        senao
            acompanhar(operacao)
    fimpara
fim

fimprograma
```

## Exemplo

Saldo R$ 100. Compra de R$ 10 em BTC, expiração 1m, clicada às 13:00:10.

1. A ordem chega às 13:00:10. Chega um negócio a 82.400 → **entrada 82.400**. Saldo vai para R$ 90.
2. `vencimento`: a vela de 1 min fecha às 13:01:00, e faltam 50 s (mais que 30) → **vence 13:01:00**.
3. Às 13:01:00,120 chega o primeiro negócio depois do vencimento. O anterior, das 13:00:59,950,
   foi a 82.450 → **saída 82.450**.
4. `resultado("compra", 82.400, 82.450)`: subiu → **ganhou**.
5. `retorno("ganhou", 10, 0,70)` = 17 → saldo vai para **R$ 107** (lucro de R$ 7).

Se a saída fosse 82.350, perdeu e nada volta (saldo fica em R$ 90). Se fosse 82.400, empate
e voltam os R$ 10.
