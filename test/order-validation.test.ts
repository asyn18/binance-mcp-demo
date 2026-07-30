import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeToStep,
  validateMinimumNotional,
  validatePercentPriceBySide,
} from "../src/order-validation.js";

test("normalizes price down to the PRICE_FILTER tick size", () => {
  assert.equal(normalizeToStep("123.4567", "0.01", "0.01"), "123.45");
});

test("normalizes quantity down to the LOT_SIZE step size", () => {
  assert.equal(normalizeToStep("1.2349", "0.001", "0.001"), "1.234");
});

test("rejects orders below the minimum notional", () => {
  assert.throws(
    () => validateMinimumNotional("10", "0.5", "10"),
    /Order notional 5 is below the minimum notional 10/,
  );
});

test("rejects a BUY price outside PERCENT_PRICE_BY_SIDE", () => {
  assert.throws(
    () =>
      validatePercentPriceBySide("BUY", "121", "100", {
        bidMultiplierDown: "0.8",
        bidMultiplierUp: "1.2",
        askMultiplierDown: "0.7",
        askMultiplierUp: "1.3",
      }),
    /outside the PERCENT_PRICE_BY_SIDE range 80 to 120 for BUY/,
  );
});
