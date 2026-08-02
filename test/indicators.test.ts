import assert from "node:assert/strict";
import test from "node:test";
import { atr, ema, previousBreakoutHigh, positionSizeFromRisk, rsi, spreadPercent, type Candle } from "../src/indicators.js";

test("EMA20/EMA3 uses decimal-safe arithmetic", () => {
  assert.equal(ema(["1", "2", "3", "4", "5"], 3), "4");
});

test("RSI returns 100 for an all-gain series", () => {
  assert.equal(rsi(["1", "2", "3", "4", "5", "6"], 3), "100");
});

test("ATR and previous breakout high use completed candle strings", () => {
  const candles: Candle[] = Array.from({ length: 5 }, (_, index) => ({
    openTime: index, closeTime: index, open: String(index + 1), high: String(index + 3), low: String(index), close: String(index + 2), volume: "1", quoteVolume: "1", tradeCount: 1, closed: true,
  }));
  assert.ok(atr(candles, 3));
  assert.equal(previousBreakoutHigh(candles, 3), "6");
});

test("spread and risk position sizing remain decimal strings", () => {
  assert.equal(spreadPercent("99", "101"), "2");
  assert.equal(positionSizeFromRisk("10", "100", "90"), "1");
});
