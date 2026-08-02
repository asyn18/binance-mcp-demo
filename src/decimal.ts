/** Exact base-10 arithmetic for monetary values. No JavaScript Number math. */
export interface DecimalValue {
  coefficient: bigint;
  scale: number;
}

export function parseDecimal(value: string): DecimalValue {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`Invalid decimal value "${value}".`);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  return {
    coefficient: (negative ? -1n : 1n) * BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function toScale(value: DecimalValue, scale: number): bigint {
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

export function decimalString(value: DecimalValue): string {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient).toString().padStart(value.scale + 1, "0");
  if (value.scale === 0) return `${negative ? "-" : ""}${digits}`;
  const fraction = digits.slice(-value.scale).replace(/0+$/, "");
  const whole = digits.slice(0, -value.scale);
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function decimalCompare(left: string, right: string): number {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const av = toScale(a, scale);
  const bv = toScale(b, scale);
  return av === bv ? 0 : av < bv ? -1 : 1;
}

export function decimalAdd(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return decimalString({ coefficient: toScale(a, scale) + toScale(b, scale), scale });
}

export function decimalSubtract(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return decimalString({ coefficient: toScale(a, scale) - toScale(b, scale), scale });
}

export function decimalMultiply(left: string, right: string): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return decimalString({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
}

export function decimalDivide(left: string, right: string, precision = 18): string {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  if (b.coefficient === 0n) throw new Error("Decimal division by zero.");
  const numerator = a.coefficient * 10n ** BigInt(precision + b.scale);
  const denominator = b.coefficient * 10n ** BigInt(a.scale);
  return decimalString({ coefficient: numerator / denominator, scale: precision });
}

export function decimalAbs(value: string): string {
  const parsed = parseDecimal(value);
  return decimalString({ ...parsed, coefficient: parsed.coefficient < 0n ? -parsed.coefficient : parsed.coefficient });
}

export function decimalMax(...values: string[]): string {
  if (!values.length) throw new Error("decimalMax needs at least one value.");
  return values.reduce((maximum, value) => decimalCompare(value, maximum) > 0 ? value : maximum);
}

export function decimalMin(...values: string[]): string {
  if (!values.length) throw new Error("decimalMin needs at least one value.");
  return values.reduce((minimum, value) => decimalCompare(value, minimum) < 0 ? value : minimum);
}

export function decimalSum(values: string[]): string {
  return values.reduce((sum, value) => decimalAdd(sum, value), "0");
}
