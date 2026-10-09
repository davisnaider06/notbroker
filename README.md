# NotBroker

Casa de opções binárias simulada para treinar com cotação real de cripto (Binance), ações dos EUA
(Alpaca/Yahoo) e B3 (Yahoo). Dinheiro fictício, custo zero.

## Rodando

Requisito: Node 24+.

```bash
npm install
cp apps/api/.env.example apps/api/.env   # e troque o BETTER_AUTH_SECRET
npm run dev
```

Abra http://localhost:5173 e crie uma conta. O banco (PGlite) é criado sozinho em
`apps/api/.data/`, sem Docker.

Gerar um segredo:

```bash
node -e "console.log(crypto.randomBytes(32).toString('base64url'))"
```

### Ações dos EUA em tempo real (opcional)

Crie uma conta grátis em https://alpaca.markets (paper trading, sem depósito), gere as chaves
de API e preencha `ALPACA_KEY_ID` e `ALPACA_SECRET_KEY` no `.env`. Sem elas, EUA usa polling
do Yahoo.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | API (3333) + web (5173) com reload |
| `npm run verify` | Lint, typecheck e testes, a mesma checagem para rodar antes de subir |
| `npm run fix` | Formata e corrige o que o Biome souber |
| `npm run db:generate -w @notbroker/api` | Gera migration depois de mudar o schema. Ela é aplicada sozinha no próximo boot. |

## API

| Método | Rota | Auth |
|---|---|---|
| `GET` | `/api/instruments` | não |
| `GET` | `/api/instruments/:symbol/candles?interval=1m\|5m\|15m\|1h\|1d` | não |
| `*` | `/api/auth/*` (Better Auth: `sign-up/email`, `sign-in/email`, `sign-out`, `get-session`) | n/a |
| `GET` | `/api/me` · `/api/account` · `/api/trades` | sim |
| `POST` | `/api/trades` `{ symbol, direction: buy\|sell, stake, expiration: 1m\|5m\|15m\|1h }` | sim |
| `GET` | `/api/fx` (câmbio para exibição) | não |
| `WS` | `/ws`: envie `{ type: "subscribe", symbols: [...] }`, recebe `tick` e `trade` | sim |

As decisões técnicas e o porquê de cada uma estão em [ARCHITECTURE.md](./ARCHITECTURE.md).
