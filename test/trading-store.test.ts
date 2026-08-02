import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TradingStore } from "../src/trading-store.js";

function store(): TradingStore {
  return new TradingStore(join(mkdtempSync(join(tmpdir(), "binance-mcp-")), "trading.db"));
}

test("cycle locks reject duplicates and overlapping cycles", () => {
  const db = store();
  db.beginCycle("strategy", "cycle-1", 1_000);
  assert.throws(() => db.beginCycle("strategy", "cycle-1", 2_000), /Duplicate cycle ID/);
  assert.throws(() => db.beginCycle("strategy", "cycle-2", 2_000), /already active/);
  db.endCycle("strategy", "cycle-1", "DONE", "ok", 3_000);
  db.beginCycle("strategy", "cycle-2", 4_000);
  db.close();
});

test("stale locks expire after twenty minutes", () => {
  const db = store();
  db.beginCycle("strategy", "old", 1_000);
  db.beginCycle("strategy", "new", 1_000 + 20 * 60 * 1000);
  assert.throws(() => db.beginCycle("strategy", "new", 1_000 + 20 * 60 * 1000 + 1), /Duplicate cycle ID/);
  db.close();
});

test("state updates and journal performance are persisted", () => {
  const db = store();
  db.updateState("strategy", { currentPosition: "LONG", entryPrice: "100", dailyRealizedPnl: "0" });
  assert.equal(db.getState("strategy").entryPrice, "100");
  db.appendJournal({ strategyId: "strategy", cycleId: "c1", action: "EXIT", symbol: "BTCUSDT", decision: "close", reason: "test", realizedPnl: "10", realizedR: "2" });
  db.appendJournal({ strategyId: "strategy", cycleId: "c2", action: "EMERGENCY_EXIT", symbol: "BTCUSDT", decision: "close", reason: "test", realizedPnl: "-5", realizedR: "-1" });
  const summary = db.performanceSummary("strategy");
  assert.equal(summary.completedTrades, 2);
  assert.equal(summary.netRealizedPnl, "5");
  assert.equal(summary.emergencyExitCount, 1);
  db.close();
});
