import "dotenv/config";
import { BinanceApiError, BinanceClient } from "./binance-client.js";
import { loadConfig, maskCredential } from "./config.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new BinanceClient(config);

  console.log(`Environment: ${config.environment}`);
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`API key: ${maskCredential(config.apiKey)}`);

  try {
    const before = Date.now();
    const time = (await client.publicGet("/api/v3/time")) as {
      serverTime: number;
    };
    const after = Date.now();
    const localTime = Math.round((before + after) / 2);
    console.log(`Server time result: ${JSON.stringify(time)}`);
    console.log(`Local/server time difference: ${localTime - time.serverTime} ms`);
  } catch (error) {
    printError("Server time", error);
  }

  try {
    await client.signedGet("/api/v3/account");
    console.log("Account endpoint result status: success");
    process.exitCode = 0;
  } catch (error) {
    console.log("Account endpoint result status: failed");
    printError("Account endpoint", error);
    process.exitCode = 1;
  }
}

function printError(label: string, error: unknown): void {
  if (error instanceof BinanceApiError) {
    console.error(
      `${label} error: HTTP ${error.status}, Binance code ${error.code ?? "(none)"}, message: ${error.message}`,
    );
    return;
  }
  console.error(
    `${label} error: ${error instanceof Error ? error.message : String(error)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
