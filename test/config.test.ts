import assert from "node:assert/strict";
import test from "node:test";
import { BINANCE_BASE_URLS, loadConfig } from "../src/config.js";
import { assertLiveTradingAllowed } from "../src/tools.js";

test("maps each Binance environment to its distinct base URL", () => {
  for (const environment of ["demo", "testnet", "live"] as const) {
    assert.equal(
      loadConfig({ BINANCE_ENV: environment }).baseUrl,
      BINANCE_BASE_URLS[environment],
    );
  }
  assert.equal(BINANCE_BASE_URLS.demo, "https://demo-api.binance.com");
  assert.equal(BINANCE_BASE_URLS.testnet, "https://testnet.binance.vision");
  assert.equal(BINANCE_BASE_URLS.live, "https://api.binance.com");
});

test("live trading guard blocks trading unless explicitly enabled", () => {
  const config = loadConfig({
    BINANCE_ENV: "live",
    BINANCE_ALLOW_LIVE_TRADING: "false",
  });
  assert.throws(
    () => assertLiveTradingAllowed(config),
    /Live trading is disabled by the safety guard/,
  );
});

test("live trading guard permits an explicit true value", () => {
  const config = loadConfig({
    BINANCE_ENV: "live",
    BINANCE_ALLOW_LIVE_TRADING: "true",
  });
  assert.doesNotThrow(() => assertLiveTradingAllowed(config));
});
