/**
 * The two transports, and the configuration that chooses between them.
 *
 * A port of index.ts:2793–3004 plus `parseArgs`/`config` from :2691–2764. It
 * is one file because the four settings — transport, host, port, verbose —
 * exist only to answer "which transport, bound where", and because everything
 * here has to be importable without starting anything: `index.ts` runs a server
 * the moment it is loaded, which is exactly why the old server's argument
 * parsing and Host allowlist never had a test between them.
 *
 * ## What this file does not know
 *
 * It has never heard of a tool or a session. It is handed a `createServer`
 * factory and calls it; in HTTP mode it calls it **per request**, which is the
 * one quirk here that everything else depends on — see `runHttp`.
 *
 * ## The four settings, and where a default lives
 *
 * `parseArgs` reads only the command line and reports what it found, with no
 * opinion about what a missing flag means. `env.ts` owns the defaults, one per
 * accessor. `resolveConfig` is where the two meet, and it is the only place
 * that knows the order: **CLI flag > environment variable > default**. Three
 * files, one rule each, because the failure this arrangement prevents — a
 * default written down twice and later changed once — is silent in every
 * direction.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";

import {
  allowedHosts,
  httpHost as envHost,
  httpPort as envPort,
  transport as envTransport,
  verbose as envVerbose,
} from "./env.ts";
import { toError } from "./render.ts";

// ---- configuration ---------------------------------------------------------

/** What a command line can say. Every field optional: absent means "the flag
 * was not given", which is what lets the environment be consulted next. */
export interface CliArgs {
  transport?: string;
  host?: string;
  port?: string;
  verbose?: boolean;
}

/** The four settings, resolved. */
export interface TransportConfig {
  transport: string;
  host: string;
  port: number;
  verbose: boolean;
}

/**
 * Parses CLI flags. Supported (CLI takes precedence over env vars):
 *   --http | --stdio            select transport (http is the default)
 *   --transport <stdio|http>    select transport
 *   --host <addr>               HTTP bind address
 *   --port <n>                  HTTP port
 *   --verbose | -v              log client connections and calls (http mode)
 * Each value flag also accepts the `--flag=value` form.
 *
 * Verbatim from index.ts:2691, including the deliberate silence about an
 * unrecognised argument: a client that appends its own flags to the command
 * line it spawns should not be met with a usage error from a server that had
 * no trouble starting.
 */
export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const key = eq === -1 ? arg : arg.slice(0, eq);
    // Value is either after `=` or the next argument.
    const value = () => (eq === -1 ? argv[++i] : arg.slice(eq + 1));

    switch (key) {
      case "--http":
        out.transport = "http";
        break;
      case "--stdio":
        out.transport = "stdio";
        break;
      case "--transport":
        out.transport = value();
        break;
      case "--host":
        out.host = value();
        break;
      case "--port":
        out.port = value();
        break;
      case "--verbose":
      case "-v":
        out.verbose = true;
        break;
    }
  }
  return out;
}

/**
 * Resolves the four settings: CLI flag > env var > default.
 *
 * HTTP is the default as of 2.0.0. Sessions live in the server process, so
 * stdio — where every client spawns its own private server — cannot share a
 * simulator between agents, which is the point of this fork. stdio remains
 * available via --stdio for a single client that wants to own its own server.
 *
 * The env half is `env.ts`'s, defaults included, so a setting that is not on
 * the command line has exactly one answer here and it is the accessor's. Note
 * that `--transport HTTP` is lowercased and `--port zzz` is `NaN`, both
 * matching index.ts:2749 — the port in particular deliberately does not fall
 * back to 8008, because a typo that silently binds the default is how two
 * servers end up fighting over one port.
 */
export function resolveConfig(cli: CliArgs): TransportConfig {
  return {
    transport: (cli.transport || envTransport()).toLowerCase(),
    host: cli.host || envHost(),
    port: cli.port ? Number(cli.port) : envPort(),
    verbose: cli.verbose || envVerbose(),
  };
}

// ---- verbose logging -------------------------------------------------------

/** Writes a timestamped line to stderr, or nothing at all. */
export type Vlog = (message: string) => void;

/**
 * Builds the verbose logger. Used in HTTP mode to surface client connections
 * and tool calls; stderr never carries MCP protocol traffic, so this is safe in
 * any transport. Port of index.ts:2766, as a factory rather than a closure over
 * a module-global `config`.
 */
export function createVlog(isVerbose: boolean): Vlog {
  if (!isVerbose) return () => {};
  return (message: string) => {
    console.error(`[${new Date().toISOString()}] ${message}`);
  };
}

/**
 * Produces a short, human-readable summary of a JSON-RPC request body for
 * verbose logging, e.g. `session "qa-a" ui_tap`, `initialize`, `tools/list`.
 *
 * Every branch here is a guess about a body that arrived from the network, so
 * none of it may throw: this runs before the request is dispatched, and a
 * logger that crashed on a malformed body would turn a 400 into a 500.
 */
export function summarizeRpc(body: unknown): string {
  const one = (msg: any): string => {
    if (!msg || typeof msg !== "object") return "?";
    if (msg.method === "tools/call") {
      const name = msg.params?.name ?? "?";
      const sid = msg.params?.arguments?.id;
      return sid ? `session "${sid}" ${name}` : name;
    }
    return msg.method ?? "response";
  };
  return Array.isArray(body) ? body.map(one).join(", ") : one(body);
}

// ---- stdio -----------------------------------------------------------------

/**
 * Serves one client over stdin/stdout.
 *
 * `onStdinClose` is the client going away: in stdio mode it owns the process
 * lifecycle, so a closed stdin means nobody is left to talk to and the owned
 * simulators should be cleaned up rather than left booted (index.ts:2797).
 */
export async function runStdio(opts: {
  createServer: () => McpServer;
  onStdinClose: () => void;
}): Promise<void> {
  const server = opts.createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.on("close", opts.onStdinClose);
}

// ---- HTTP ------------------------------------------------------------------

/**
 * Reads the full request body and parses it as JSON. Returns undefined for an
 * empty body (e.g. GET requests).
 */
export function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * The names a container uses to reach a service on its host.
 *
 * Allowed by default because running the client in a container and the server
 * on the host is a first-class way to use this server, and rejecting it was a
 * regression: DNS rebinding protection arrived with the switch to HTTP and
 * allowlisted only the loopback spellings, so every containerised client began
 * getting `403 Invalid Host header: host.docker.internal:<port>` with nothing
 * in the message to suggest a remedy.
 *
 * This does not weaken the protection. A rebound request carries a name the
 * *attacker* controls, and these are not such names: `.internal` is reserved by
 * ICANN and cannot be registered or served by public DNS, and these particular
 * names are resolved locally by the container runtime to the host it is already
 * running on. There is no way for a hostile page to make a browser send one.
 */
export const CONTAINER_HOST_NAMES = [
  "host.docker.internal",
  "gateway.docker.internal",
  "host.containers.internal", // Podman
];

/**
 * Host header values a legitimate client would send, for DNS rebinding
 * protection.
 *
 * A real client connects to the address we bound and sends it verbatim in Host.
 * A rebound request arrives naming the attacker's domain instead, so matching on
 * this list rejects it while leaving normal use untouched.
 *
 * Set SIMGADGET_ALLOWED_HOSTS (comma separated, `host:port`) when fronting the
 * server with a proxy or reaching it by another name on purpose. Those entries
 * are appended verbatim, port and all, because a proxy's name is not
 * necessarily reached on the port we bound.
 */
export function allowedHostHeaders(host: string, port: number): string[] {
  const names = new Set([
    "127.0.0.1",
    "localhost",
    "[::1]",
    ...CONTAINER_HOST_NAMES,
  ]);
  // A wildcard bind tells us nothing about the name clients will use, so only
  // add an explicit address.
  if (host && host !== "0.0.0.0" && host !== "::") names.add(host);

  return [...[...names].map((name) => `${name}:${port}`), ...allowedHosts()];
}

/**
 * Serves every client over one HTTP listener, statelessly.
 *
 * **A fresh `McpServer` and transport per request** (index.ts:2932), because
 * the SDK's streamable HTTP transport in stateless mode is a per-request
 * object. That is only survivable because the durable state — which session
 * owns which simulator — lives in the registry `createServer` closes over, not
 * in the connection. It is the whole reason `registerTools` takes a registry as
 * a parameter, and the reason an agent can disconnect, reconnect, and still
 * find its simulator.
 */
export async function runHttp(opts: {
  createServer: () => McpServer;
  host: string;
  port: number;
  verbose: boolean;
  vlog: Vlog;
}): Promise<void> {
  const { host, port, vlog } = opts;
  const allowed = allowedHostHeaders(host, port);

  const httpServer = http.createServer(async (req, res) => {
    const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    // Route: only POST /mcp is served. Stateless mode has no server-push (GET)
    // or session teardown (DELETE), so those return 405.
    const url = (req.url || "").split("?")[0];
    if (url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        })
      );
      return;
    }

    // Checked here as well as in the transport, purely so the answer is useful.
    // The SDK's own rejection is `Invalid Host header: <host>`, which tells an
    // operator what was refused but not that this is deliberate, nor how to
    // permit a name they reach the server by on purpose.
    const sentHost = req.headers.host ?? "";
    if (!allowed.includes(sentHost)) {
      vlog(`${peer} rejected: Host "${sentHost}" is not in the allowlist`);
      res.writeHead(403, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              `Rejected a request whose Host header is "${sentHost}". This server ` +
              `only answers to the addresses it is reached by on purpose, because ` +
              `a web page you visit could otherwise point a hostname it controls ` +
              `at this port and drive the simulator from your browser.\n\n` +
              `Currently accepted: ${allowed.join(", ")}.\n\n` +
              `If "${sentHost}" is how you legitimately reach this server — behind ` +
              `a proxy, or under another name — start it with ` +
              `SIMGADGET_ALLOWED_HOSTS="${sentHost}" (comma separated for ` +
              `several).`,
          },
          id: null,
        })
      );
      return;
    }

    // Stateless: a fresh server + transport per request. Durable simulator
    // state lives in the session registry, which is shared across all requests
    // and survives client disconnects/reconnects.
    const server = opts.createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Binding to loopback is not by itself a boundary. A web page the user
      // visits can point a hostname it controls at 127.0.0.1 (DNS rebinding);
      // its fetch is then same-origin, so no CORS preflight applies, and it can
      // drive every tool here — read screenshots, write files at chosen paths.
      // The rebound request still carries the attacker's name in Host, so an
      // allowlist of the addresses we actually serve rejects it.
      enableDnsRebindingProtection: true,
      allowedHosts: allowed,
      // Deliberately no allowedOrigins: the SDK rejects a request that has no
      // Origin header once that list is set, and non-browser MCP clients do not
      // send one. Host alone is what defeats rebinding.
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      const body = await readJsonBody(req);
      vlog(`${peer} ${summarizeRpc(body)}`);
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: toError(err).message },
            id: null,
          })
        );
      }
    }
  });

  // Verbose: surface raw TCP connect/disconnect so client comings-and-goings
  // are visible even between requests.
  httpServer.on("connection", (socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    vlog(`client ${peer} connected`);
    socket.on("close", () => vlog(`client ${peer} disconnected`));
  });

  // Without a listener, a failure to bind is an unhandled 'error' event: the
  // process dies on a raw stack trace. EADDRINUSE is likely now that http is
  // the default and a second server may be started by habit.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(
        `Port ${port} on ${host} is already in use. Another simgadget-mcp is ` +
          `probably already running — point your client at it, or choose another ` +
          `port with --port.`
      );
    } else {
      console.error(`HTTP server error: ${err.message}`);
    }
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, resolve);
  });
  console.error(
    `SimGadget MCP server listening on http://${host}:${port}/mcp${
      opts.verbose ? " (verbose)" : ""
    }`
  );
}
