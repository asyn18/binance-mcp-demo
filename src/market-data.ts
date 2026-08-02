import type { BinanceClient } from "./binance-client.js";
import { decimalAdd, decimalDivide } from "./decimal.js";
import { atr, ema, previousBreakoutHigh, rsi, spreadPercent, type Candle } from "./indicators.js";

export const KLINE_INTERVALS = ["1m", "3m", "5m", "15m", "30m", "1h", "4h", "1d"] as const;
export type KlineInterval = typeof KLINE_INTERVALS[number];

export function parseKlines(data: unknown, now = Date.now()): Candle[] {
  if (!Array.isArray(data)) throw new Error("Unexpected Binance kline response.");
  return data.map((row) => {
    if (!Array.isArray(row) || row.length < 9) throw new Error("Unexpected Binance kline row.");
    const [openTime, open, high, low, close, volume, closeTime, quoteVolume, tradeCount] = row;
    if (typeof openTime !== "number" || typeof closeTime !== "number" || typeof open !== "string" || typeof high !== "string" || typeof low !== "string" || typeof close !== "string" || typeof volume !== "string" || typeof quoteVolume !== "string" || typeof tradeCount !== "number") throw new Error("Malformed Binance kline row.");
    return { openTime, closeTime, open, high, low, close, volume, quoteVolume, tradeCount, closed: closeTime < now };
  });
}

function intervalMs(interval: KlineInterval): number {
  return ({ "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 } as const)[interval];
}

export async function marketSnapshot(
  client: BinanceClient,
  symbol: string,
  entryInterval: KlineInterval,
  trendInterval: KlineInterval,
  now = Date.now(),
) {
  const [entryData, trendData, bookData, tickerData] = await Promise.all([
    client.publicGet("/api/v3/klines", { symbol, interval: entryInterval, limit: 120 }),
    client.publicGet("/api/v3/klines", { symbol, interval: trendInterval, limit: 120 }),
    client.publicGet("/api/v3/ticker/bookTicker", { symbol }),
    client.publicGet("/api/v3/ticker/24hr", { symbol }),
  ]);
  const entry = parseKlines(entryData, now).filter((candle) => candle.closed);
  const trend = parseKlines(trendData, now).filter((candle) => candle.closed);
  const book = bookData as { bidPrice?: unknown; askPrice?: unknown };
  const ticker = tickerData as { priceChangePercent?: unknown; quoteVolume?: unknown };
  if (typeof book.bidPrice !== "string" || typeof book.askPrice !== "string" || typeof ticker.priceChangePercent !== "string" || typeof ticker.quoteVolume !== "string") throw new Error("Unexpected Binance ticker response.");
  const latest = entry.at(-1);
  const entryEma20 = ema(entry.map((candle) => candle.close), 20);
  const trendEma20 = ema(trend.map((candle) => candle.close), 20);
  const trendEma50 = ema(trend.map((candle) => candle.close), 50);
  const rsi14 = rsi(entry.map((candle) => candle.close), 14);
  const atr14 = atr(entry, 14);
  const previous20 = entry.slice(-21, -1);
  const averageVolume = previous20.length ? decimalDivide(previous20.reduce((sum, candle) => decimalAdd(sum, candle.volume), "0"), String(previous20.length)) : undefined;
  const enoughData = Boolean(latest && entryEma20 && trendEma20 && trendEma50 && rsi14 && atr14 && previous20.length === 20 && averageVolume);
  return {
    symbol,
    entryInterval,
    trendInterval,
    lastCompletedClose: latest?.close,
    closeTime: latest?.closeTime,
    trendEma20,
    trendEma50,
    entryEma20,
    ema20Trend: trendEma20,
    ema50Trend: trendEma50,
    ema20Entry: entryEma20,
    rsi14,
    atr14,
    previous20High: previousBreakoutHigh(entry, 20),
    highestHighPrevious20: previousBreakoutHigh(entry, 20),
    latestVolume: latest?.volume,
    averageVolume,
    averagePrevious20Volume: averageVolume,
    volumeRatio: latest && averageVolume ? decimalDivide(latest.volume, averageVolume) : undefined,
    bestBid: book.bidPrice,
    bestAsk: book.askPrice,
    spreadPercentage: spreadPercent(book.bidPrice, book.askPrice),
    priceChangePercent24h: ticker.priceChangePercent,
    priceChangePercent: ticker.priceChangePercent,
    quoteVolume24h: ticker.quoteVolume,
    quoteVolume: ticker.quoteVolume,
    staleData: !latest || now - latest.closeTime > intervalMs(entryInterval) * 2,
    enoughData,
  };
}
