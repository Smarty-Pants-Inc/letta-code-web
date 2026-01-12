import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import express from "express";
import { WebSocketServer } from "ws";
import {
  clearStoredAuth,
  getPendingAuth,
  readStoredAuth,
  revokeRefreshToken,
  startDeviceLogin,
} from "./auth.js";
import { validateAccessToken } from "./letta.js";
import type { RunnerMode } from "./protocol.js";
import { Session } from "./session.js";

function parseRunnerMode(value: string | undefined): RunnerMode {
  if (value === "mock" || value === "letta" || value === "seam") return value;
  return "mock";
}

function main() {
  const { values } = parseArgs({
    options: {
      host: { type: "string" },
      port: { type: "string" },
      runner: { type: "string" },
      help: { type: "boolean" },
    },
  });

  if (values.help) {
    const text = [
      "Letta Code Web TUI POC server",
      "",
      "USAGE",
      "  node dist/index.js --runner mock --host 127.0.0.1 --port 4173",
      "",
      "OPTIONS",
      "  --runner  mock|letta|seam",
      "  --host    <ip|hostname>",
      "  --port    <number>",
    ].join("\n");
    process.stdout.write(`${text}\n`);
    process.exit(0);
  }

  const port = Number(values.port ?? "4173");
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid --port: ${values.port}`);
  }

  const host = String(values.host ?? "127.0.0.1");
  if (!host.trim()) {
    throw new Error(`Invalid --host: ${values.host}`);
  }
  const runner = parseRunnerMode(values.runner);

  const app = express();
  app.use(express.json());
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(__dirname, "../../web/dist");

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.get("/api/info", (_req, res) => {
    res.status(200).json({ runner });
  });

  let authStatusCache:
    | {
        at: number;
        value: {
          signedIn: boolean;
          apiBaseUrl?: string;
          hasRefreshToken?: boolean;
          accessTokenExpiresAt?: number;
          error?: string;
        };
      }
    | undefined;

  app.get("/api/auth/status", async (_req, res) => {
    if (runner === "mock") {
      res.status(200).json({ signedIn: true });
      return;
    }

    const now = Date.now();
    if (authStatusCache && now - authStatusCache.at < 2_000) {
      res.status(200).json(authStatusCache.value);
      return;
    }

    const stored = readStoredAuth();
    if (!stored?.accessToken) {
      const value: {
        signedIn: boolean;
        apiBaseUrl?: string;
      } = { signedIn: false };
      if (stored?.apiBaseUrl) {
        value.apiBaseUrl = stored.apiBaseUrl;
      }
      authStatusCache = { at: now, value };
      res.status(200).json(value);
      return;
    }

    const check = await validateAccessToken(
      stored.apiBaseUrl,
      stored.accessToken,
    );
    const value: {
      signedIn: boolean;
      apiBaseUrl?: string;
      hasRefreshToken?: boolean;
      accessTokenExpiresAt?: number;
      error?: string;
    } = {
      signedIn: check.ok,
      apiBaseUrl: stored.apiBaseUrl,
      hasRefreshToken: Boolean(stored.refreshToken),
    };
    if (typeof stored.accessTokenExpiresAt === "number") {
      value.accessTokenExpiresAt = stored.accessTokenExpiresAt;
    }
    if (!check.ok) {
      value.error = check.message;
    }
    authStatusCache = { at: now, value };
    res.status(200).json(value);
  });

  app.post("/api/auth/start", async (req, res) => {
    try {
      const apiBaseUrl =
        typeof req.body?.apiBaseUrl === "string"
          ? String(req.body.apiBaseUrl)
          : undefined;
      const pending = await startDeviceLogin(apiBaseUrl);
      res.status(200).json(pending);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  app.get("/api/auth/poll", (req, res) => {
    const authId = typeof req.query.authId === "string" ? req.query.authId : "";
    const status = authId ? getPendingAuth(authId) : null;
    if (!status) {
      res.status(404).json({ error: "unknown authId" });
      return;
    }
    res.status(200).json(status);
  });

  app.post("/api/auth/logout", async (_req, res) => {
    const stored = readStoredAuth();
    if (stored?.refreshToken) {
      await revokeRefreshToken(stored.refreshToken);
    }
    clearStoredAuth();
    res.status(200).json({ ok: true });
  });

  app.use(express.static(webDist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  const sharedSession = runner === "mock" ? null : new Session({ runner });

  wss.on("connection", (ws) => {
    // Tests run Playwright fullyParallel against --runner mock.
    // Make mock mode per-connection so parallel clients don't fight over approvals/overlays.
    if (runner === "mock") {
      const session = new Session({ runner });
      session.attach(ws);
      ws.on("close", () => session.dispose());
      ws.on("error", () => session.dispose());
      return;
    }

    sharedSession?.attach(ws);
  });

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `Web TUI server listening on http://${host}:${port} (runner=${runner})`,
    );
  });
}

main();
