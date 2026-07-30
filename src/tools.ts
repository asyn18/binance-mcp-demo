import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BinanceClient } from "./binance-client.js";
import {
  maskCredential,
  type BinanceConfig,
} from "./config.js";
import { validateAndNormalizeOrder } from "./order-validation.js";
import { getSymbolRecord, simplifySymbolInfo } from "./symbol-info.js";

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
      },
    },
    async ({ symbol, side, type, quantity, price, timeInForce }) => {
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
        const orderParams = type === "LIMIT"
          ? {
              symbol,
              side,
              type,
              quantity: normalized.quantity,
              price: normalized.price!,
              timeInForce: timeInForce ?? "GTC",
            }
          : { symbol, side, type, quantity: normalized.quantity };
        return await safely(() => client.signedPost("/api/v3/order", orderParams));
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
}
