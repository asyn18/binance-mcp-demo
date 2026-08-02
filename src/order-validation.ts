import type {
  LotSizeFilter,
  PercentPriceBySideFilter,
  PriceFilter,
  SimplifiedSymbolInfo,
} from "./symbol-info.js";

interface Decimal {
  coefficient: bigint;
  scale: number;
}

export interface NormalizedOrder {
  price?: string;
  quantity: string;
}

function decimal(value: string): Decimal {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`Invalid decimal value "${value}".`);
  }
  const [whole, fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function scale(value: Decimal, targetScale: number): bigint {
  return value.coefficient * 10n ** BigInt(targetScale - value.scale);
}

function compare(left: Decimal, right: Decimal): number {
  const targetScale = Math.max(left.scale, right.scale);
  const leftValue = scale(left, targetScale);
  const rightValue = scale(right, targetScale);
  return leftValue === rightValue ? 0 : leftValue < rightValue ? -1 : 1;
}

function multiply(left: Decimal, right: Decimal): Decimal {
  return { coefficient: left.coefficient * right.coefficient, scale: left.scale + right.scale };
}

function display(value: Decimal): string {
  const digits = value.coefficient.toString().padStart(value.scale + 1, "0");
  if (value.scale === 0) return digits;
  const whole = digits.slice(0, -value.scale);
  const fraction = digits.slice(-value.scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function isEnabled(value: string): boolean {
  return decimal(value).coefficient !== 0n;
}

export function normalizeToStep(value: string, minimum: string, step: string): string {
  const parsedValue = decimal(value);
  const parsedMinimum = decimal(minimum);
  const parsedStep = decimal(step);
  if (parsedStep.coefficient === 0n) return display(parsedValue);

  const targetScale = Math.max(parsedValue.scale, parsedMinimum.scale, parsedStep.scale);
  const valueInt = scale(parsedValue, targetScale);
  const minInt = scale(parsedMinimum, targetScale);
  const stepInt = scale(parsedStep, targetScale);
  const normalizedInt = valueInt < minInt
    ? minInt
    : minInt + ((valueInt - minInt) / stepInt) * stepInt;
  return display({ coefficient: normalizedInt, scale: targetScale });
}

function validateRange(
  label: "Price" | "Quantity",
  submitted: string,
  filter: { minimum: string; maximum: string; step: string; stepName: "tickSize" | "stepSize" },
): string {
  const { minimum, maximum, step, stepName } = filter;
  const submittedDecimal = decimal(submitted);
  const normalized = normalizeToStep(submitted, minimum, step);

  if (isEnabled(minimum) && compare(submittedDecimal, decimal(minimum)) < 0) {
    throw new Error(
      `${label} ${submitted} is below the permitted range ${minimum} to ${maximum}. Normalized value: ${normalized}. No order was submitted.`,
    );
  }
  if (isEnabled(maximum) && compare(submittedDecimal, decimal(maximum)) > 0) {
    throw new Error(
      `${label} ${submitted} is above the permitted range ${minimum} to ${maximum}. Normalized value: ${normalized}. No order was submitted.`,
    );
  }
  if (compare(submittedDecimal, decimal(normalized)) !== 0) {
    throw new Error(
      `${label} ${submitted} is not aligned to ${stepName} ${step}. Permitted range: ${minimum} to ${maximum}. Normalized value: ${normalized}. Adjust it explicitly; no order was submitted.`,
    );
  }
  return normalized;
}

export function validatePrice(price: string, filter: PriceFilter): string {
  return validateRange("Price", price, {
    minimum: filter.minPrice,
    maximum: filter.maxPrice,
    step: filter.tickSize,
    stepName: "tickSize",
  });
}

export function validateQuantity(quantity: string, filter: LotSizeFilter): string {
  return validateRange("Quantity", quantity, {
    minimum: filter.minQty,
    maximum: filter.maxQty,
    step: filter.stepSize,
    stepName: "stepSize",
  });
}

export function validateMinimumNotional(
  price: string,
  quantity: string,
  minNotional: string,
): void {
  const notional = multiply(decimal(price), decimal(quantity));
  if (compare(notional, decimal(minNotional)) < 0) {
    throw new Error(
      `Order notional ${display(notional)} is below the minimum notional ${minNotional}. Normalized price: ${display(decimal(price))}; normalized quantity: ${display(decimal(quantity))}. No order was submitted.`,
    );
  }
}

export function validateMaximumNotional(
  price: string,
  quantity: string,
  maxNotional: string,
): void {
  const notional = multiply(decimal(price), decimal(quantity));
  if (compare(notional, decimal(maxNotional)) > 0) {
    throw new Error(
      `Order notional ${display(notional)} is above the maximum notional ${maxNotional}. Normalized price: ${display(decimal(price))}; normalized quantity: ${display(decimal(quantity))}. No order was submitted.`,
    );
  }
}

export function validatePercentPriceBySide(
  side: "BUY" | "SELL",
  orderPrice: string,
  tickerPrice: string,
  filter: PercentPriceBySideFilter,
): void {
  const lowerMultiplier = side === "BUY" ? filter.bidMultiplierDown : filter.askMultiplierDown;
  const upperMultiplier = side === "BUY" ? filter.bidMultiplierUp : filter.askMultiplierUp;
  const ticker = decimal(tickerPrice);
  const lower = multiply(ticker, decimal(lowerMultiplier));
  const upper = multiply(ticker, decimal(upperMultiplier));
  const price = decimal(orderPrice);
  if (compare(price, lower) < 0 || compare(price, upper) > 0) {
    throw new Error(
      `Price ${orderPrice} is outside the PERCENT_PRICE_BY_SIDE range ${display(lower)} to ${display(upper)} for ${side} (current ticker ${tickerPrice}). Normalized price: ${display(price)}. No order was submitted.`,
    );
  }
}

export function validateAndNormalizeOrder(
  info: SimplifiedSymbolInfo,
  input: { type: "MARKET" | "LIMIT"; side: "BUY" | "SELL"; quantity: string; price?: string },
  tickerPrice?: string,
): NormalizedOrder {
  if (info.status !== "TRADING") {
    throw new Error(`Symbol ${info.symbol} is not tradable (status: ${info.status}). No order was submitted.`);
  }
  if (!info.allowedOrderTypes.includes(input.type)) {
    throw new Error(`Symbol ${info.symbol} does not permit ${input.type} orders. No order was submitted.`);
  }
  if (!info.lotSize) throw new Error(`Symbol ${info.symbol} has no LOT_SIZE filter. No order was submitted.`);

  const quantity = validateQuantity(input.quantity, info.lotSize);
  if (input.type === "MARKET" && info.marketLotSize) {
    validateQuantity(quantity, info.marketLotSize);
  }
  if (input.type === "MARKET") return { quantity };

  if (!input.price) throw new Error("LIMIT orders require price.");
  if (!info.priceFilter) throw new Error(`Symbol ${info.symbol} has no PRICE_FILTER. No order was submitted.`);
  const price = validatePrice(input.price, info.priceFilter);
  if (info.notional) {
    validateMinimumNotional(price, quantity, info.notional.minNotional);
    if (info.notional.maxNotional) validateMaximumNotional(price, quantity, info.notional.maxNotional);
  }
  if (info.percentPriceBySide) {
    if (!tickerPrice) throw new Error("Current ticker price is required for PERCENT_PRICE_BY_SIDE validation.");
    validatePercentPriceBySide(input.side, price, tickerPrice, info.percentPriceBySide);
  }
  return { price, quantity };
}
