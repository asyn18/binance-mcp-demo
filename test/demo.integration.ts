import "dotenv/config";
import assert from "node:assert/strict";
import { BinanceClient } from "../src/binance-client.js";
import { loadConfig } from "../src/config.js";
import { marketSnapshot } from "../src/market-data.js";
import { TradingStore } from "../src/trading-store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  assert.equal(config.environment, "demo", "test:demo requires BINANCE_ENV=demo");
  const client = new BinanceClient(config);
  const store = new TradingStore();
  await client.signedGet("/api/v3/account");
  const snapshot = await marketSnapshot(client, process.env.DEMO_SYMBOL?.toUpperCase() ?? "BTCUSDT", "15m", "1h");
  console.log(JSON.stringify({ account: "ok", snapshot: { enoughData: snapshot.enoughData, staleData: snapshot.staleData } }));
  if (process.env.DEMO_INTEGRATION_TRADING !== "true") {
    console.log("Demo integration trading is disabled; no order was placed.");
    return;
  }
  const quantity = process.env.DEMO_QUANTITY;
  assert.ok(quantity, "Set DEMO_QUANTITY when DEMO_INTEGRATION_TRADING=true.");
  const symbol = process.env.DEMO_SYMBOL?.toUpperCase() ?? "BTCUSDT";
  const buy = await client.signedPost("/api/v3/order", { symbol, side: "BUY", type: "MARKET", quantity });
  const executedQty = (buy as { executedQty?: string }).executedQty ?? quantity;
  try {
    await client.signedPost("/api/v3/order", { symbol, side: "SELL", type: "MARKET", quantity: executedQty });
    store.appendJournal({ strategyId: "demo-integration", cycleId: `demo-${Date.now()}`, action: "DEMO_INTEGRATION", symbol, decision: "BUY_THEN_MARKET_SELL", reason: "Optional demo integration smoke test", quantity: executedQty, orderIds: { buyOrderId: (buy as { orderId?: number }).orderId ?? "unknown" } });
  } finally {
    console.log(JSON.stringify({ demoOrder: "placed-and-closed", executedQty }));
    store.close();
  }
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
