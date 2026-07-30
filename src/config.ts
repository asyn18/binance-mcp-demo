export type BinanceEnvironment = "demo" | "testnet" | "live";

export interface BinanceConfig {
  environment: BinanceEnvironment;
  baseUrl: string;
  apiKey?: string;
  apiSecret?: string;
  recvWindow: number;
  allowLiveTrading: boolean;
  logLevel: string;
}

export const BINANCE_BASE_URLS: Record<BinanceEnvironment, string> = {
  demo: "https://demo-api.binance.com",
  testnet: "https://testnet.binance.vision",
  live: "https://api.binance.com",
};

function parseEnvironment(value: string | undefined): BinanceEnvironment {
  const environment = value ?? "demo";
  if (environment !== "demo" && environment !== "testnet" && environment !== "live") {
    throw new Error(
      `Invalid BINANCE_ENV "${environment}". Expected demo, testnet, or live.`,
    );
  }
  return environment;
}

function parseRecvWindow(value: string | undefined): number {
  const recvWindow = Number(value ?? "10000");
  if (!Number.isInteger(recvWindow) || recvWindow <= 0 || recvWindow > 60000) {
    throw new Error("BINANCE_RECV_WINDOW must be an integer from 1 to 60000.");
  }
  return recvWindow;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): BinanceConfig {
  const environment = parseEnvironment(env.BINANCE_ENV);
  return {
    environment,
    baseUrl: BINANCE_BASE_URLS[environment],
    apiKey: env.BINANCE_API_KEY?.trim() || undefined,
    apiSecret: env.BINANCE_API_SECRET?.trim() || undefined,
    recvWindow: parseRecvWindow(env.BINANCE_RECV_WINDOW),
    allowLiveTrading:
      env.BINANCE_ALLOW_LIVE_TRADING?.trim().toLowerCase() === "true",
    logLevel: env.BINANCE_LOG_LEVEL?.trim() || "info",
  };
}

export function maskCredential(value: string | undefined): string {
  if (!value) return "(not set)";
  if (value.length <= 8) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(Math.min(12, value.length - 8))}${value.slice(-4)}`;
}
