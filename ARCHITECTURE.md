# Arquitetura

NotBroker é uma casa de opções binárias com cotação real e duas contas por usuário: a **demo**,
com dinheiro fictício, e a **real**, com depósito e saque via Pix (VizzionPay) para um grupo fechado
de usuários. Custo zero de infraestrutura e de dados.

## Visão geral

```
            Binance WS ─┐
    Alpaca WS (opcional)─┼─► MarketDataHub ──┬─► BinaryService ──► Postgres
     Yahoo (polling)  ──┘   (último preço)   │   (expiração)      (transações)
                                             └─► SocketGateway ──► navegador (/ws)
```

- **`MarketDataHub`** é o único ponto de preço. Os provedores empurram ticks; o hub guarda o último
  preço de cada ativo e repassa para quem escuta.
- **`BinaryService`** abre e liquida as operações. Abrir debita o valor do saldo dentro de transação
  (`SELECT ... FOR UPDATE` na carteira). As abertas ficam num índice em memória; a cada 200 ms o que
  venceu é liquidado. O preço de saída é o vigente na expiração: o primeiro tick posterior a ela
  congela o preço anterior. No boot, o índice é reconstruído do banco, e o que venceu com o servidor
  fora do ar é estornado.
- **`SocketGateway`** agrega ticks a cada 250 ms (BTC chega a dezenas de negócios por segundo) e
  envia para cada aba só os símbolos que ela assinou, mais a abertura e o fechamento das operações do próprio usuário.

## Estrutura

```
packages/contracts   Tipos e schemas Zod compartilhados entre API e web (DTOs, mensagens WS, regras da casa)
apps/api
  src/config         Variáveis de ambiente validadas no boot
  src/db             Schema Drizzle e conexão (PGlite ou Postgres)
  src/auth           Better Auth + integração com Fastify
  src/market-data    Catálogo, hub e um arquivo por provedor
  src/trading        Contas e serviço de opções binárias
  src/payments       Cliente da VizzionPay e serviço de depósito/saque da conta real
  src/http           Rotas, tratamento de erro e gateway WebSocket
  drizzle/           Migrations SQL geradas (versionadas)
apps/web
  src/lib            Cliente HTTP, auth, stream de mercado, formatação
  src/features       Telas por domínio (auth, trade, payments)
scripts/dev.ts       Sobe API e web juntos
```

## Decisões

| Escolha | Por quê |
|---|---|
| **Node 24 rodando TypeScript direto** | Type stripping nativo: sem build, sem `tsx`/`ts-node`. O `tsconfig` usa `erasableSyntaxOnly` para garantir que só usamos TS que o Node entende. |
| **Fastify** | Maduro, rápido, com WebSocket oficial (`@fastify/websocket`) e hooks que validam a sessão *antes* do upgrade do WS. |
| **Postgres + Drizzle** | Dinheiro pede transação e lock de linha. Drizzle é SQL tipado, sem runtime pesado, e gera migrations legíveis. |
| **PGlite em dev** | Postgres real compilado para WASM. Sem Docker e sem instalar nada, com o mesmo dialeto e as mesmas migrations da produção. Com `DATABASE_URL` definida, troca para Postgres de verdade. |
| **Better Auth** | Auth self-hosted com sessão em cookie e adapter Drizzle. Grátis, sem vendor, e com OAuth/2FA disponíveis como plugins quando fizer sentido. |
| **`numeric(30,10)` + decimal.js** | Nada de float em dinheiro. Valores trafegam como string decimal e só viram número na hora de exibir. |
| **Zod 4** | Um schema valida a entrada da API e tipa o front ao mesmo tempo (`packages/contracts`). |
| **React + Vite + TanStack Query** | SPA simples. O Query cuida de cache e invalidação; preço ao vivo fica fora dele, num store externo com `useSyncExternalStore`, para não renderizar a árvore inteira a cada tick. |
| **lightweight-charts** | O gráfico de candles da TradingView. Apache 2.0, ~45 kB. |
| **Biome** | Lint e formatação numa ferramenta só, rápida. Regras estritas: sem `any`, sem `!`, sem import sem uso. |
| **Vitest** | Mesmo ecossistema do Vite. O teste de integração sobe a API inteira com PGlite em memória. |

## Fontes de dados (todas grátis)

| Mercado | Fonte | Tipo | Observação |
|---|---|---|---|
| Cripto | Binance `data-stream.binance.vision` | WebSocket real-time | Sem chave. Endpoints só de market data. |
| EUA | Alpaca (feed IEX) | WebSocket real-time | Precisa de conta paper grátis (sem depósito). Até 30 símbolos, 1 conexão por chave. |
| EUA (fallback) | Yahoo Finance | Polling (15 s) | Usado quando não há chave da Alpaca. Só gráfico. |
| B3 | Yahoo Finance | Polling (15 s) | **Não oficial**, atraso de ~15 min. Só gráfico. Isolado em `providers/yahoo.ts`. |

Cada provedor declara `realtime`. Binária só abre em mercado servido por provedor tempo real
(Binance, Alpaca). Com cotação atrasada ou por polling, quem olha o preço de agora em outro site
já sabe o resultado ao clicar: a operação inteira aconteceria num trecho de preço que já passou.

Para a B3 não existe WebSocket real-time gratuito. O brapi.dev grátis só entrega candle diário,
atualizado a cada 30 min, o que é pior que o Yahoo para treinar. Quando houver orçamento, basta
escrever outro `MarketDataProvider` e trocar a rota de `B3` em `main.ts`.

## Regras da casa

Ficam em `packages/contracts/src/trades.ts`, para a tela calcular com a mesma regra do servidor.

- Duas carteiras em BRL por usuário. A demo começa em R$ 10.000 e aceita banca nova; a real começa
  em zero e não tem reset. O saldo só muda ao abrir (sai o valor) e ao fechar, e na real também com
  depósito e saque. Cada operação grava de qual conta saiu (`binary_trades.account`).
- **Compra** ganha se o preço de saída ficar acima do de entrada; **venda** ganha se ficar abaixo.
- Win devolve valor + 70% (payout gravado por operação). Loss perde o valor. Empate devolve o valor.
- Expiração no fechamento da vela do tempo escolhido (1m, 5m, 15m, 1h), alinhada ao relógio UTC.
- Entrada só nos primeiros 5 s por minuto de vela (1m = 5 s, 5m = 25 s, 15m = 75 s, 1h = 300 s),
  contados da abertura da vela no mesmo relógio UTC. Fora disso, 409 `ENTRY_WINDOW_CLOSED`.
- Mercado sem fonte tempo real não aceita operação (409 `MARKET_DELAYED`).
- Entrada exige negócio recente: até 5 s em cripto, 15 s em ações (409 `MARKET_CLOSED`).
- Saída: último negócio até a expiração. Se ele estiver mais longe que esse mesmo limite (feed
  parado naquele instante), a operação é estornada em vez de fechar num preço velho.
- A liquidação espera o primeiro negócio depois da expiração (até 3 s em cripto, 10 s em ações);
  sem ele, usa o último conhecido.
- No máximo 20 operações abertas por usuário (422) e 30 aberturas por minuto (429).
- Rate limit: 600 req/min por IP no geral; login/cadastro 10/min por IP; banca nova 5/min por
  usuário. WebSocket: 5 conexões por usuário e 30 mensagens a cada 10 s por conexão (acima
  disso, fecha com 1008).
- A tela conta o tempo no relógio do servidor, estimado por ping/pong no WebSocket.
- Valor mínimo R$ 1, no máximo 2 casas decimais.

## Conta real (Pix)

Regras em `packages/contracts/src/payments.ts`; serviço em `apps/api/src/payments/`.

- **Depósito**: R$ 10 a R$ 5.000, com CPF válido. A API cria a cobrança na VizzionPay
  (`POST /gateway/pix/receive`, `identifier` = id do depósito) e devolve o copia e cola; a tela
  desenha o QR Code a partir dele (o `base64` do gateway vem vazio). No máximo 3 Pix pendentes por
  usuário: o gateway bloqueia a conta inteira com vendas pendentes demais.
- **Saque**: mínimo R$ 200, um por vez por usuário. O valor sai do saldo no pedido, sob lock na
  carteira. Recusado ou cancelado pelo gateway, volta ao saldo uma vez só. Sem resposta na criação
  (timeout), fica `requested` até a consulta decidir; se em 15 min o gateway não conhece o pedido,
  volta. O gateway exige o IPv4 do usuário (por isso `TRUST_PROXY` em produção) e o nome sem acento.
- **Webhook** (`POST /api/webhooks/vizzionpay`, público): só serve de gatilho. O status que vale é o
  da consulta ao gateway (`GET /gateway/transactions` ou `/gateway/transfers`), então um POST forjado
  não credita nada. Crédito e débito acontecem só na troca de status, em transação com lock na linha.
- **Conferência**: a cada minuto, depósitos pendentes e saques em andamento sem consulta há 5 min
  são conferidos, até 10 por rodada (o gateway bloqueia polling). O botão "Já paguei" faz uma
  consulta pontual.
- **Acesso**: com `ALLOWED_EMAILS`, só esses e-mails criam conta. Em produção com as chaves da
  VizzionPay, a lista é obrigatória.
- A VizzionPay bloqueia requisições de fora de Brasil, EUA e Portugal (firewall da AWS, sem
  exceção por IP): a API precisa rodar numa região aceita.

## Limites conhecidos

- O catálogo é fixo em código (`market-data/catalog.ts`) e acompanhado inteiro o tempo todo. Isso é
  ótimo para 15 ativos. Com centenas, o hub precisa assinar sob demanda.
- "Mercado fechado" é inferido pela idade da cotação, não por calendário de pregão.
- A B3 vem do Yahoo com ~15 min de atraso: só gráfico, sem binária, até haver feed tempo real.
- Rate limit em memória (`@fastify/rate-limit`): vale por processo, como a liquidação.
- Cadastro não verifica e-mail. Na demo isso só importa se houver ranking. Na real, a allowlist
  restringe quem entra, mas quem souber um e-mail da lista que ainda não se cadastrou pode criar a
  conta antes do dono: cadastre todos logo depois de configurar a lista.
- O saldo real é a soma das carteiras; o dinheiro está na conta da VizzionPay. O lucro de um usuário
  sai das perdas dos outros: se todos ganharem ao mesmo tempo, o saque falha no gateway por saldo
  insuficiente e o valor volta para a carteira.

## Produção

A API serve o build do front (`apps/web/dist`) na mesma origem de `/api` e `/ws`, como o proxy do
Vite faz em dev: cookie de sessão e WebSocket funcionam sem CORS. Rotas fora de `/api` devolvem o
`index.html`. Toda resposta sai com CSP, `nosniff`, `X-Frame-Options` e, sob HTTPS, HSTS.

Variáveis obrigatórias em produção: `NODE_ENV=production`, `BETTER_AUTH_SECRET` (o valor do
`.env.example` é recusado), `BETTER_AUTH_URL` com a URL pública, `DATABASE_URL` (Postgres). Para a
conta real: `VIZZIONPAY_PUBLIC_KEY`, `VIZZIONPAY_SECRET_KEY` e `ALLOWED_EMAILS`.
Atrás de proxy ou load balancer, `TRUST_PROXY=true` para o rate limit ver o IP real.

O banco PGlite local tem trava por PID + batimento (`db/dir-lock.ts`): o dono atualiza o arquivo a
cada 5 s, e uma trava com PID vivo mas sem batimento (PID reaproveitado após hibernar) é assumida
depois de 10 s.
- A liquidação roda em um processo só. Escalar horizontalmente exige mover as operações abertas
  e os ticks para um pub/sub (Redis, por exemplo).
