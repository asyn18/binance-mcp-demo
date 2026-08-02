import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { BinanceClient } from "./binance-client.js";
import {
  maskCredential,
  type BinanceConfig,
} from "./config.js";
import { validateAndNormalizeOrder } from "./order-validation.js";
import { getSymbolRecord, simplifySymbolInfo } from "./symbol-info.js";
import { KLINE_INTERVALS, marketSnapshot, parseKlines } from "./market-data.js";
import { decimalAdd, decimalCompare, decimalDivide, decimalMultiply, decimalSum } from "./decimal.js";
import { placeOcoExit } from "./trading-actions.js";
import { TradingStore, type JournalRecord, type TradingState } from "./trading-store.js";

export function assertLiveTradingAllowed(config: BinanceConfig): void {
  if (config.environment === "live" && !config.allowLiveTrading) {
    throw new Error(
      "Live trading is disabled by the safety guard. Set BINANCE_ALLOW_LIVE_TRADING=true to enable live order actions.",
    );
  }
}

function result(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
    structuredContent: { error: message, code: "LOCAL_VALIDATION_OR_REQUEST" },
  };
}

async function safely(action: () => Promise<unknown>) {
  try {
    return result(await action());
  } catch (error) {
    return errorResult(error);
  }
}

const symbolSchema = z.string().trim().min(1).transform((value) => value.toUpperCase());

export function registerBinanceTools(
  server: McpServer,
  client: BinanceClient,
  config: BinanceConfig,
  store = new TradingStore(),
): void {
  server.registerTool(
    "binance_connection_info",
    { description: "Show the selected Binance environment and safe connection settings." },
    async () =>
      result({
        environment: config.environment,
        baseUrl: config.baseUrl,
        liveTrading: config.environment === "live" && config.allowLiveTrading,
        recvWindow: config.recvWindow,
        maskedApiKey: maskCredential(config.apiKey),
      }),
  );

  server.registerTool(
    "binance_server_time",
    { description: "Get Binance Spot server time." },
    async () => safely(() => client.publicGet("/api/v3/time")),
  );

  server.registerTool(
    "binance_price",
    {
      description: "Get the latest Binance Spot price for a symbol.",
      inputSchema: { symbol: symbolSchema.default("BTCUSDT") },
    },
    async ({ symbol }) =>
      safely(() => client.publicGet("/api/v3/ticker/price", { symbol })),
  );

  server.registerTool(
    "binance_order_book",
    {
      description: "Get a Binance Spot order book.",
      inputSchema: {
        symbol: symbolSchema.default("BTCUSDT"),
        limit: z.number().int().min(1).max(5000).default(20),
      },
    },
    async ({ symbol, limit }) =>
      safely(() => client.publicGet("/api/v3/depth", { symbol, limit })),
  );

  server.registerTool(
    "binance_symbol_info",
    {
      description: "Get simplified Binance Spot symbol trading rules and filters.",
      inputSchema: { symbol: symbolSchema.default("BTCUSDT") },
    },
    async ({ symbol }) =>
      safely(async () => {
        const exchangeInfo = await client.publicGet("/api/v3/exchangeInfo", { symbol });
        return simplifySymbolInfo(getSymbolRecord(exchangeInfo, symbol));
      }),
  );

  server.registerTool(
    "binance_klines",
    {
      description: "Get parsed Binance Spot candles; completed indicates whether the candle close time has passed.",
      inputSchema: {
        symbol: symbolSchema,
        interval: z.enum(KLINE_INTERVALS),
        limit: z.number().int().min(1).max(1000).default(100),
      },
    },
    async ({ symbol, interval, limit }) => safely(async () => parseKlines(await client.publicGet("/api/v3/klines", { symbol, interval, limit }))),
  );

  server.registerTool(
    "binance_ticker_24h",
    {
      description: "Get selected 24-hour Binance Spot ticker statistics.",
      inputSchema: { symbol: symbolSchema },
    },
    async ({ symbol }) => safely(async () => {
      const ticker = await client.publicGet("/api/v3/ticker/24hr", { symbol }) as Record<string, unknown>;
      return {
        priceChangePercent: ticker.priceChangePercent,
        weightedAvgPrice: ticker.weightedAvgPrice,
        lastPrice: ticker.lastPrice,
        volume: ticker.volume,
        quoteVolume: ticker.quoteVolume,
        bidPrice: ticker.bidPrice,
        askPrice: ticker.askPrice,
      };
    }),
  );

  server.registerTool(
    "binance_account",
    { description: "Get Binance Spot account information (signed)." },
    async () => safely(() => client.signedGet("/api/v3/account")),
  );

  server.registerTool(
    "binance_open_orders",
    {
      description: "Get all open Spot orders, optionally for one symbol (signed).",
      inputSchema: { symbol: symbolSchema.optional() },
    },
    async ({ symbol }) =>
      safely(() => client.signedGet("/api/v3/openOrders", { symbol })),
  );

  const historySchema = {
    symbol: symbolSchema,
    startTime: z.number().int().positive().optional(),
    endTime: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  };

  server.registerTool(
    "binance_all_orders",
    { description: "Get Spot order history for a symbol (signed).", inputSchema: historySchema },
    async ({ symbol, startTime, endTime, limit }) => safely(() => client.signedGet("/api/v3/allOrders", { symbol, startTime, endTime, limit })),
  );

  server.registerTool(
    "binance_my_trades",
    { description: "Get Spot trade fills for a symbol (signed).", inputSchema: historySchema },
    async ({ symbol, startTime, endTime, limit }) => safely(() => client.signedGet("/api/v3/myTrades", { symbol, startTime, endTime, limit })),
  );

  server.registerTool(
    "binance_order_list_status",
    {
      description: "Get a Spot order-list/OCO status (signed).",
      inputSchema: { orderListId: z.number().int().nonnegative().optional(), origClientOrderId: z.string().trim().min(1).optional() },
    },
    async ({ orderListId, origClientOrderId }) => {
      if (orderListId === undefined && origClientOrderId === undefined) return errorResult("Provide either orderListId or origClientOrderId.");
      return safely(() => client.signedGet("/api/v3/orderList", { orderListId, origClientOrderId }));
    },
  );

  const orderLookupSchema = {
    symbol: symbolSchema,
    orderId: z.number().int().positive().optional(),
    origClientOrderId: z.string().trim().min(1).optional(),
  };

  server.registerTool(
    "binance_order_status",
    {
      description: "Get the status of a Spot order (signed).",
      inputSchema: orderLookupSchema,
    },
    async ({ symbol, orderId, origClientOrderId }) => {
      if (orderId === undefined && origClientOrderId === undefined) {
        return errorResult("Provide either orderId or origClientOrderId.");
      }
      return safely(() =>
        client.signedGet("/api/v3/order", {
          symbol,
          orderId,
          origClientOrderId,
        }),
      );
    },
  );

  server.registerTool(
    "binance_place_order",
    {
      description: "Place a MARKET or LIMIT Binance Spot order (signed, guarded on live).",
      inputSchema: {
        symbol: symbolSchema,
        side: z.enum(["BUY", "SELL"]),
        type: z.enum(["MARKET", "LIMIT"]),
        quantity: z.string().trim().min(1),
        price: z.string().trim().min(1).optional(),
        timeInForce: z.enum(["GTC", "IOC", "FOK"]).optional(),
        newClientOrderId: z.string().trim().min(1).max(36).optional(),
        strategyId: z.string().trim().min(1).max(80).optional(),
        cycleId: z.string().trim().min(1).max(80).optional(),
      },
    },
    async ({ symbol, side, type, quantity, price, timeInForce, newClientOrderId, strategyId, cycleId }) => {
      try {
        assertLiveTradingAllowed(config);
        if (type === "LIMIT" && !price) {
          return errorResult("LIMIT orders require price.");
        }
        const exchangeInfo = await client.publicGet("/api/v3/exchangeInfo", { symbol });
        const symbolInfo = simplifySymbolInfo(getSymbolRecord(exchangeInfo, symbol));
        const ticker = type === "LIMIT" && symbolInfo.percentPriceBySide
          ? await client.publicGet("/api/v3/ticker/price", { symbol }) as { price?: unknown }
          : undefined;
        const tickerPrice = ticker?.price;
        const validatedTickerPrice = typeof tickerPrice === "string" ? tickerPrice : undefined;
        if (ticker && !validatedTickerPrice) {
          return errorResult("Binance ticker response did not include a valid price. No order was submitted.");
        }
        const normalized = validateAndNormalizeOrder(
          symbolInfo,
          { type, side, quantity, price },
          validatedTickerPrice,
        );
        const clientOrderId = newClientOrderId ?? (strategyId && cycleId ? deriveClientOrderId(strategyId, cycleId) : undefined);
        if (clientOrderId) store.claimClientOrderId(clientOrderId, strategyId, cycleId);
        const orderParams = type === "LIMIT"
          ? {
              symbol,
              side,
              type,
              quantity: normalized.quantity,
              price: normalized.price!,
              timeInForce: timeInForce ?? "GTC",
              newClientOrderId: clientOrderId,
            }
          : { symbol, side, type, quantity: normalized.quantity, newClientOrderId: clientOrderId };
        return await safely(async () => {
          const response = await client.signedPost("/api/v3/order", orderParams) as Record<string, unknown>;
          const fills = Array.isArray(response.fills) ? response.fills as Record<string, unknown>[] : [];
          const fillQty = decimalSum(fills.map((fill) => typeof fill.qty === "string" ? fill.qty : "0"));
          const fillQuote = decimalSum(fills.map((fill) => typeof fill.qty === "string" && typeof fill.price === "string" ? decimalMultiply(fill.qty, fill.price) : "0"));
          const executedQty = typeof response.executedQty === "string" ? response.executedQty : fillQty;
          const cummulativeQuoteQty = typeof response.cummulativeQuoteQty === "string" ? response.cummulativeQuoteQty : fillQuote;
          return {
            ...response,
            ...(decimalCompare(executedQty, "0") > 0 ? { effectiveAverageExecutionPrice: decimalDivide(cummulativeQuoteQty, executedQty) } : {}),
          };
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "binance_cancel_order",
    {
      description: "Cancel one Binance Spot order (signed, guarded on live).",
      inputSchema: orderLookupSchema,
    },
    async ({ symbol, orderId, origClientOrderId }) => {
      try {
        assertLiveTradingAllowed(config);
        if (orderId === undefined && origClientOrderId === undefined) {
          return errorResult("Provide either orderId or origClientOrderId.");
        }
        return await safely(() =>
          client.signedDelete("/api/v3/order", {
            symbol,
            orderId,
            origClientOrderId,
          }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "binance_cancel_all_orders",
    {
      description: "Cancel all open Spot orders for a symbol (signed, guarded on live).",
      inputSchema: { symbol: symbolSchema },
    },
    async ({ symbol }) => {
      try {
        assertLiveTradingAllowed(config);
        return await safely(() =>
          client.signedDelete("/api/v3/openOrders", { symbol }),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "binance_place_oco_exit",
    {
      description: "Place a protected Spot SELL OCO exit after a filled BUY.",
      inputSchema: {
        symbol: symbolSchema,
        quantity: z.string().trim().min(1),
        takeProfitPrice: z.string().trim().min(1),
        stopPrice: z.string().trim().min(1),
        stopLimitPrice: z.string().trim().min(1),
        listClientOrderId: z.string().trim().min(1).max(36).optional(),
      },
    },
    async (input) => {
      try {
        assertLiveTradingAllowed(config);
        if (input.listClientOrderId) store.claimClientOrderId(input.listClientOrderId);
        return await safely(() => placeOcoExit(client, input));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "binance_cancel_order_list",
    {
      description: "Cancel a Binance Spot OCO/order list (signed).",
      inputSchema: {
        symbol: symbolSchema,
        orderListId: z.number().int().nonnegative().optional(),
        listClientOrderId: z.string().trim().min(1).optional(),
      },
    },
    async ({ symbol, orderListId, listClientOrderId }) => {
      try {
        assertLiveTradingAllowed(config);
        if (orderListId === undefined && listClientOrderId === undefined) return errorResult("Provide either orderListId or listClientOrderId.");
        return await safely(() => client.signedDelete("/api/v3/orderList", { symbol, orderListId, listClientOrderId }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "binance_market_snapshot",
    {
      description: "Calculate a completed-candle Spot market snapshot with indicators.",
      inputSchema: {
        symbol: symbolSchema.default("BTCUSDT"),
        entryInterval: z.enum(KLINE_INTERVALS).default("15m"),
        trendInterval: z.enum(KLINE_INTERVALS).default("1h"),
      },
    },
    async ({ symbol, entryInterval, trendInterval }) => safely(() => marketSnapshot(client, symbol, entryInterval, trendInterval)),
  );

  server.registerTool(
    "trading_cycle_begin",
    { description: "Acquire an atomic, expiring autonomous strategy cycle lock.", inputSchema: { strategyId: z.string().trim().min(1), cycleId: z.string().trim().min(1) } },
    async ({ strategyId, cycleId }) => safely(async () => { store.beginCycle(strategyId, cycleId); return { strategyId, cycleId, locked: true, expiresAfterMinutes: 20 }; }),
  );

  server.registerTool(
    "trading_cycle_end",
    { description: "Release an autonomous strategy cycle lock.", inputSchema: { strategyId: z.string().trim().min(1), cycleId: z.string().trim().min(1), status: z.string().trim().min(1), summary: z.string() } },
    async ({ strategyId, cycleId, status, summary }) => safely(async () => { store.endCycle(strategyId, cycleId, status, summary); return { strategyId, cycleId, status, released: true }; }),
  );

  server.registerTool(
    "trading_state_get",
    { description: "Read persistent strategy state from SQLite.", inputSchema: { strategyId: z.string().trim().min(1) } },
    async ({ strategyId }) => result(store.getState(strategyId)),
  );

  const stateValue = z.union([z.string(), z.number().int(), z.enum(["NONE", "LONG"])]).nullable().optional();
  server.registerTool(
    "trading_state_update",
    {
      description: "Transactionally update validated persistent strategy state.",
      inputSchema: {
        strategyId: z.string().trim().min(1),
        currentPosition: z.enum(["NONE", "LONG"]).optional(),
        entryOrderId: stateValue,
        entryPrice: z.string().optional(), quantity: z.string().optional(), ocoOrderListId: stateValue,
        stopPrice: z.string().optional(), takeProfitPrice: z.string().optional(), initialRiskUsdt: z.string().optional(),
        entryTime: z.number().int().positive().optional(), lastExitTime: z.number().int().positive().optional(),
        dailyStartEquity: z.string().optional(), dailyRealizedPnl: z.string().optional(), consecutiveLosses: z.number().int().min(0).optional(),
        pausedUntil: z.number().int().positive().optional(), lastCycleId: stateValue,
      },
    },
    async ({ strategyId, ...updates }) => safely(async () => store.updateState(strategyId, updates as Partial<TradingState>)),
  );

  const journalSchema = {
    timestamp: z.number().int().positive().optional(), cycleId: z.string().trim().min(1), strategyId: z.string().trim().min(1),
    action: z.string().trim().min(1), symbol: symbolSchema, decision: z.string(), reason: z.string(),
    signalValues: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(), accountEquity: z.string().optional(),
    quantity: z.string().optional(), entryPrice: z.string().optional(), stopPrice: z.string().optional(), targetPrice: z.string().optional(),
    orderIds: z.record(z.union([z.string(), z.number().int()])).optional(), fees: z.string().optional(), realizedPnl: z.string().optional(), realizedR: z.string().optional(), error: z.string().optional(),
  };
  server.registerTool(
    "trading_journal_append",
    { description: "Append one structured autonomous-trading journal event to SQLite.", inputSchema: journalSchema },
    async (record) => safely(async () => ({ journalId: store.appendJournal(record as JournalRecord) })),
  );
  server.registerTool(
    "trading_journal_recent",
    { description: "Read recent structured strategy journal events.", inputSchema: { strategyId: z.string().trim().min(1), limit: z.number().int().min(1).max(500).default(50) } },
    async ({ strategyId, limit }) => result(store.recentJournal(strategyId, limit)),
  );
  server.registerTool(
    "trading_performance_summary",
    { description: "Summarize realized strategy performance from the SQLite journal.", inputSchema: { strategyId: z.string().trim().min(1), startTime: z.number().int().positive().optional(), endTime: z.number().int().positive().optional() } },
    async ({ strategyId, startTime, endTime }) => result(store.performanceSummary(strategyId, startTime, endTime)),
  );

  server.registerTool(
    "binance_portfolio_summary",
    { description: "Summarize non-dust Spot balances, equity, open BTCUSDT orders, and OCO protection.", inputSchema: {} },
    async () => safely(async () => {
      const [accountData, tickerData, ordersData, listsData, allPricesData] = await Promise.all([
        client.signedGet("/api/v3/account"),
        client.publicGet("/api/v3/ticker/price", { symbol: "BTCUSDT" }),
        client.signedGet("/api/v3/openOrders", { symbol: "BTCUSDT" }),
        client.signedGet("/api/v3/openOrderList"),
        client.publicGet("/api/v3/ticker/price"),
      ]);
      const balances = (accountData as { balances?: unknown }).balances;
      const nonzero = Array.isArray(balances) ? balances.filter((balance) => {
        if (typeof balance !== "object" || balance === null) return false;
        const row = balance as { free?: unknown; locked?: unknown };
        return typeof row.free === "string" && typeof row.locked === "string" && decimalCompare(decimalAdd(row.free, row.locked), "0.00000001") >= 0;
      }) : [];
      const btc = nonzero.find((balance) => (balance as { asset?: unknown }).asset === "BTC") as { free: string; locked: string } | undefined;
      const usdt = nonzero.find((balance) => (balance as { asset?: unknown }).asset === "USDT") as { free: string; locked: string } | undefined;
      const ticker = tickerData as { price?: unknown };
      const btcTotal = btc ? decimalAdd(btc.free, btc.locked) : "0";
      const usdtTotal = usdt ? decimalAdd(usdt.free, usdt.locked) : "0";
      const allPrices = Array.isArray(allPricesData) ? allPricesData : [];
      const priceMap = new Map(allPrices.flatMap((row) => {
        if (typeof row !== "object" || row === null) return [];
        const item = row as { symbol?: unknown; price?: unknown };
        return typeof item.symbol === "string" && typeof item.price === "string" ? [[item.symbol, item.price] as const] : [];
      }));
      const equity = nonzero.reduce((total, balance) => {
        const row = balance as { asset: string; free: string; locked: string };
        const totalAsset = decimalAdd(row.free, row.locked);
        if (row.asset === "USDT") return decimalAdd(total, totalAsset);
        const conversion = priceMap.get(`${row.asset}USDT`);
        return conversion ? decimalAdd(total, decimalMultiply(totalAsset, conversion)) : total;
      }, "0");
      const orderLists = Array.isArray(listsData) ? listsData : [];
      const btcPositionActive = decimalCompare(btcTotal, "0.000001") >= 0;
      return { balances: nonzero, btc: btc ?? { free: "0", locked: "0" }, usdt: usdt ?? { free: "0", locked: "0" }, btcPositionActive, estimatedTotalEquityUsdt: equity, openBtcusdtOrders: ordersData, btcExposureProtectedByOpenOco: btcPositionActive && orderLists.some((list) => typeof list === "object" && list !== null && (list as { symbol?: unknown }).symbol === "BTCUSDT") };
    }),
  );
}

function deriveClientOrderId(strategyId: string, cycleId: string): string {
  return `mcp_${createHash("sha256").update(`${strategyId}:${cycleId}`).digest("hex").slice(0, 28)}`;
}
