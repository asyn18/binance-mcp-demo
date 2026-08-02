export interface BinanceFilter {
  filterType: string;
  [key: string]: unknown;
}

export interface BinanceSymbolRecord {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  orderTypes: string[];
  filters: BinanceFilter[];
}

export interface BinanceExchangeInfo {
  symbols?: BinanceSymbolRecord[];
}

export interface PriceFilter {
  minPrice: string;
  maxPrice: string;
  tickSize: string;
}

export interface LotSizeFilter {
  minQty: string;
  maxQty: string;
  stepSize: string;
}

export interface NotionalFilter {
  filterType: "MIN_NOTIONAL" | "NOTIONAL";
  minNotional: string;
  maxNotional?: string;
  applyToMarket?: boolean;
  avgPriceMins?: number;
}

export interface PercentPriceBySideFilter {
  bidMultiplierUp: string;
  bidMultiplierDown: string;
  askMultiplierUp: string;
  askMultiplierDown: string;
  avgPriceMins?: number;
}

export interface SimplifiedSymbolInfo {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  allowedOrderTypes: string[];
  priceFilter?: PriceFilter;
  lotSize?: LotSizeFilter;
  marketLotSize?: LotSizeFilter;
  notional?: NotionalFilter;
  percentPriceBySide?: PercentPriceBySideFilter;
  /** Binance filter names are also exposed verbatim for MCP consumers. */
  PRICE_FILTER?: PriceFilter;
  LOT_SIZE?: LotSizeFilter;
  MARKET_LOT_SIZE?: LotSizeFilter;
  MIN_NOTIONAL?: NotionalFilter;
  NOTIONAL?: NotionalFilter;
  PERCENT_PRICE_BY_SIDE?: PercentPriceBySideFilter;
}

function stringField(filter: BinanceFilter, field: string): string {
  const value = filter[field];
  if (typeof value !== "string") {
    throw new Error(`Binance ${filter.filterType} filter is missing ${field}.`);
  }
  return value;
}

function optionalNumberField(filter: BinanceFilter, field: string): number | undefined {
  const value = filter[field];
  return typeof value === "number" ? value : undefined;
}

function optionalBooleanField(filter: BinanceFilter, field: string): boolean | undefined {
  const value = filter[field];
  return typeof value === "boolean" ? value : undefined;
}

function asLotSize(filter: BinanceFilter): LotSizeFilter {
  return {
    minQty: stringField(filter, "minQty"),
    maxQty: stringField(filter, "maxQty"),
    stepSize: stringField(filter, "stepSize"),
  };
}

export function getSymbolRecord(
  exchangeInfo: unknown,
  requestedSymbol: string,
): BinanceSymbolRecord {
  const symbols = (exchangeInfo as BinanceExchangeInfo).symbols;
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error(`Binance exchangeInfo returned no symbol data for ${requestedSymbol}.`);
  }
  const record = symbols.find((symbol) => symbol.symbol === requestedSymbol);
  if (!record) {
    throw new Error(`Binance exchangeInfo did not include ${requestedSymbol}.`);
  }
  return record;
}

export function simplifySymbolInfo(record: BinanceSymbolRecord): SimplifiedSymbolInfo {
  const filters = new Map(record.filters.map((filter) => [filter.filterType, filter]));
  const price = filters.get("PRICE_FILTER");
  const lotSize = filters.get("LOT_SIZE");
  const marketLotSize = filters.get("MARKET_LOT_SIZE");
  const minNotional = filters.get("MIN_NOTIONAL");
  const notional = filters.get("NOTIONAL");
  const percentPriceBySide = filters.get("PERCENT_PRICE_BY_SIDE");
  const simplifiedNotional = minNotional || notional
    ? {
        filterType: (minNotional ? "MIN_NOTIONAL" : "NOTIONAL") as "MIN_NOTIONAL" | "NOTIONAL",
        minNotional: stringField(minNotional ?? notional!, "minNotional"),
        ...(notional && typeof notional.maxNotional === "string"
          ? { maxNotional: notional.maxNotional }
          : {}),
        applyToMarket: optionalBooleanField(minNotional ?? notional!, "applyToMarket"),
        avgPriceMins: optionalNumberField(minNotional ?? notional!, "avgPriceMins"),
      }
    : undefined;
  const simplifiedPrice = price
    ? { minPrice: stringField(price, "minPrice"), maxPrice: stringField(price, "maxPrice"), tickSize: stringField(price, "tickSize") }
    : undefined;
  const simplifiedLot = lotSize ? asLotSize(lotSize) : undefined;
  const simplifiedMarketLot = marketLotSize ? asLotSize(marketLotSize) : undefined;
  const simplifiedPercent = percentPriceBySide
    ? {
        bidMultiplierUp: stringField(percentPriceBySide, "bidMultiplierUp"),
        bidMultiplierDown: stringField(percentPriceBySide, "bidMultiplierDown"),
        askMultiplierUp: stringField(percentPriceBySide, "askMultiplierUp"),
        askMultiplierDown: stringField(percentPriceBySide, "askMultiplierDown"),
        avgPriceMins: optionalNumberField(percentPriceBySide, "avgPriceMins"),
      }
    : undefined;

  return {
    symbol: record.symbol,
    status: record.status,
    baseAsset: record.baseAsset,
    quoteAsset: record.quoteAsset,
    allowedOrderTypes: record.orderTypes,
    priceFilter: simplifiedPrice,
    lotSize: simplifiedLot,
    marketLotSize: simplifiedMarketLot,
    notional: simplifiedNotional,
    percentPriceBySide: simplifiedPercent,
    PRICE_FILTER: simplifiedPrice,
    LOT_SIZE: simplifiedLot,
    MARKET_LOT_SIZE: simplifiedMarketLot,
    ...(simplifiedNotional?.filterType === "MIN_NOTIONAL" ? { MIN_NOTIONAL: simplifiedNotional } : {}),
    ...(simplifiedNotional?.filterType === "NOTIONAL" ? { NOTIONAL: simplifiedNotional } : {}),
    PERCENT_PRICE_BY_SIDE: simplifiedPercent,
  };
}
