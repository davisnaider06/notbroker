# Arquitetura

B-Hook é uma corretora simulada (paper trading): cotação real, dinheiro fictício. Multiusuário
desde o início, custo zero de infraestrutura e de dados.

## Visão geral

```
            Binance WS ─┐
    Alpaca WS (opcional)─┼─► MarketDataHub ──┬─► MatchingEngine ──► OrderService ──► Postgres
     Yahoo (polling)  ──┘   (último preço)   │      (limites)        (transações)
                                             └─► SocketGateway ──► navegador (/ws)
```

- **`MarketDataHub`** é o único ponto de preço. Os provedores empurram ticks; o hub guarda o último
  preço de cada ativo e repassa para quem escuta.
- **`MatchingEngine`** mantém as ordens limitadas abertas em memória, indexadas por símbolo. Quando
  um tick cruza o limite, entrega a ordem ao `OrderService`. O banco é a fonte da verdade: o índice
  é reconstruído a partir dele no boot.
- **`OrderService`** faz toda movimentação de dinheiro e posição dentro de transação, com
  `SELECT ... FOR UPDATE` sempre na mesma ordem (carteira → posição) para não haver deadlock.
- **`SocketGateway`** agrega ticks a cada 250 ms (BTC chega a dezenas de negócios por segundo) e
  envia para cada aba só os símbolos que ela assinou, mais os eventos das ordens do próprio usuário.

## Estrutura

```
packages/contracts   Tipos e schemas Zod compartilhados entre API e web (DTOs, mensagens WS, taxas)
apps/api
  src/config         Variáveis de ambiente validadas no boot
  src/db             Schema Drizzle e conexão (PGlite ou Postgres)
  src/auth           Better Auth + integração com Fastify
  src/market-data    Catálogo, hub e um arquivo por provedor
  src/trading        Regras de dinheiro (ledger), matching e serviço de ordens
  src/http           Rotas, tratamento de erro e gateway WebSocket
  drizzle/           Migrations SQL geradas (versionadas)
apps/web
  src/lib            Cliente HTTP, auth, stream de mercado, formatação
  src/features       Telas por domínio (auth, trade)
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
| EUA (fallback) | Yahoo Finance | Polling (15 s) | Usado quando não há chave da Alpaca. |
| B3 | Yahoo Finance | Polling (15 s) | **Não oficial**, atraso de ~15 min. Fica isolado em `providers/yahoo.ts`. |

Para a B3 não existe WebSocket real-time gratuito. O brapi.dev grátis só entrega candle diário,
atualizado a cada 30 min, o que é pior que o Yahoo para treinar. Quando houver orçamento, basta
escrever outro `MarketDataProvider` e trocar a rota de `B3` em `main.ts`.

## Regras de simulação

- Ordem a mercado executa no último preço recebido. Sem preço, é recusada (409).
- Ordem limitada de compra **reserva** `quantidade × limite × (1 + taxa)` do saldo. A venda limitada
  trava a quantidade na posição. Cancelar ou executar devolve a reserva.
- A limitada executa no preço do tick que cruzou: compra quando preço ≤ limite, venda quando ≥.
- Taxas em `packages/contracts/src/markets.ts`: Binance 0,1%, EUA 0%, B3 0,03%.
- Sem venda a descoberto e sem alavancagem.
- Saldo inicial: 10.000 USDT, 10.000 USD, R$ 50.000.

## Limites conhecidos

- O catálogo é fixo em código (`market-data/catalog.ts`) e acompanhado inteiro o tempo todo. Isso é
  ótimo para 15 ativos. Com centenas, o hub precisa assinar sob demanda.
- Não há bloqueio por horário de pregão: fora do horário, a ordem executa no último preço.
- O matching roda em um processo só. Escalar horizontalmente exige mover o livro e os ticks para um
  pub/sub (Redis, por exemplo).
