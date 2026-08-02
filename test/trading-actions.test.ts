import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectFilledBuyOrEmergencyExit } from "../src/trading-actions.js";
import { placeOcoExit } from "../src/trading-actions.js";
import { TradingStore } from "../src/trading-store.js";

test("filled BUY followed by failed OCO triggers emergency MARKET SELL and journal record", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    publicGet: async (path: string) => path.includes("ticker")
      ? { price: "100" }
      : {
          symbols: [{
            symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", orderTypes: ["LIMIT"], filters: [
              { filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "1000000", tickSize: "1" },
              { filterType: "LOT_SIZE", minQty: "0.001", maxQty: "100", stepSize: "0.001" },
            ],
          }],
        },
    signedGet: async () => ({ balances: [{ asset: "BTC", free: "1" }] }),
    signedPost: async (_path: string, params: Record<string, unknown>) => { calls.push(params); if (calls.length === 1) throw new Error("OCO failed"); return { orderId: 99, executedQty: "1" }; },
  } as never;
  const db = new TradingStore(join(mkdtempSync(join(tmpdir(), "binance-mcp-")), "trading.db"));
  const result = await protectFilledBuyOrEmergencyExit(client, db, { symbol: "BTCUSDT", quantity: "1", takeProfitPrice: "120", stopPrice: "90", stopLimitPrice: "89" }, { strategyId: "s", cycleId: "c", symbol: "BTCUSDT", decision: "protect", reason: "test" });
  assert.equal(result.protected, false);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]?.type, "MARKET");
  assert.equal(db.recentJournal("s")[0]?.action, "EMERGENCY_EXIT");
  db.close();
});

test("OCO rejects a take-profit that is not above market", async () => {
  const client = {
    publicGet: async (path: string) => path.includes("ticker") ? { price: "100" } : { symbols: [{ symbol: "BTCUSDT", status: "TRADING", baseAsset: "BTC", quoteAsset: "USDT", orderTypes: ["LIMIT"], filters: [{ filterType: "PRICE_FILTER", minPrice: "1", maxPrice: "1000000", tickSize: "1" }, { filterType: "LOT_SIZE", minQty: "1", maxQty: "100", stepSize: "1" }] }] },
    signedGet: async () => ({ balances: [{ asset: "BTC", free: "10" }] }),
    signedPost: async () => { throw new Error("must not submit"); },
  } as never;
  await assert.rejects(() => placeOcoExit(client, { symbol: "BTCUSDT", quantity: "1", takeProfitPrice: "99", stopPrice: "90", stopLimitPrice: "89" }), /takeProfitPrice must be above current market price/);
});
