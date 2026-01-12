import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "node-pty";
import type { WebSocket } from "ws";
import { readStoredAuth } from "./auth.js";
import { validateAccessToken } from "./letta.js";
import { createNdjsonParser, encodeNdjson } from "./ndjson.js";
import type {
  ClientToServerMessage,
  RunnerMode,
  RunnerToServerMessage,
  ServerToClientMessage,
  ServerToRunnerMessage,
  UiAction,
  UiState,
} from "./protocol.js";

type SessionOpts = {
  runner: RunnerMode;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toClientMessage(message: ServerToClientMessage): string {
  return JSON.stringify(message);
}

export class Session {
  private readonly runner: RunnerMode;

  private readonly clients = new Set<WebSocket>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private startPromise: Promise<void> | null = null;

  private disposed = false;

  private terminalBuffer = "";
  private readonly maxTerminalBufferChars = 1_000_000;

  private lastToolUiStates = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      state: { kind: string; payload: unknown };
    }
  >();

  private ptyProcess: pty.IPty | null = null;
  private socketServer: net.Server | null = null;
  private runnerSocket: net.Socket | null = null;
  private tmpDir: string | null = null;
  private socketPath: string | null = null;

  private lastUiState: UiState = {
    activeOverlay: null,
    pendingApprovals: [],
    currentApprovalIndex: 0,
  };

  constructor(opts: SessionOpts) {
    this.runner = opts.runner;
  }

  attach(ws: WebSocket) {
    if (this.disposed) {
      try {
        ws.close();
      } catch {
        // ignore
      }
      return;
    }

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.clients.add(ws);

    ws.on("message", (data) => {
      this.onWsMessage(String(data));
    });

    ws.on("close", () => {
      this.detach(ws);
    });
    ws.on("error", () => {
      this.detach(ws);
    });

    // Prime the client immediately.
    this.flushTerminalBacklog(ws);
    this.sendToClient(ws, { type: "ui.state", state: this.lastUiState });
    for (const cached of this.lastToolUiStates.values()) {
      this.sendToClient(ws, {
        type: "ui.tool_ui.state",
        toolCallId: cached.toolCallId,
        toolName: cached.toolName,
        state: cached.state,
      });
    }

    this.ensureStarted();
  }

  private detach(ws: WebSocket) {
    this.clients.delete(ws);
    if (this.clients.size > 0) return;
    if (this.idleTimer) return;

    this.idleTimer = setTimeout(
      () => {
        this.stop();
      },
      5 * 60 * 1000,
    );
  }

  private ensureStarted() {
    if (this.startPromise) return;

    this.startPromise = this.start().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.pushTerminalData(`\r\n[web] session error: ${msg}\r\n`);
      this.sendToClients({ type: "session.error", message: msg });
      this.stop();
    });
  }

  stop() {
    this.startPromise = null;
    this.terminalBuffer = "";
    this.lastToolUiStates.clear();
    this.lastUiState = {
      activeOverlay: null,
      pendingApprovals: [],
      currentApprovalIndex: 0,
    };

    try {
      this.runnerSocket?.destroy();
    } catch {
      // ignore
    }
    this.runnerSocket = null;

    try {
      this.socketServer?.close();
    } catch {
      // ignore
    }
    this.socketServer = null;

    try {
      this.ptyProcess?.kill();
    } catch {
      // ignore
    }
    this.ptyProcess = null;

    if (this.socketPath) {
      try {
        fs.rmSync(this.socketPath, { force: true });
      } catch {
        // ignore
      }
    }
    this.socketPath = null;

    if (this.tmpDir) {
      try {
        fs.rmSync(this.tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    this.tmpDir = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    this.stop();

    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    this.clients.clear();
  }

  private async start(): Promise<void> {
    const tmpDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "letta-web-tui-"),
    );
    this.tmpDir = tmpDir;
    this.socketPath = path.join(tmpDir, "runner.sock");

    await this.startSocketServer(this.socketPath);

    if (this.runner === "mock") {
      this.spawnPty();
      return;
    }

    const stored = readStoredAuth();
    const apiKey = stored?.accessToken ?? process.env.LETTA_API_KEY;
    const baseUrl = stored?.apiBaseUrl ?? process.env.LETTA_BASE_URL;

    if (!apiKey) {
      this.pushTerminalData(
        "\r\n[web] Not authenticated. Use Connect to sign in first.\r\n",
      );
      return;
    }

    if (baseUrl) {
      const check = await validateAccessToken(baseUrl, apiKey);
      if (!check.ok) {
        this.pushTerminalData(
          `\r\n[web] Auth token invalid or API unreachable: ${check.message}\r\n\r\nUse Connect to sign in again.\r\n`,
        );
        return;
      }
    }

    this.spawnPty();
  }

  private async startSocketServer(socketPath: string): Promise<void> {
    await fs.promises.rm(socketPath, { force: true }).catch(() => undefined);

    const server = net.createServer((socket) => {
      if (this.runnerSocket) {
        socket.destroy();
        return;
      }

      this.runnerSocket = socket;
      const parse = createNdjsonParser((msg: unknown) =>
        this.onRunnerMessage(msg),
      );

      socket.setEncoding("utf8");
      socket.on("data", (chunk) => parse(String(chunk)));
      socket.on("close", () => {
        this.runnerSocket = null;
      });
      socket.on("error", () => {
        this.runnerSocket = null;
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });

    this.socketServer = server;
  }

  private spawnPty() {
    if (!this.socketPath) {
      throw new Error("socketPath not set");
    }

    const stored = readStoredAuth();
    const env: Record<string, string | undefined> = { ...process.env };
    env.TERM = "xterm-256color";

    // Stored auth wins to avoid accidentally using stale shell env vars.
    if (stored?.accessToken) env.LETTA_API_KEY = stored.accessToken;
    if (stored?.apiBaseUrl) env.LETTA_BASE_URL = stored.apiBaseUrl;

    // Use letta-code's web-tui IPC bridge in ALL modes so approvals/overlays and composer submits work.
    env.LETTA_CODE_WEB_UI_SOCKET = this.socketPath;

    const { file, args, cwd } = this.getRunnerCommand();
    const p = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 36,
      cwd,
      env,
    });
    this.ptyProcess = p;

    p.onData((data) => {
      this.pushTerminalData(data);
    });

    p.onExit(() => {
      this.stop();
    });
  }

  private getRunnerCommand(): { file: string; args: string[]; cwd: string } {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // session.ts is in server/src (dev) or server/dist (prod).
    // In both cases, the letta-code-web repo root is two directories up from here.
    const webRepoRoot = path.resolve(__dirname, "../..");

    // In a wrapper monorepo, letta-code-web may live under apps/, and the actual
    // workspace root is higher up (where forks/letta-code lives).
    const workspaceRoot =
      process.env.WORKSPACE_ROOT && process.env.WORKSPACE_ROOT.trim()
        ? path.resolve(process.env.WORKSPACE_ROOT)
        : (() => {
            let cur = webRepoRoot;
            for (let i = 0; i < 6; i++) {
              const candidate = path.join(
                cur,
                "forks",
                "letta-code",
                "src",
                "index.ts",
              );
              if (fs.existsSync(candidate)) return cur;

              const parent = path.dirname(cur);
              if (parent === cur) break;
              cur = parent;
            }
            return webRepoRoot;
          })();

    const lettaCodeDir =
      process.env.LETTA_CODE_DIR && process.env.LETTA_CODE_DIR.trim()
        ? path.resolve(process.env.LETTA_CODE_DIR)
        : path.join(workspaceRoot, "forks", "letta-code");

    if (this.runner === "mock") {
      return {
        file: process.execPath,
        args: [path.resolve(__dirname, "./runner/mock-runner.js")],
        cwd: workspaceRoot,
      };
    }

    if (this.runner === "letta") {
      const bun = process.env.BUN ?? "bun";
      const bunConfig = path.resolve(lettaCodeDir, "bunfig.toml");
      return {
        file: bun,
        args: [
          `--config=${bunConfig}`,
          "run",
          path.resolve(lettaCodeDir, "src", "index.ts"),
        ],
        cwd: workspaceRoot,
      };
    }

    // seam
    return {
      file: process.execPath,
      args: [path.resolve(__dirname, "./runner/seam-runner.js")],
      cwd: workspaceRoot,
    };
  }

  private sendToClient(ws: WebSocket, message: ServerToClientMessage) {
    if (this.disposed) return;
    try {
      ws.send(toClientMessage(message));
    } catch {
      // ignore
    }
  }

  private sendToClients(message: ServerToClientMessage) {
    if (this.disposed) return;
    const raw = toClientMessage(message);
    for (const ws of this.clients) {
      try {
        ws.send(raw);
      } catch {
        // ignore
      }
    }
  }

  private pushTerminalData(data: string) {
    this.terminalBuffer += data;
    if (this.terminalBuffer.length > this.maxTerminalBufferChars) {
      this.terminalBuffer = this.terminalBuffer.slice(
        this.terminalBuffer.length - this.maxTerminalBufferChars,
      );
    }
    this.sendToClients({ type: "terminal.data", data });
  }

  private flushTerminalBacklog(ws: WebSocket) {
    if (!this.terminalBuffer) return;

    const chunkSize = 64_000;
    for (let i = 0; i < this.terminalBuffer.length; i += chunkSize) {
      const chunk = this.terminalBuffer.slice(i, i + chunkSize);
      this.sendToClient(ws, { type: "terminal.data", data: chunk });
    }
  }

  private onWsMessage(raw: string) {
    if (this.disposed) return;
    const msg = safeJsonParse(raw);
    if (!isObject(msg) || typeof msg.type !== "string") return;
    const typed = msg as ClientToServerMessage;

    if (typed.type === "session.init") {
      // Deprecated (older frontend). Auth is now server-side via /api/auth/*.
      return;
    }

    if (typed.type === "session.restart") {
      this.restartPty();
      return;
    }

    if (typed.type === "terminal.resize") {
      if (
        typeof typed.cols === "number" &&
        typeof typed.rows === "number" &&
        this.ptyProcess
      ) {
        this.ptyProcess.resize(typed.cols, typed.rows);
      }
      return;
    }

    if (typed.type === "terminal.key") {
      if (typeof typed.data === "string" && this.ptyProcess) {
        this.ptyProcess.write(typed.data);
      }
      return;
    }

    if (typed.type === "input.submit") {
      if (typeof typed.text !== "string") return;
      this.forwardSubmit(typed.text);
      return;
    }

    if (typed.type === "ui.action") {
      this.forwardUiAction(typed.action);
    }

    if (typed.type === "ui.tool_ui.event") {
      if (
        this.runnerSocket &&
        typeof typed.toolCallId === "string" &&
        typed.event &&
        typeof typed.event === "object" &&
        typeof typed.event.type === "string"
      ) {
        const payload: ServerToRunnerMessage = {
          type: "runner.tool_ui.event",
          toolCallId: typed.toolCallId,
          event: typed.event,
        };
        this.runnerSocket.write(encodeNdjson(payload));
      }
    }
  }

  private restartPty() {
    if (this.disposed) return;

    try {
      this.runnerSocket?.destroy();
    } catch {
      // ignore
    }
    this.runnerSocket = null;

    try {
      this.ptyProcess?.kill();
    } catch {
      // ignore
    }
    this.ptyProcess = null;

    if (this.runner === "mock") {
      this.spawnPty();
      return;
    }

    const stored = readStoredAuth();
    const apiKey = stored?.accessToken ?? process.env.LETTA_API_KEY;
    const baseUrl = stored?.apiBaseUrl ?? process.env.LETTA_BASE_URL;
    if (!apiKey) {
      this.pushTerminalData(
        "\r\n[web] Not authenticated. Use Connect to sign in first.\r\n",
      );
      return;
    }

    if (baseUrl) {
      void (async () => {
        const check = await validateAccessToken(baseUrl, apiKey);
        if (!check.ok) {
          this.pushTerminalData(
            `\r\n[web] Auth token invalid or API unreachable: ${check.message}\r\n\r\nUse Connect to sign in again.\r\n`,
          );
          return;
        }
        this.spawnPty();
      })();
      return;
    }

    this.spawnPty();
  }

  private forwardSubmit(text: string) {
    const payload: ServerToRunnerMessage = { type: "runner.submit", text };
    if (this.runnerSocket) {
      this.runnerSocket.write(encodeNdjson(payload));
      return;
    }

    // Fallback: write into PTY as keystrokes.
    if (this.ptyProcess) {
      this.ptyProcess.write(text);
      this.ptyProcess.write("\r");
    }
  }

  private forwardUiAction(action: UiAction) {
    const payload: ServerToRunnerMessage = { type: "runner.ui_action", action };
    if (this.runnerSocket) this.runnerSocket.write(encodeNdjson(payload));
  }

  private onRunnerMessage(msg: unknown) {
    if (!isObject(msg) || typeof msg.type !== "string") return;
    const typed = msg as RunnerToServerMessage;

    if (typed.type === "runner.ui_state") {
      this.lastUiState = typed.state;
      this.sendToClients({ type: "ui.state", state: typed.state });
      return;
    }

    if (typed.type === "runner.ready") {
      // Always push the last known state so the browser can render immediately.
      this.sendToClients({ type: "ui.state", state: this.lastUiState });
      return;
    }

    if (typed.type === "runner.log") {
      this.pushTerminalData(`\r\n[runner:${typed.level}] ${typed.message}\r\n`);
      return;
    }

    if (typed.type === "runner.tool_ui.state") {
      this.lastToolUiStates.set(typed.toolCallId, {
        toolCallId: typed.toolCallId,
        toolName: typed.toolName,
        state: typed.state,
      });
      this.sendToClients({
        type: "ui.tool_ui.state",
        toolCallId: typed.toolCallId,
        toolName: typed.toolName,
        state: typed.state,
      });
    }
  }
}
