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
- `binance_account`
- `binance_open_orders`
- `binance_order_status`
- `binance_place_order`
- `binance_cancel_order`
- `binance_cancel_all_orders`

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
