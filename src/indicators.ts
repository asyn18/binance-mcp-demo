import {
  decimalAbs,
  decimalAdd,
  decimalCompare,
  decimalDivide,
  decimalMax,
  decimalMultiply,
  decimalSubtract,
  decimalSum,
} from "./decimal.js";

export interface Candle {
  openTime: number;
  closeTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  quoteVolume: string;
  tradeCount: number;
  closed: boolean;
}

function average(values: string[]): string {
  return decimalDivide(decimalSum(values), String(values.length));
}

export function ema(values: string[], period: number): string | undefined {
  if (values.length < period) return undefined;
  let current = average(values.slice(0, period));
  for (const value of values.slice(period)) {
    current = decimalDivide(
      decimalAdd(decimalMultiply(value, "2"), decimalMultiply(current, String(period - 1))),
      String(period + 1),
    );
  }
  return current;
}

export function rsi(values: string[], period = 14): string | undefined {
  if (values.length <= period) return undefined;
  const gains: string[] = [];
  const losses: string[] = [];
  for (let index = 1; index <= period; index += 1) {
    const change = decimalSubtract(values[index]!, values[index - 1]!);
    gains.push(decimalCompare(change, "0") > 0 ? change : "0");
    losses.push(decimalCompare(change, "0") < 0 ? decimalAbs(change) : "0");
  }
  let averageGain = average(gains);
  let averageLoss = average(losses);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = decimalSubtract(values[index]!, values[index - 1]!);
    const gain = decimalCompare(change, "0") > 0 ? change : "0";
    const loss = decimalCompare(change, "0") < 0 ? decimalAbs(change) : "0";
    averageGain = decimalDivide(decimalAdd(decimalMultiply(averageGain, String(period - 1)), gain), String(period));
    averageLoss = decimalDivide(decimalAdd(decimalMultiply(averageLoss, String(period - 1)), loss), String(period));
  }
  if (decimalCompare(averageLoss, "0") === 0) return "100";
  const relativeStrength = decimalDivide(averageGain, averageLoss);
  return decimalSubtract("100", decimalDivide("100", decimalAdd("1", relativeStrength)));
}

export function atr(candles: Candle[], period = 14): string | undefined {
  if (candles.length <= period) return undefined;
  const ranges: string[] = [];
  for (let index = 1; index <= period; index += 1) {
    const candle = candles[index]!;
    const previousClose = candles[index - 1]!.close;
    ranges.push(decimalMax(
      decimalSubtract(candle.high, candle.low),
      decimalAbs(decimalSubtract(candle.high, previousClose)),
      decimalAbs(decimalSubtract(candle.low, previousClose)),
    ));
  }
  let current = average(ranges);
  for (let index = period + 1; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const previousClose = candles[index - 1]!.close;
    const range = decimalMax(
      decimalSubtract(candle.high, candle.low),
      decimalAbs(decimalSubtract(candle.high, previousClose)),
      decimalAbs(decimalSubtract(candle.low, previousClose)),
    );
    current = decimalDivide(decimalAdd(decimalMultiply(current, String(period - 1)), range), String(period));
  }
  return current;
}

export function previousBreakoutHigh(candles: Candle[], lookback = 20): string | undefined {
  if (candles.length < lookback + 1) return undefined;
  return decimalMax(...candles.slice(-(lookback + 1), -1).map((candle) => candle.high));
}

export function spreadPercent(bid: string, ask: string): string {
  return decimalMultiply(decimalDivide(decimalSubtract(ask, bid), decimalDivide(decimalAdd(ask, bid), "2")), "100");
}

export function positionSizeFromRisk(riskUsdt: string, entryPrice: string, stopPrice: string): string {
  const perUnitRisk = decimalAbs(decimalSubtract(entryPrice, stopPrice));
  if (decimalCompare(perUnitRisk, "0") === 0) throw new Error("Entry and stop price must differ.");
  return decimalDivide(riskUsdt, perUnitRisk);
}
