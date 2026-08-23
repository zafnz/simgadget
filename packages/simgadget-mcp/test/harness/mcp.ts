/**
 * A real MCP client and server, linked in memory, so a tool can be driven the
 * way an agent drives it.
 *
 * ## Why this is a `.ts` file when every test is `.mts`
 *
 * The MCP SDK ships **two** builds with two sets of declarations, `dist/esm`
 * and `dist/cjs`, and its `McpServer` has private fields — so the ESM class and
 * the CJS class are two nominally different types that cannot be passed for
 * one another. This package has no `"type": "module"`, which makes every file
 * in `src/` CommonJS as far as TypeScript is concerned, so `src/tools.ts`
 * resolves the *CJS* declarations. A `.mts` test is always ESM and resolves the
 * *ESM* ones, and handing one's `McpServer` to the other's `registerTools` is a
 * type error about a private `_serverInfo` that looks like a bug in the SDK and
 * is not.
 *
 * Everything touching the SDK therefore lives here, in a `.ts` file that
 * resolves it exactly as `src/` does — the same trick `fakes/simulator.ts`
 * already relies on for `simgadget`, which avoids the problem by shipping one
 * set of declarations for both conditions. Nothing SDK-typed crosses back out:
 * the harness hands the tests plain objects, so the boundary is one file wide.
 *
 * The alternative was `"type": "module"` on the package, which would resolve it
 * from the other end and is a real option — but it changes what `tsc` emits for
 * the published server, so it belongs to whoever writes `index.ts` and the
 * transports, not to a test helper.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerTools, SERVER_INSTRUCTIONS } from "../../src/tools.ts";
import type { SessionRegistry } from "../../src/sessions.ts";

/** One tool call's answer, flattened to what a test asserts on. */
export interface ToolAnswer {
  /** Every text block, joined — every tool here returns exactly one, except
   * `ui_view`, whose image block contributes nothing to this string. */
  text: string;
  isError: boolean;
  content: { type: string; [key: string]: unknown }[];
}

/** One registration, as `tools/list` publishes it. */
export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}

export interface ToolHarness {
  /** Calls a tool and flattens the answer. A tool that *renders* a failure
   * still resolves — `isError` is how the two are told apart, exactly as an
   * agent sees it. */
  call(name: string, args: Record<string, unknown>): Promise<ToolAnswer>;
  /** Calls a tool without flattening, for the schema-rejection tests: a
   * request the Zod schema refuses never reaches a tool body, so it comes back
   * as a protocol error rather than as a result. */
  callRaw(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Everything the server published, by name. */
  list(): Promise<Map<string, ListedTool>>;
  close(): Promise<void>;
}

/**
 * Connects a client to a server carrying `sessions`' tools.
 *
 * The server is built the way `index.ts` will build it — same instructions,
 * same `tools` capability — because a `tools/list` that a test diffs against
 * the parity baseline has to be the same list an agent would receive.
 */
export async function connectTools(sessions: SessionRegistry): Promise<ToolHarness> {
  const server = new McpServer(
    { name: "simgadget", version: "0.0.0-test" },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } }
  );
  registerTools(server, sessions);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "tools-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    async call(name, args) {
      const result = (await client.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text?: string; [key: string]: unknown }[];
      };
      return {
        text: result.content.map((block) => block.text ?? "").join(""),
        isError: result.isError === true,
        content: result.content,
      };
    },
    async callRaw(name, args) {
      return client.callTool({ name, arguments: args });
    },
    async list() {
      const { tools } = await client.listTools();
      return new Map(tools.map((tool) => [tool.name, tool as ListedTool]));
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
