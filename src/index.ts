import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BinanceClient } from "./binance-client.js";
import { loadConfig } from "./config.js";
import { registerBinanceTools } from "./tools.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = new McpServer({
    name: "binance-mcp-demo",
    version: "1.0.0",
  });
  registerBinanceTools(server, new BinanceClient(config), config);
  await server.connect(new StdioServerTransport());
  await new Promise<void>((resolve) => process.stdin.once("end", resolve));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Binance MCP server failed: ${message}`);
  process.exitCode = 1;
});
