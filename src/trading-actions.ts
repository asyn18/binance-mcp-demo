import type { BinanceClient } from "./binance-client.js";
import { decimalCompare } from "./decimal.js";
import { validateMaximumNotional, validateMinimumNotional, validatePercentPriceBySide, validatePrice, validateQuantity } from "./order-validation.js";
import { getSymbolRecord, simplifySymbolInfo } from "./symbol-info.js";
import type { JournalRecord, TradingStore } from "./trading-store.js";

export interface OcoExitInput {
  symbol: string;
  quantity: string;
  takeProfitPrice: string;
  stopPrice: string;
  stopLimitPrice: string;
  listClientOrderId?: string;
}

export async function placeOcoExit(client: BinanceClient, input: OcoExitInput) {
  const [exchangeInfo, tickerData, accountData] = await Promise.all([
    client.publicGet("/api/v3/exchangeInfo", { symbol: input.symbol }),
    client.publicGet("/api/v3/ticker/price", { symbol: input.symbol }),
    client.signedGet("/api/v3/account"),
  ]);
  const info = simplifySymbolInfo(getSymbolRecord(exchangeInfo, input.symbol));
  const ticker = tickerData as { price?: unknown };
  if (typeof ticker.price !== "string") throw new Error("Binance ticker response did not include a valid price.");
  if (!info.priceFilter || !info.lotSize) throw new Error(`Symbol ${input.symbol} lacks a required price or lot-size filter.`);
  const quantity = validateQuantity(input.quantity, info.lotSize);
  const takeProfitPrice = validatePrice(input.takeProfitPrice, info.priceFilter);
  const stopPrice = validatePrice(input.stopPrice, info.priceFilter);
  const stopLimitPrice = validatePrice(input.stopLimitPrice, info.priceFilter);
  if (decimalCompare(takeProfitPrice, ticker.price) <= 0) throw new Error(`takeProfitPrice must be above current market price ${ticker.price}. Normalized takeProfitPrice: ${takeProfitPrice}.`);
  if (decimalCompare(ticker.price, stopPrice) <= 0) throw new Error(`stopPrice must be below current market price ${ticker.price}. Normalized stopPrice: ${stopPrice}.`);
  if (decimalCompare(stopLimitPrice, stopPrice) > 0) throw new Error(`stopLimitPrice must be less than or equal to stopPrice. Normalized values: stopLimitPrice ${stopLimitPrice}, stopPrice ${stopPrice}.`);
  if (info.notional) {
    validateMinimumNotional(takeProfitPrice, quantity, info.notional.minNotional);
    validateMinimumNotional(stopLimitPrice, quantity, info.notional.minNotional);
    if (info.notional.maxNotional) {
      validateMaximumNotional(takeProfitPrice, quantity, info.notional.maxNotional);
      validateMaximumNotional(stopLimitPrice, quantity, info.notional.maxNotional);
    }
  }
  if (info.percentPriceBySide) {
    validatePercentPriceBySide("SELL", takeProfitPrice, ticker.price, info.percentPriceBySide);
    validatePercentPriceBySide("SELL", stopLimitPrice, ticker.price, info.percentPriceBySide);
  }
  const balances = (accountData as { balances?: unknown }).balances;
  const baseBalance = Array.isArray(balances)
    ? balances.find((balance): balance is { asset: string; free: string } => typeof balance === "object" && balance !== null && (balance as { asset?: unknown }).asset === info.baseAsset && typeof (balance as { free?: unknown }).free === "string")
    : undefined;
  if (!baseBalance || decimalCompare(baseBalance.free, quantity) < 0) {
    throw new Error(`Insufficient free ${info.baseAsset} for OCO quantity ${quantity}. Available free balance: ${baseBalance?.free ?? "0"}.`);
  }
  const response = await client.signedPost("/api/v3/orderList/oco", {
    symbol: input.symbol,
    side: "SELL",
    quantity,
    aboveType: "LIMIT_MAKER",
    abovePrice: takeProfitPrice,
    belowType: "STOP_LOSS_LIMIT",
    belowStopPrice: stopPrice,
    belowPrice: stopLimitPrice,
    belowTimeInForce: "GTC",
    listClientOrderId: input.listClientOrderId,
  }) as { orderListId?: number; orders?: { orderId?: number }[] };
  return {
    orderListId: response.orderListId,
    orderIds: response.orders?.map((order) => order.orderId).filter((id): id is number => typeof id === "number") ?? [],
    quantity,
    takeProfitPrice,
    stopPrice,
    stopLimitPrice,
  };
}

/**
 * Used by autonomous BUY workflows: if protective OCO placement fails, close
 * the newly filled Spot position immediately and journal the emergency action.
 */
export async function protectFilledBuyOrEmergencyExit(
  client: BinanceClient,
  store: TradingStore,
  oco: OcoExitInput,
  journal: Omit<JournalRecord, "action" | "error">,
) {
  try {
    return { protected: true, oco: await placeOcoExit(client, oco) };
  } catch (ocoError) {
    const errorMessage = ocoError instanceof Error ? ocoError.message : String(ocoError);
    try {
      const emergency = await client.signedPost("/api/v3/order", {
        symbol: oco.symbol,
        side: "SELL",
        type: "MARKET",
        quantity: oco.quantity,
      }) as { orderId?: number; fills?: unknown[]; executedQty?: string };
      store.appendJournal({
        ...journal,
        action: "EMERGENCY_EXIT",
        decision: "MARKET_SELL_AFTER_OCO_FAILURE",
        reason: "OCO protection failed after a BUY fill",
        quantity: emergency.executedQty ?? oco.quantity,
        orderIds: { ...(journal.orderIds ?? {}), emergencyOrderId: emergency.orderId ?? "unknown" },
        error: errorMessage,
      });
      return { protected: false, emergencyExit: emergency, ocoError: errorMessage };
    } catch (emergencyError) {
      const emergencyMessage = emergencyError instanceof Error ? emergencyError.message : String(emergencyError);
      store.appendJournal({ ...journal, action: "EMERGENCY_EXIT_FAILED", error: `${errorMessage}; emergency close failed: ${emergencyMessage}` });
      throw new Error(`OCO protection failed and the emergency MARKET SELL also failed. Manual intervention required: ${emergencyMessage}`);
    }
  }
}
