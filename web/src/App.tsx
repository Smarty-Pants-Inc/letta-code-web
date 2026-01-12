import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TerminalView, type TerminalViewHandle } from "./TerminalView";

type RunnerMode = "mock" | "letta" | "seam";

type AuthStatus = {
  signedIn: boolean;
  apiBaseUrl?: string;
  hasRefreshToken?: boolean;
  accessTokenExpiresAt?: number;
  error?: string;
};

type PendingAuth =
  | {
      status: "pending";
      authId: string;
      verificationUrl: string;
      userCode: string;
      expiresAt: number;
    }
  | { status: "success"; authId: string }
  | { status: "error"; authId: string; message: string };

type ApprovalRequest = {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
};

type AskUserQuestionArgs = {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
};

type ActiveOverlay =
  | "model"
  | "toolset"
  | "system"
  | "agent"
  | "resume"
  | "search"
  | "subagent"
  | "feedback"
  | "memory"
  | "pin"
  | "new"
  | "mcp"
  | "help"
  | "oauth"
  | null;

type UiOptions = {
  models?: Array<{ id: string; label: string }>;
  toolsets?: Array<{ id: string; label: string }>;
  systemPrompts?: Array<{ id: string; label: string }>;
};

type UiState = {
  activeOverlay: ActiveOverlay;
  pendingApprovals: ApprovalRequest[];
  currentApprovalIndex: number;
  currentApproval?: ApprovalRequest;
  agentId?: string;
  agentName?: string | null;
  currentModelId?: string | null;
  currentToolset?: string | null;
  currentSystemPromptId?: string | null;
  options?: UiOptions;
};

type UiAction =
  | { type: "overlay.open"; overlay: Exclude<ActiveOverlay, null> }
  | { type: "overlay.close" }
  | { type: "model.select"; modelId: string }
  | { type: "toolset.select"; toolset: string }
  | { type: "system.select"; promptId: string }
  | { type: "agent.select"; agentId: string }
  | { type: "approval.approveCurrent" }
  | { type: "approval.approveAlways"; scope?: "project" | "session" }
  | { type: "approval.denyCurrent"; reason: string }
  | { type: "approval.cancel" };

type ServerMessage =
  | { type: "terminal.data"; data: string }
  | { type: "ui.state"; state: UiState }
  | {
      type: "ui.tool_ui.state";
      toolCallId: string;
      toolName: string;
      state: { kind: string; payload: unknown };
    }
  | { type: "session.error"; message: string };

type ClientMessage =
  | { type: "session.init"; config: { apiKey?: string; baseUrl?: string } }
  | { type: "session.restart" }
  | { type: "terminal.resize"; cols: number; rows: number }
  | { type: "terminal.key"; data: string }
  | { type: "input.submit"; text: string }
  | {
      type: "ui.tool_ui.event";
      toolCallId: string;
      event: { type: string; payload?: unknown };
    }
  | { type: "ui.action"; action: UiAction };

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type AdvancedHunk = {
  oldStart: number;
  newStart: number;
  lines: Array<{ raw: string }>;
};

type AdvancedDiffSuccess = {
  mode: "advanced";
  fileName: string;
  oldStr: string;
  newStr: string;
  hunks: AdvancedHunk[];
};

type AdvancedDiffFallback = { mode: "fallback"; reason: string };
type AdvancedDiffUnpreviewable = { mode: "unpreviewable"; reason: string };
type AdvancedDiffResult =
  | AdvancedDiffSuccess
  | AdvancedDiffFallback
  | AdvancedDiffUnpreviewable;

function DiffView({ diff }: { diff: AdvancedDiffResult }) {
  if (diff.mode !== "advanced") {
    return (
      <div className="diffNote">
        <strong>Preview unavailable:</strong> {diff.reason}
      </div>
    );
  }

  return (
    <div className="diff">
      {diff.hunks.map((hunk) => {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;

        return (
          <div
            key={`hunk-${hunk.oldStart}-${hunk.newStart}`}
            className="diffHunk"
          >
            {hunk.lines.map((line) => {
              const raw = typeof line.raw === "string" ? line.raw : "";
              const prefix = raw[0] ?? " ";
              const text = raw.slice(1);

              const oldNum = prefix === "+" ? "" : String(oldLine);
              const newNum = prefix === "-" ? "" : String(newLine);

              if (prefix === " " || prefix === "-") oldLine += 1;
              if (prefix === " " || prefix === "+") newLine += 1;

              const cls =
                prefix === "+"
                  ? "diffRow diffAdd"
                  : prefix === "-"
                    ? "diffRow diffDel"
                    : "diffRow";

              return (
                <div
                  key={`${oldNum}:${newNum}:${prefix}:${text}`}
                  className={cls}
                >
                  <div className="diffNum">{oldNum}</div>
                  <div className="diffNum">{newNum}</div>
                  <div className="diffPrefix">{prefix}</div>
                  <div className="diffText">{text}</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function App() {
  const terminalRef = useRef<TerminalViewHandle>(null);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerSendRef = useRef<HTMLButtonElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [terminalLog, setTerminalLog] = useState("");
  const [runner, setRunner] = useState<RunnerMode>("mock");
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [connectBaseUrl, setConnectBaseUrl] = useState("https://api.letta.com");
  const [connectPending, setConnectPending] = useState<PendingAuth | null>(
    null,
  );
  const [connectError, setConnectError] = useState<string | null>(null);
  const [uiState, setUiState] = useState<UiState>({
    activeOverlay: null,
    pendingApprovals: [],
    currentApprovalIndex: 0,
  });

  const [toolUi, setToolUi] = useState<{
    toolCallId: string;
    toolName: string;
    state: { kind: string; payload: unknown };
  } | null>(null);

  const [draft, setDraft] = useState("");
  const [denyReason, setDenyReason] = useState("");
  const [overlayModelId, setOverlayModelId] = useState("");
  const [overlayToolset, setOverlayToolset] = useState("");
  const [overlaySystemPromptId, setOverlaySystemPromptId] = useState("");

  useEffect(() => {
    const vv = window.visualViewport;
    const set = () => {
      const vvHeight = vv?.height;
      const vvOffsetTop = vv?.offsetTop;
      const clientHeight = document.documentElement.clientHeight;
      const innerHeight = window.innerHeight;

      // iOS Safari can report viewport sizes inconsistently as the browser UI
      // expands/collapses. Picking the smallest tends to avoid bottom clipping.
      const candidates = [
        clientHeight,
        innerHeight,
        typeof vvHeight === "number" ? vvHeight : Number.POSITIVE_INFINITY,
      ].filter((n) => Number.isFinite(n) && n > 0);
      const h = Math.min(...candidates);

      document.documentElement.style.setProperty("--appHeight", `${h}px`);

      const top = typeof vvOffsetTop === "number" ? vvOffsetTop : 0;
      const heightBase =
        typeof vvHeight === "number"
          ? vvHeight
          : Math.min(clientHeight, innerHeight);
      const height = Math.min(h, heightBase);
      document.documentElement.style.setProperty("--vvTop", `${top}px`);
      document.documentElement.style.setProperty("--vvHeight", `${height}px`);
      document.documentElement.style.setProperty(
        "--vvBottom",
        `${top + height}px`,
      );

      // Additional bottom inset when visual viewport doesn't cover the full layout viewport
      // (e.g. iOS bottom bar / keyboard).
      if (typeof vvHeight === "number" && typeof vvOffsetTop === "number") {
        const bottomInset = Math.max(0, innerHeight - (vvHeight + vvOffsetTop));
        document.documentElement.style.setProperty(
          "--vvBottomInset",
          `${bottomInset}px`,
        );
      } else {
        document.documentElement.style.setProperty("--vvBottomInset", "0px");
      }
    };

    set();
    window.addEventListener("resize", set);
    vv?.addEventListener("resize", set);
    vv?.addEventListener("scroll", set);
    return () => {
      window.removeEventListener("resize", set);
      vv?.removeEventListener("resize", set);
      vv?.removeEventListener("scroll", set);
    };
  }, []);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;

    const write = () => {
      document.documentElement.style.setProperty(
        "--composerHeight",
        `${el.offsetHeight}px`,
      );
    };

    write();
    const ro = new ResizeObserver(() => write());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = composerSendRef.current;
    if (!el) return;

    const write = () => {
      document.documentElement.style.setProperty(
        "--composerSendWidth",
        `${el.offsetWidth}px`,
      );
    };

    write();
    const ro = new ResizeObserver(() => write());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (uiState.activeOverlay === "model") {
      setOverlayModelId(uiState.currentModelId ?? "");
    } else if (uiState.activeOverlay === "toolset") {
      setOverlayToolset(uiState.currentToolset ?? "");
    } else if (uiState.activeOverlay === "system") {
      setOverlaySystemPromptId(uiState.currentSystemPromptId ?? "");
    }
  }, [
    uiState.activeOverlay,
    uiState.currentModelId,
    uiState.currentToolset,
    uiState.currentSystemPromptId,
  ]);

  const wsUrl = useMemo(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${window.location.host}/ws`;
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }, []);

  const refreshServerInfo = useCallback(async () => {
    const [infoRes, authRes] = await Promise.all([
      fetch("/api/info"),
      fetch("/api/auth/status"),
    ]);

    if (infoRes.ok) {
      const info = (await infoRes.json()) as { runner?: RunnerMode };
      if (info.runner) setRunner(info.runner);
    }

    if (authRes.ok) {
      const st = (await authRes.json()) as AuthStatus;
      setAuth(st);
      if (typeof st.apiBaseUrl === "string") {
        setConnectBaseUrl(st.apiBaseUrl);
      }
    }
  }, []);

  useEffect(() => {
    void refreshServerInfo();
  }, [refreshServerInfo]);

  useEffect(() => {
    if (runner !== "mock" && auth && !auth.signedIn) {
      setConnectOpen(true);
    }
  }, [auth, runner]);

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.addEventListener("open", () => setConnected(true));
    ws.addEventListener("close", () => setConnected(false));
    ws.addEventListener("message", (ev) => {
      const parsed = safeJsonParse(String(ev.data));
      if (!parsed || typeof parsed !== "object") return;
      const msg = parsed as ServerMessage;

      if (msg.type === "terminal.data") {
        terminalRef.current?.write(msg.data);
        setTerminalLog((prev) => {
          const next = prev + msg.data;
          return next.length > 20_000 ? next.slice(next.length - 20_000) : next;
        });
      } else if (msg.type === "ui.state") {
        setUiState(msg.state);

        // Clear any stale tool-ui state when the current approval changes.
        setToolUi((prev) => {
          const cur = msg.state.currentApproval;
          if (!prev) return null;
          if (!cur) return null;
          return prev.toolCallId === cur.toolCallId ? prev : null;
        });
      } else if (msg.type === "ui.tool_ui.state") {
        setToolUi({
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          state: msg.state,
        });
      } else if (msg.type === "session.error") {
        const line = `\r\n[web] ERROR: ${msg.message}\r\n`;
        terminalRef.current?.write(line);
        setTerminalLog((prev) => {
          const next = prev + line;
          return next.length > 20_000 ? next.slice(next.length - 20_000) : next;
        });
      }
    });

    return () => {
      ws.close();
    };
  }, [wsUrl]);

  const startConnect = useCallback(async () => {
    setConnectError(null);
    setConnectPending(null);

    const resp = await fetch("/api/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiBaseUrl: connectBaseUrl }),
    });

    if (!resp.ok) {
      const err = (await resp.json()) as { error?: string };
      throw new Error(err.error || "Failed to start auth");
    }

    const pending = (await resp.json()) as PendingAuth;
    if (pending.status !== "pending") {
      throw new Error("Unexpected auth response");
    }

    setConnectPending(pending);

    const popup = window.open(
      pending.verificationUrl,
      "letta_oauth",
      "popup=yes,width=480,height=720",
    );
    if (!popup) {
      // Mobile Safari / popup blockers: fall back to same-tab navigation.
      window.location.href = pending.verificationUrl;
      return;
    }

    let intervalId = 0;
    const poll = async () => {
      const pollRes = await fetch(
        `/api/auth/poll?authId=${encodeURIComponent(pending.authId)}`,
      );
      if (!pollRes.ok) {
        throw new Error("Auth poll failed");
      }
      const status = (await pollRes.json()) as PendingAuth;
      setConnectPending(status);

      if (status.status === "pending") {
        return;
      }
      window.clearInterval(intervalId);
      if (status.status === "error") {
        throw new Error(status.message);
      }
      // success
      setConnectOpen(false);
      await refreshServerInfo();
      send({ type: "session.restart" });
      try {
        popup.close();
      } catch {
        // ignore
      }
    };

    intervalId = window.setInterval(() => {
      void poll().catch((err: unknown) => {
        window.clearInterval(intervalId);
        const message = err instanceof Error ? err.message : String(err);
        setConnectError(message);
      });
    }, 1000);
  }, [connectBaseUrl, refreshServerInfo, send]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    await refreshServerInfo();
    setConnectOpen(true);
    send({ type: "session.restart" });
  }, [refreshServerInfo, send]);

  const handleSubmit = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    send({ type: "input.submit", text });
    setDraft("");
  }, [draft, send]);

  useEffect(() => {
    void draft;
    const el = composerTextareaRef.current;
    if (!el) return;

    // Keep the composer single-line by default, but auto-grow for multiline.
    el.style.height = "auto";
    const min = 40;
    const max = 120;
    const next = Math.min(max, Math.max(min, el.scrollHeight));
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [draft]);

  const currentApproval = uiState.currentApproval;

  useEffect(() => {
    // Reset per-approval input state
    void currentApproval?.toolCallId;
    setDenyReason("");
  }, [currentApproval?.toolCallId]);

  const approvalArgs = useMemo(() => {
    if (!currentApproval) return null;
    return safeJsonParse(currentApproval.toolArgs);
  }, [currentApproval]);

  const toolUiForCurrent =
    currentApproval && toolUi?.toolCallId === currentApproval.toolCallId
      ? toolUi
      : null;

  const sendToolEvent = useCallback(
    (type: string, payload?: unknown) => {
      if (!currentApproval) return;
      send({
        type: "ui.tool_ui.event",
        toolCallId: currentApproval.toolCallId,
        event: { type, payload },
      });
    },
    [currentApproval, send],
  );

  const approvalArgsDisplay = useMemo(() => {
    if (approvalArgs == null) return null;
    if (isRecord(approvalArgs) && Object.keys(approvalArgs).length === 0) {
      return null;
    }
    return approvalArgs;
  }, [approvalArgs]);

  const approvalUi = useMemo(() => {
    if (!currentApproval) return null;

    if (currentApproval.toolName === "EnterPlanMode") {
      return {
        title: "Enter plan mode?",
        description:
          "In plan mode, the assistant will explore and design an implementation approach. No code changes will be made until you approve the plan.",
        approveLabel: "Yes, enter plan mode",
        denyLabel: "No, start implementing now",
      };
    }

    if (currentApproval.toolName === "ExitPlanMode") {
      return {
        title: "Ready to code?",
        description:
          "Approving will exit plan mode and allow write tools again.",
        approveLabel: "Yes, start implementing",
        denyLabel: "No, keep planning",
      };
    }

    return null;
  }, [currentApproval]);

  const questionApproval = useMemo(() => {
    if (
      !toolUiForCurrent ||
      toolUiForCurrent.state.kind !== "ask_user_question"
    ) {
      return null;
    }
    const payload = toolUiForCurrent.state
      .payload as Partial<AskUserQuestionArgs>;
    return Array.isArray(payload.questions)
      ? ({ questions: payload.questions } satisfies AskUserQuestionArgs)
      : null;
  }, [toolUiForCurrent]);

  const bashApproval = useMemo(() => {
    if (!toolUiForCurrent || toolUiForCurrent.state.kind !== "bash_approval") {
      return null;
    }
    const payload = toolUiForCurrent.state.payload as {
      command?: unknown;
      description?: unknown;
      allowPersistence?: unknown;
      approveAlwaysText?: unknown;
    };
    return {
      command: typeof payload.command === "string" ? payload.command : "",
      description:
        typeof payload.description === "string" ? payload.description : null,
      allowPersistence:
        typeof payload.allowPersistence === "boolean"
          ? payload.allowPersistence
          : true,
      approveAlwaysText:
        typeof payload.approveAlwaysText === "string"
          ? payload.approveAlwaysText
          : null,
    };
  }, [toolUiForCurrent]);

  const fileEditApproval = useMemo(() => {
    if (
      !toolUiForCurrent ||
      toolUiForCurrent.state.kind !== "file_edit_approval"
    ) {
      return null;
    }
    const payload = toolUiForCurrent.state.payload as {
      toolName?: unknown;
      headerText?: unknown;
      allowPersistence?: unknown;
      approveAlwaysText?: unknown;
      diff?: unknown;
      patchOperations?: unknown;
    };

    const diff = payload.diff as AdvancedDiffResult | null | undefined;
    const patchOperations = Array.isArray(payload.patchOperations)
      ? (payload.patchOperations as Array<{
          kind: "add" | "update" | "delete";
          path: string;
          displayPath: string;
          diff?: AdvancedDiffSuccess | null;
        }>)
      : null;

    return {
      toolName: typeof payload.toolName === "string" ? payload.toolName : "",
      headerText:
        typeof payload.headerText === "string" ? payload.headerText : "",
      allowPersistence:
        typeof payload.allowPersistence === "boolean"
          ? payload.allowPersistence
          : true,
      approveAlwaysText:
        typeof payload.approveAlwaysText === "string"
          ? payload.approveAlwaysText
          : null,
      diff: diff && typeof diff === "object" ? diff : null,
      patchOperations,
    };
  }, [toolUiForCurrent]);

  const exitPlanModeApproval = useMemo(() => {
    if (!toolUiForCurrent || toolUiForCurrent.state.kind !== "exit_plan_mode") {
      return null;
    }
    const payload = toolUiForCurrent.state.payload as {
      planFilePath?: unknown;
      planContent?: unknown;
    };
    return {
      planFilePath:
        typeof payload.planFilePath === "string" ? payload.planFilePath : null,
      planContent:
        typeof payload.planContent === "string" ? payload.planContent : null,
    };
  }, [toolUiForCurrent]);

  return (
    <div className="app">
      <pre data-testid="terminal-log" style={{ display: "none" }}>
        {terminalLog}
      </pre>

      <div className="appHeader">
        <div className="appHeaderLeft">
          <div className="appHeaderTitle">Letta Code</div>
        </div>
        <div className="appHeaderRight">
          {runner !== "mock" && (
            <button
              type="button"
              className="btn"
              onClick={() => setConnectOpen(true)}
              disabled={!connected}
            >
              {auth?.signedIn ? "Account" : "Connect"}
            </button>
          )}
        </div>
      </div>

      <div className="terminalPane">
        <TerminalView
          ref={terminalRef}
          onResize={(cols, rows) =>
            send({ type: "terminal.resize", cols, rows })
          }
          onKey={(data) => send({ type: "terminal.key", data })}
        />
      </div>

      <form
        className="composer"
        ref={composerRef}
        onSubmit={(e) => {
          e.preventDefault();
          handleSubmit();
        }}
      >
        <div className="composerInput">
          <textarea
            ref={composerTextareaRef}
            aria-label="Message"
            rows={1}
            placeholder={connected ? "Type a message…" : "Connecting…"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSubmit();
              }
            }}
            disabled={!connected}
          />
          <button
            type="submit"
            className="composerSend"
            ref={composerSendRef}
            disabled={!connected || !draft.trim()}
          >
            Send
          </button>
        </div>
      </form>

      {connectOpen && runner !== "mock" && (
        <>
          <button
            type="button"
            aria-label="Close connect"
            className="modalBackdrop"
            onClick={() => setConnectOpen(false)}
          />
          <div className="modal" role="dialog" aria-label="Connect">
            <div className="modalHeader">
              <h2>Connect to Letta</h2>
              <button
                type="button"
                className="btn"
                onClick={() => setConnectOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="modalList">
              <p>
                Runner: <code>{runner}</code>
              </p>

              <label>
                API Base URL
                <input
                  aria-label="API Base URL"
                  value={connectBaseUrl}
                  onChange={(e) => setConnectBaseUrl(e.target.value)}
                  placeholder="https://api.letta.com"
                />
              </label>

              {auth?.signedIn ? (
                <div className="overlayManual">
                  <button type="button" className="btn" onClick={logout}>
                    Logout
                  </button>
                  <button
                    type="button"
                    className="btn btnPrimary"
                    onClick={() => send({ type: "session.restart" })}
                  >
                    Restart backend
                  </button>
                </div>
              ) : (
                <div className="overlayManual">
                  <button
                    type="button"
                    className="btn btnPrimary"
                    onClick={() => {
                      void startConnect().catch((e: unknown) => {
                        const message =
                          e instanceof Error ? e.message : String(e);
                        setConnectError(message);
                      });
                    }}
                  >
                    Sign in (popup)
                  </button>
                </div>
              )}

              {connectPending?.status === "pending" && (
                <div>
                  <p>
                    Complete login in the popup window. If you don't see a
                    popup, your browser may have blocked it.
                  </p>
                  <p>
                    Code: <code>{connectPending.userCode}</code>
                  </p>
                  <p>
                    <a
                      href={connectPending.verificationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open login
                    </a>
                  </p>
                </div>
              )}

              {connectError && (
                <p>
                  <strong>Auth error:</strong> {connectError}
                </p>
              )}

              {auth?.error && (
                <p>
                  <strong>API error:</strong> {auth.error}
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {currentApproval && (
        <div className="sheet" role="dialog" aria-label="Approval">
          {questionApproval ? (
            <>
              <h2>
                {questionApproval.questions[0]?.header ?? "Question"}:{" "}
                {questionApproval.questions[0]?.question ?? ""}
              </h2>
              {questionApproval.questions[0]?.options?.length ? (
                <div className="modalList">
                  {questionApproval.questions[0].options.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      className="btn"
                      onClick={() =>
                        sendToolEvent("ask_user_question.submit", {
                          answers: {
                            [questionApproval.questions[0]?.question ??
                              "question"]: opt.label,
                          },
                        })
                      }
                    >
                      <strong>{opt.label}</strong>
                      {opt.description ? ` — ${opt.description}` : ""}
                    </button>
                  ))}
                </div>
              ) : null}

              <p style={{ marginTop: 8, opacity: 0.8 }}>
                Selecting an option answers the question and continues.
              </p>
            </>
          ) : currentApproval.toolName === "EnterPlanMode" ? (
            <>
              <div className="sheetLine" />
              <h2>Enter plan mode?</h2>
              <div className="sheetBody">
                <p>
                  Letta Code wants to enter plan mode to explore and design an
                  implementation approach.
                </p>
                <p style={{ marginBottom: 0 }}>
                  In plan mode, Letta Code will:
                </p>
                <ul style={{ marginTop: 6 }}>
                  <li>Explore the codebase thoroughly</li>
                  <li>Identify existing patterns</li>
                  <li>Design an implementation strategy</li>
                  <li>Present a plan for your approval</li>
                </ul>
                <p style={{ opacity: 0.8 }}>
                  No code changes will be made until you approve the plan.
                </p>
              </div>

              <div className="sheetActions">
                <button
                  type="button"
                  className="btn btnPrimary"
                  onClick={() => sendToolEvent("enter_plan_mode.approve")}
                >
                  Yes, enter plan mode
                </button>
                <button
                  type="button"
                  className="btn btnDanger"
                  onClick={() => sendToolEvent("enter_plan_mode.reject")}
                >
                  No, start implementing now
                </button>
              </div>
            </>
          ) : exitPlanModeApproval ? (
            <>
              {exitPlanModeApproval.planContent ? (
                <>
                  <div className="sheetLine" />
                  <h2>Ready to code? Here is your plan:</h2>
                  <div className="sheetLine dotted" />
                  <pre className="planPreview">
                    {exitPlanModeApproval.planContent}
                  </pre>
                  <div className="sheetLine dotted" />
                </>
              ) : null}

              <h2>Would you like to proceed?</h2>

              <div className="sheetActions">
                <button
                  type="button"
                  className="btn btnPrimary"
                  onClick={() =>
                    sendToolEvent("exit_plan_mode.approve_accept_edits")
                  }
                >
                  Yes, and auto-accept edits
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => sendToolEvent("exit_plan_mode.approve_manual")}
                >
                  Yes, and manually approve edits
                </button>
              </div>

              <label style={{ marginTop: 12, display: "block" }}>
                <textarea
                  aria-label="Keep planning feedback"
                  value={denyReason}
                  onChange={(e) => setDenyReason(e.target.value)}
                  rows={2}
                  placeholder="Type here to tell Letta Code what to change"
                  style={{ width: "100%", marginTop: 6 }}
                />
              </label>

              <div className="sheetActions">
                <button
                  type="button"
                  className="btn btnDanger"
                  disabled={!denyReason.trim()}
                  onClick={() =>
                    sendToolEvent("exit_plan_mode.keep_planning", {
                      reason: denyReason.trim(),
                    })
                  }
                >
                  Keep planning
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    sendToolEvent("exit_plan_mode.keep_planning", {
                      reason: "User cancelled",
                    })
                  }
                >
                  Cancel
                </button>
              </div>
            </>
          ) : bashApproval ? (
            <>
              <div className="sheetLine" />
              <h2>Run this command?</h2>
              <div className="sheetBody">
                <pre className="codePreview">{bashApproval.command}</pre>
                {bashApproval.description ? (
                  <p style={{ marginTop: 8, opacity: 0.8 }}>
                    {bashApproval.description}
                  </p>
                ) : null}
              </div>

              <div className="sheetActions">
                <button
                  type="button"
                  className="btn btnPrimary"
                  onClick={() => sendToolEvent("approval.approve")}
                >
                  Yes
                </button>
                {bashApproval.allowPersistence ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      sendToolEvent("approval.approve_always", {
                        scope: "project",
                      })
                    }
                  >
                    {bashApproval.approveAlwaysText ||
                      "Yes, and don't ask again for this project"}
                  </button>
                ) : null}
              </div>

              <label style={{ marginTop: 12, display: "block" }}>
                <textarea
                  aria-label="Deny reason"
                  value={denyReason}
                  onChange={(e) => setDenyReason(e.target.value)}
                  rows={2}
                  placeholder="No, and tell Letta Code what to do differently"
                  style={{ width: "100%", marginTop: 6 }}
                />
              </label>

              <div className="sheetActions">
                <button
                  type="button"
                  className="btn btnDanger"
                  disabled={!denyReason.trim()}
                  onClick={() =>
                    sendToolEvent("approval.deny", {
                      reason: denyReason.trim(),
                    })
                  }
                >
                  No
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => sendToolEvent("approval.cancel")}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : fileEditApproval ? (
            <>
              <div className="sheetLine" />
              <h2>{fileEditApproval.headerText}</h2>
              <div className="sheetLine dotted" />

              {fileEditApproval.patchOperations ? (
                <div className="sheetBody">
                  {fileEditApproval.patchOperations.map((op) => (
                    <div
                      key={`${op.kind}:${op.path}`}
                      style={{ marginTop: 10 }}
                    >
                      <div style={{ opacity: 0.8, marginBottom: 6 }}>
                        {op.displayPath}
                      </div>
                      <DiffView
                        diff={
                          op.diff ?? { mode: "fallback", reason: "No preview" }
                        }
                      />
                    </div>
                  ))}
                </div>
              ) : fileEditApproval.diff ? (
                <DiffView diff={fileEditApproval.diff} />
              ) : (
                <div className="diffNote">No preview</div>
              )}

              <div className="sheetLine dotted" />

              <div className="sheetActions">
                <button
                  type="button"
                  className="btn btnPrimary"
                  onClick={() => sendToolEvent("approval.approve")}
                >
                  Yes
                </button>
                {fileEditApproval.allowPersistence ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      sendToolEvent("approval.approve_always", {
                        scope: "project",
                      })
                    }
                  >
                    {fileEditApproval.approveAlwaysText ||
                      "Yes, and don't ask again for this project"}
                  </button>
                ) : null}
              </div>

              <label style={{ marginTop: 12, display: "block" }}>
                <textarea
                  aria-label="Deny reason"
                  value={denyReason}
                  onChange={(e) => setDenyReason(e.target.value)}
                  rows={2}
                  placeholder="No, and tell Letta Code what to do differently"
                  style={{ width: "100%", marginTop: 6 }}
                />
              </label>

              <div className="sheetActions">
                <button
                  type="button"
                  className="btn btnDanger"
                  disabled={!denyReason.trim()}
                  onClick={() =>
                    sendToolEvent("approval.deny", {
                      reason: denyReason.trim(),
                    })
                  }
                >
                  No
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => sendToolEvent("approval.cancel")}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              {approvalUi ? (
                <h2>{approvalUi.title}</h2>
              ) : (
                <h2>
                  Approval required ({uiState.currentApprovalIndex + 1}/
                  {uiState.pendingApprovals.length}): {currentApproval.toolName}
                </h2>
              )}

              {approvalUi?.description ? (
                <p style={{ marginTop: 8, opacity: 0.85 }}>
                  {approvalUi.description}
                </p>
              ) : null}

              {approvalArgsDisplay ? (
                <pre>{JSON.stringify(approvalArgsDisplay, null, 2)}</pre>
              ) : null}

              {!approvalUi ? (
                <label>
                  Deny reason
                  <textarea
                    aria-label="Deny reason"
                    value={denyReason}
                    onChange={(e) => setDenyReason(e.target.value)}
                    rows={2}
                    style={{ width: "100%", marginTop: 6 }}
                  />
                </label>
              ) : null}

              <div className="sheetActions">
                <button
                  type="button"
                  className="btn btnPrimary"
                  onClick={() =>
                    send({
                      type: "ui.action",
                      action: { type: "approval.approveCurrent" },
                    })
                  }
                >
                  {approvalUi?.approveLabel ?? "Approve"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    send({
                      type: "ui.action",
                      action: {
                        type: "approval.approveAlways",
                        scope: "session",
                      },
                    })
                  }
                >
                  Approve always (session)
                </button>

                <button
                  type="button"
                  className="btn btnDanger"
                  onClick={() =>
                    send({
                      type: "ui.action",
                      action: {
                        type: "approval.denyCurrent",
                        reason: denyReason.trim() || "Denied via web UI",
                      },
                    })
                  }
                >
                  {approvalUi?.denyLabel ?? "Deny"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    send({
                      type: "ui.action",
                      action: { type: "approval.cancel" },
                    })
                  }
                >
                  Cancel
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {uiState.activeOverlay && (
        <>
          <button
            type="button"
            aria-label="Close overlay"
            className="modalBackdrop"
            onClick={() =>
              send({ type: "ui.action", action: { type: "overlay.close" } })
            }
          />
          <div className="modal" role="dialog" aria-label="Overlay">
            <div className="modalHeader">
              <h2>Overlay: {uiState.activeOverlay}</h2>
              <button
                type="button"
                className="btn"
                onClick={() =>
                  send({ type: "ui.action", action: { type: "overlay.close" } })
                }
              >
                Close
              </button>
            </div>

            {uiState.activeOverlay === "model" && (
              <div className="modalList">
                {(uiState.options?.models ?? []).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className="btn"
                    onClick={() =>
                      send({
                        type: "ui.action",
                        action: { type: "model.select", modelId: m.id },
                      })
                    }
                  >
                    {m.label} ({m.id})
                  </button>
                ))}
                {(uiState.options?.models ?? []).length === 0 && (
                  <p>
                    Model list unavailable (runner did not provide options).
                  </p>
                )}

                <div className="overlayManual">
                  <input
                    aria-label="Model id"
                    value={overlayModelId}
                    onChange={(e) => setOverlayModelId(e.target.value)}
                    placeholder="Enter model id"
                  />
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={!overlayModelId.trim()}
                    onClick={() =>
                      send({
                        type: "ui.action",
                        action: {
                          type: "model.select",
                          modelId: overlayModelId.trim(),
                        },
                      })
                    }
                  >
                    Select
                  </button>
                </div>
              </div>
            )}

            {uiState.activeOverlay === "toolset" && (
              <div className="modalList">
                {(uiState.options?.toolsets ?? []).map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className="btn"
                    onClick={() =>
                      send({
                        type: "ui.action",
                        action: { type: "toolset.select", toolset: t.id },
                      })
                    }
                  >
                    {t.label} ({t.id})
                  </button>
                ))}
                {(uiState.options?.toolsets ?? []).length === 0 && (
                  <p>Toolset list unavailable.</p>
                )}

                <div className="overlayManual">
                  <input
                    aria-label="Toolset id"
                    value={overlayToolset}
                    onChange={(e) => setOverlayToolset(e.target.value)}
                    placeholder="Enter toolset id"
                  />
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={!overlayToolset.trim()}
                    onClick={() =>
                      send({
                        type: "ui.action",
                        action: {
                          type: "toolset.select",
                          toolset: overlayToolset.trim(),
                        },
                      })
                    }
                  >
                    Select
                  </button>
                </div>
              </div>
            )}

            {uiState.activeOverlay === "system" && (
              <div className="modalList">
                {(uiState.options?.systemPrompts ?? []).map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="btn"
                    onClick={() =>
                      send({
                        type: "ui.action",
                        action: { type: "system.select", promptId: p.id },
                      })
                    }
                  >
                    {p.label} ({p.id})
                  </button>
                ))}
                {(uiState.options?.systemPrompts ?? []).length === 0 && (
                  <p>System prompt list unavailable.</p>
                )}

                <div className="overlayManual">
                  <input
                    aria-label="System prompt id"
                    value={overlaySystemPromptId}
                    onChange={(e) => setOverlaySystemPromptId(e.target.value)}
                    placeholder="Enter system prompt id"
                  />
                  <button
                    type="button"
                    className="btn btnPrimary"
                    disabled={!overlaySystemPromptId.trim()}
                    onClick={() =>
                      send({
                        type: "ui.action",
                        action: {
                          type: "system.select",
                          promptId: overlaySystemPromptId.trim(),
                        },
                      })
                    }
                  >
                    Select
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
