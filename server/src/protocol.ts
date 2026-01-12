export type ApprovalRequest = {
  toolCallId: string;
  toolName: string;
  toolArgs: string;
};

export type ActiveOverlay =
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

export type UiOptions = {
  models?: Array<{ id: string; label: string }>;
  toolsets?: Array<{ id: string; label: string }>;
  systemPrompts?: Array<{ id: string; label: string }>;
};

export type UiState = {
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

export type UiAction =
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

export type ClientToServerMessage =
  | {
      type: "session.init";
      config: { apiKey?: string; baseUrl?: string };
    }
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

export type ServerToClientMessage =
  | { type: "terminal.data"; data: string }
  | { type: "ui.state"; state: UiState }
  | {
      type: "ui.tool_ui.state";
      toolCallId: string;
      toolName: string;
      state: { kind: string; payload: unknown };
    }
  | { type: "session.error"; message: string };

export type RunnerMode = "mock" | "letta" | "seam";

export type RunnerToServerMessage =
  | { type: "runner.ready"; pid: number }
  | { type: "runner.ui_state"; state: UiState }
  | {
      type: "runner.tool_ui.state";
      toolCallId: string;
      toolName: string;
      state: { kind: string; payload: unknown };
    }
  | {
      type: "runner.log";
      level: "debug" | "info" | "warn" | "error";
      message: string;
    };

export type ServerToRunnerMessage =
  | { type: "runner.submit"; text: string }
  | { type: "runner.interrupt" }
  | { type: "runner.ui_action"; action: UiAction }
  | {
      type: "runner.tool_ui.event";
      toolCallId: string;
      event: { type: string; payload?: unknown };
    };
