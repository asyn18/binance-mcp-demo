# binance-mcp-demo

A local stdio MCP server for Binance Spot, written in TypeScript for Node.js
20+. It uses native `fetch`, Node's `crypto` module, the official
`@modelcontextprotocol/sdk`, and no Binance SDK wrapper.

## Environments

| `BINANCE_ENV` | Base URL | Credentials |
| --- | --- | --- |
| `demo` | `https://demo-api.binance.com` | Binance Demo Mode |
| `testnet` | `https://testnet.binance.vision` | Spot Testnet |
| `live` | `https://api.binance.com` | Live Binance Spot |

**Binance Demo Mode and Spot Testnet are different systems.** Keys created at
`demo.binance.com` must use `https://demo-api.binance.com`, not
`https://testnet.binance.vision`. Spot Testnet keys for
`testnet.binance.vision` are separate from Demo Mode keys.

## Install and configure

```bash
npm install
cp .env.example .env
```

Edit `.env` and set the appropriate key and secret. Credentials are never
hardcoded, and `.env` is ignored by Git.

```dotenv
BINANCE_ENV=demo
BINANCE_API_KEY=your_demo_api_key
BINANCE_API_SECRET=your_demo_api_secret
BINANCE_RECV_WINDOW=10000
BINANCE_ALLOW_LIVE_TRADING=false
BINANCE_LOG_LEVEL=info
```

Build and run:

```bash
npm run typecheck
npm test
npm run build
npm start
```

The server communicates over stdio, so normally Hermes starts it rather than
you running `npm start` interactively.

## Diagnose

The diagnostic command checks server time and the signed account endpoint. It
prints only a masked API key and never prints the secret or signature.

```bash
BINANCE_ENV=demo \
BINANCE_API_KEY='your_demo_api_key' \
BINANCE_API_SECRET='your_demo_api_secret' \
npm run diagnose
```

It exits with status 0 when `/api/v3/account` succeeds and non-zero otherwise.

## Demo-only integration test

Normal `npm test` never contacts Binance and never places an order. The opt-in
integration command refuses to run unless `BINANCE_ENV=demo`; it checks account
access and a market snapshot, then does nothing unless
`DEMO_INTEGRATION_TRADING=true`:

```bash
BINANCE_ENV=demo DEMO_INTEGRATION_TRADING=false npm run test:demo
```

For the optional buy-then-close smoke test, provide a deliberately small,
valid demo quantity (the command immediately submits a MARKET SELL afterward):

```bash
BINANCE_ENV=demo DEMO_INTEGRATION_TRADING=true DEMO_SYMBOL=BTCUSDT DEMO_QUANTITY=0.001 npm run test:demo
```

Never use this command with live or testnet credentials. Demo keys and Spot
Testnet keys are separate.

## Hermes Agent configuration

Hermes reads MCP server configuration from `~/.hermes/config.yaml`. Use the
absolute project path so Hermes does not depend on its working directory.

Demo:

```yaml
mcp_servers:
  binance-spot:
    command: node
    args:
      - /home/ahmed/binance-mcp-demo/dist/src/index.js
    env:
      BINANCE_ENV: demo
      BINANCE_API_KEY: ${BINANCE_API_KEY}
      BINANCE_API_SECRET: ${BINANCE_API_SECRET}
      BINANCE_RECV_WINDOW: "10000"
      BINANCE_ALLOW_LIVE_TRADING: "false"
      BINANCE_LOG_LEVEL: info
```

Live (safe, read-only/order-query behavior until explicitly enabled):

```yaml
mcp_servers:
  binance-spot-live:
    command: node
    args:
      - /home/ahmed/binance-mcp-demo/dist/src/index.js
    env:
      BINANCE_ENV: live
      BINANCE_API_KEY: ${BINANCE_API_KEY}
      BINANCE_API_SECRET: ${BINANCE_API_SECRET}
      BINANCE_RECV_WINDOW: "10000"
      BINANCE_ALLOW_LIVE_TRADING: "false"
      BINANCE_LOG_LEVEL: info
```

Only set `BINANCE_ALLOW_LIVE_TRADING: "true"` after intentionally deciding to
allow live place/cancel actions. Trading tools remain visible when the guard is
off, but return a clear MCP error if called.

## Available tools

- `binance_connection_info`
- `binance_server_time`
- `binance_price`
- `binance_order_book`
- `binance_symbol_info`
- `binance_klines`
- `binance_ticker_24h`
- `binance_account`
- `binance_open_orders`
- `binance_order_status`
- `binance_all_orders`
- `binance_my_trades`
- `binance_order_list_status`
- `binance_place_order`
- `binance_place_oco_exit`
- `binance_cancel_order`
- `binance_cancel_all_orders`
- `binance_cancel_order_list`
- `binance_portfolio_summary`
- `binance_market_snapshot`
- `trading_cycle_begin`
- `trading_cycle_end`
- `trading_state_get`
- `trading_state_update`
- `trading_journal_append`
- `trading_journal_recent`
- `trading_performance_summary`

Example Hermes prompts:

- “Show my Binance connection info and server time.”
- “What is the current BTCUSDT price and the top 20 order-book levels?”
- “Show the BTCUSDT trading rules, tick size, lot size, and notional limits.”
- “Show my account balances and open ETHUSDT orders.”
- “Check order 12345 for BTCUSDT.”
- “On the configured non-live environment, place a LIMIT BUY for 0.001
  BTCUSDT at 50000 USDT.”
- “Cancel all open BTCUSDT orders.”

`binance_place_order` loads the symbol rules before submitting an order. It
rejects prices or quantities that are out of range or not aligned to Binance's
tick/step sizes, and reports the normalized value for the user to review. It
never silently submits a materially adjusted order.

## Troubleshooting `-2015`

Binance error `-2015` means the API key, IP, or permissions are invalid for the
request. Check all of the following:

1. The key belongs to the selected environment. Demo, Spot Testnet, and live
   keys are not interchangeable.
2. `BINANCE_ENV` selects the matching base URL shown above.
3. The key has the required Spot/account or trading permissions.
4. Any IP allowlist on the key includes the machine running Hermes.
5. The key and secret were copied without whitespace or shell interpolation.
6. The key has not expired, been deleted, or been regenerated.

Run `npm run diagnose` after correcting the configuration.

## Autonomous loop architecture

Hermes can run a long-only Spot strategy as a guarded sequence:

1. `trading_cycle_begin` atomically claims a strategy/cycle lock. Duplicate
   cycles are rejected and locks older than 20 minutes are recovered.
2. `binance_portfolio_summary` and `binance_market_snapshot` provide account,
   completed-candle indicators, liquidity, and stale-data checks.
3. A strategy can submit one idempotent BUY with `binance_place_order`, then
   immediately call `binance_place_oco_exit` after the fill.
4. `trading_state_update` records the position and protection IDs;
   `trading_journal_append` records every decision and result.
5. The cycle ends with `trading_cycle_end`. Performance is read from SQLite by
   `trading_performance_summary`.

This server supports Spot long-only behavior: it does not short, borrow, or
trade Futures. OCO protection is the expected exit workflow. If an automated
workflow cannot place protection after a filled BUY, use the emergency recovery
helper in `src/trading-actions.ts`, which submits a MARKET SELL and journals the
emergency action. If both requests fail, stop automation and manually reconcile
the position with `binance_account`, `binance_order_status`, and
`binance_open_orders` before acting.

The SQLite database is stored at `data/trading.db` (ignored by Git). Inspect it
with the SQLite CLI, for example:

```bash
sqlite3 data/trading.db 'select timestamp,strategy_id,cycle_id,action,realized_pnl from trading_journal order by timestamp desc limit 20;'
```

Example daily Hermes cron entry (adjust the command to your Hermes install):

```cron
*/15 * * * * cd /home/ahmed/binance-mcp-demo && hermes chat --prompt 'Run one guarded demo Spot cycle for strategy btc-breakout; use completed candles, acquire a cycle lock, protect any filled BUY with OCO, journal every decision, and end the cycle.' >> /tmp/binance-hermes.log 2>&1
```

The indicators, risk sizing, journal calculations, and safety checks are
mechanical safeguards—not evidence of profitability. Paper/demo results do not
predict live performance; never enable live trading automatically.
