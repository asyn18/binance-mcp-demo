import assert from "node:assert/strict";
import test from "node:test";
import { createQueryString, signQueryString } from "../src/signing.js";

test("HMAC SHA256 signing matches a known vector", () => {
  assert.equal(
    signQueryString("symbol=LTCBTC&side=BUY&type=LIMIT", "test-secret"),
    "d1b2728ee71c9a486a41f9692caab29582dc8c4566c2b13e96bee1898f4f7a4a",
  );
});

test("query strings are sorted, encoded, and omit nullish values", () => {
  assert.equal(
    createQueryString({
      symbol: "BTC/USDT",
      note: "buy now",
      limit: 20,
      ignored: undefined,
      alsoIgnored: null,
    }),
    "limit=20&note=buy%20now&symbol=BTC%2FUSDT",
  );
});
