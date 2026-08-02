import type { BinanceConfig } from "./config.js";
import {
  createQueryString,
  signQueryString,
  type QueryParams,
} from "./signing.js";

export class BinanceApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "BinanceApiError";
  }
}

export class BinanceClient {
  constructor(
    private readonly config: BinanceConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  createQueryString(params: QueryParams = {}): string {
    return createQueryString(params);
  }

  signQueryString(queryString: string): string {
    const secret = this.requireCredentials().apiSecret;
    return signQueryString(queryString, secret);
  }

  publicGet(path: string, params: QueryParams = {}): Promise<unknown> {
    return this.request("GET", path, params, false);
  }

  signedGet(path: string, params: QueryParams = {}): Promise<unknown> {
    return this.request("GET", path, params, true);
  }

  signedPost(path: string, params: QueryParams = {}): Promise<unknown> {
    return this.request("POST", path, params, true);
  }

  signedDelete(path: string, params: QueryParams = {}): Promise<unknown> {
    return this.request("DELETE", path, params, true);
  }

  private requireCredentials(): { apiKey: string; apiSecret: string } {
    if (!this.config.apiKey || !this.config.apiSecret) {
      throw new Error(
        "Binance credentials are required. Set BINANCE_API_KEY and BINANCE_API_SECRET.",
      );
    }
    return {
      apiKey: this.config.apiKey,
      apiSecret: this.config.apiSecret,
    };
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: QueryParams,
    signed: boolean,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: "application/json" };
    let finalParams = params;

    if (signed) {
      const { apiKey, apiSecret } = this.requireCredentials();
      finalParams = {
        ...params,
        recvWindow: this.config.recvWindow,
        timestamp: Date.now(),
      };
      const unsignedQuery = createQueryString(finalParams);
      finalParams = {
        ...finalParams,
        signature: signQueryString(unsignedQuery, apiSecret),
      };
      headers["X-MBX-APIKEY"] = apiKey;
    }

    const query = createQueryString(finalParams);
    const url = `${this.config.baseUrl}${path}${query ? `?${query}` : ""}`;
    const attempts = method === "GET" ? 3 : 1;
    let response: Response | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        response = await this.fetchImpl(url, { method, headers, signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        if (attempt === attempts - 1) throw error;
        await delay(250 * (attempt + 1));
        continue;
      }
      if (response.status !== 429 || attempt === attempts - 1) break;
      const retryAfter = response.headers.get("retry-after");
      const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Math.min(Number(retryAfter), 3) : 1;
      await delay(seconds * 1000);
    }
    if (!response) throw new Error("Binance request did not receive a response.");
    const body = await response.json().catch(() => undefined) as
      | { code?: number; msg?: string }
      | undefined;

    if (!response.ok) {
      throw new BinanceApiError(
        body?.msg ?? `Binance request failed with HTTP ${response.status}`,
        response.status,
        body?.code,
      );
    }
    return body;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
