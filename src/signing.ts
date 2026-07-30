import { createHmac } from "node:crypto";

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue>;

export function createQueryString(params: QueryParams = {}): string {
  return Object.entries(params)
    .filter((entry): entry is [string, Exclude<QueryValue, undefined | null>] =>
      entry[1] !== undefined && entry[1] !== null,
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
}

export function signQueryString(
  queryString: string,
  apiSecret: string,
): string {
  return createHmac("sha256", apiSecret).update(queryString).digest("hex");
}
