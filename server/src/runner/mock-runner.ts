import net from "node:net";
import { createNdjsonParser, encodeNdjson } from "../ndjson.js";
import type {
  RunnerToServerMessage,
  ServerToRunnerMessage,
  UiAction,
  UiState,
} from "../protocol.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const socketPath = process.env.LETTA_CODE_WEB_UI_SOCKET;
if (!socketPath) {
  process.stderr.write("Missing env LETTA_CODE_WEB_UI_SOCKET\n");
  process.exit(1);
}

const state: UiState = {
  activeOverlay: null,
  pendingApprovals: [],
  currentApprovalIndex: 0,
  agentId: "agent_mock",
  agentName: "Mock Agent",
  currentModelId: "mock-model-a",
  currentToolset: "default",
  currentSystemPromptId: "default",
  options: {
    models: [
      { id: "mock-model-a", label: "Mock Model A" },
      { id: "mock-model-b", label: "Mock Model B" },
    ],
    toolsets: [
      { id: "default", label: "Default" },
      { id: "gemini", label: "Gemini" },
      { id: "codex", label: "Codex" },
    ],
    systemPrompts: [
      { id: "default", label: "Default" },
      { id: "coding", label: "Coding" },
    ],
  },
};

function publish(sock: net.Socket) {
  const msg: RunnerToServerMessage = { type: "runner.ui_state", state };
  sock.write(encodeNdjson(msg));
}

function publishToolUi(
  sock: net.Socket,
  msg: Extract<RunnerToServerMessage, { type: "runner.tool_ui.state" }>,
) {
  sock.write(encodeNdjson(msg));
}

function log(sock: net.Socket, level: LogLevel, message: string) {
  const msg: RunnerToServerMessage = { type: "runner.log", level, message };
  sock.write(encodeNdjson(msg));
}

function setActiveOverlay(overlay: UiState["activeOverlay"]) {
  state.activeOverlay = overlay;
}

function setApprovals(approvals: UiState["pendingApprovals"]) {
  state.pendingApprovals = approvals;
  state.currentApprovalIndex = 0;
  const first = approvals[0];
  if (first) {
    state.currentApproval = first;
  } else {
    delete state.currentApproval;
  }
}

function handleUiAction(sock: net.Socket, action: UiAction) {
  if (action.type === "overlay.open") {
    setActiveOverlay(action.overlay);
    log(sock, "info", `Opened overlay: ${action.overlay}`);
    publish(sock);
    return;
  }

  if (action.type === "overlay.close") {
    setActiveOverlay(null);
    log(sock, "info", "Closed overlay");
    publish(sock);
    return;
  }

  if (action.type === "model.select") {
    state.currentModelId = action.modelId;
    setActiveOverlay(null);
    log(sock, "info", `Selected model: ${action.modelId}`);
    publish(sock);
    return;
  }

  if (action.type === "toolset.select") {
    state.currentToolset = action.toolset;
    setActiveOverlay(null);
    log(sock, "info", `Selected toolset: ${action.toolset}`);
    publish(sock);
    return;
  }

  if (action.type === "system.select") {
    state.currentSystemPromptId = action.promptId;
    setActiveOverlay(null);
    log(sock, "info", `Selected system prompt: ${action.promptId}`);
    publish(sock);
    return;
  }

  if (action.type === "approval.approveCurrent") {
    setApprovals([]);
    log(sock, "info", "Approved current");
    publish(sock);
    return;
  }

  if (action.type === "approval.approveAlways") {
    setApprovals([]);
    log(sock, "info", `Approved always (${action.scope ?? "session"})`);
    publish(sock);
    return;
  }

  if (action.type === "approval.denyCurrent") {
    setApprovals([]);
    log(sock, "warn", `Denied: ${action.reason}`);
    publish(sock);
    return;
  }

  if (action.type === "approval.cancel") {
    setApprovals([]);
    log(sock, "info", "Cancelled approvals");
    publish(sock);
  }
}

const sock = net.connect(socketPath);
sock.setEncoding("utf8");

sock.on("connect", () => {
  const ready: RunnerToServerMessage = {
    type: "runner.ready",
    pid: process.pid,
  };
  sock.write(encodeNdjson(ready));

  // Banner in the PTY stream (xterm should show this).
  process.stdout.write(
    [
      "\r\n=== Mock Letta Code Web TUI Runner ===",
      "Type messages in the web composer.",
      "Commands:",
      "  /model        open model overlay",
      "  /toolset      open toolset overlay",
      "  /system       open system overlay",
      "  /mock approval   trigger an approval",
      "  /mock question   trigger AskUserQuestion",
      "\r\n",
    ].join("\r\n"),
  );

  publish(sock);
});

const parse = createNdjsonParser((msg: unknown) => {
  if (!msg || typeof msg !== "object") return;
  const m = msg as ServerToRunnerMessage;

  if (m.type === "runner.submit") {
    const text = m.text.trim();
    process.stdout.write(`\r\n> ${text}\r\n`);

    if (text === "/mock approval") {
      setApprovals([
        {
          toolCallId: "tool_mock_1",
          toolName: "Bash",
          toolArgs: JSON.stringify({
            command: "echo hello",
            description: "mock",
          }),
        },
      ]);
      log(sock, "info", "Triggered approval");
      publish(sock);
      return;
    }

    if (text === "/mock question") {
      setApprovals([
        {
          toolCallId: "tool_question_1",
          toolName: "AskUserQuestion",
          toolArgs: JSON.stringify({ questions: [] }),
        },
      ]);
      publish(sock);
      publishToolUi(sock, {
        type: "runner.tool_ui.state",
        toolCallId: "tool_question_1",
        toolName: "AskUserQuestion",
        state: {
          kind: "ask_user_question",
          payload: {
            questions: [
              {
                header: "POC Help",
                question:
                  "What would you like me to help you with on your web POC project?",
                options: [
                  {
                    label: "Review the plan",
                    description:
                      "Read PLAN_LETTA_CODE_WEB_POC.md and give feedback",
                  },
                  {
                    label: "Explore the code",
                    description:
                      "Look through the poc/ directory and summarize what's there",
                  },
                  {
                    label: "Build something",
                    description: "Start implementing a feature or component",
                  },
                  {
                    label: "Debug an issue",
                    description:
                      "Help troubleshoot a problem you're encountering",
                  },
                ],
                multiSelect: false,
              },
            ],
          },
        },
      });
      process.stdout.write("Asking user questions...\r\n");
      return;
    }

    if (text === "/model") {
      setActiveOverlay("model");
      publish(sock);
      return;
    }

    if (text === "/toolset") {
      setActiveOverlay("toolset");
      publish(sock);
      return;
    }

    if (text === "/system") {
      setActiveOverlay("system");
      publish(sock);
      return;
    }

    process.stdout.write(`echo: ${text}\r\n`);
    return;
  }

  if (m.type === "runner.ui_action") {
    handleUiAction(sock, m.action);
  }

  if (m.type === "runner.tool_ui.event") {
    if (m.event.type === "ask_user_question.submit") {
      process.stdout.write(
        `\r\n[mock] received answers for ${m.toolCallId}: ${JSON.stringify(
          m.event.payload,
        )}\r\n`,
      );
      setApprovals([]);
      publish(sock);
    }
  }
});

sock.on("data", (chunk) => parse(String(chunk)));

sock.on("error", (err) => {
  process.stderr.write(`Runner socket error: ${String(err)}\n`);
  process.exit(1);
});
