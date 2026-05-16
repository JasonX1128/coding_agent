export const DEFAULT_DAEMON_ORIGIN = "http://127.0.0.1:4317";

export type AgentMode = "local" | "github";
export type AgentProvider = "mock" | "openai" | "anthropic" | "google" | "groq";

export type Workspace = {
  id: string;
  rootPath: string;
  createdAt: string;
};

export type ToolStatus = "completed" | "failed" | "requires_approval";

export type ToolResult<T = unknown> = {
  status: ToolStatus;
  summary: string;
  data?: T;
  risk?: "low" | "medium" | "high";
  error?: string;
};

export type AgentToolEvent = {
  id: string;
  name: string;
  args: unknown;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  result: ToolResult;
};

export type AgentToolStartEvent = {
  id: string;
  name: string;
  args: unknown;
  startedAt: number;
};

export type AgentRunResponse = {
  provider: AgentProvider;
  model: string;
  text: string;
  toolEvents: AgentToolEvent[];
};

export type AgentStreamEvent =
  | { type: "tool_started"; event: AgentToolStartEvent }
  | { type: "tool_event"; event: AgentToolEvent }
  | { type: "result"; result: AgentRunResponse }
  | { type: "error"; error: string };

export type ListFilesResult = {
  rootPath: string;
  files: Array<{
    path: string;
    type: "file" | "directory";
    size?: number;
  }>;
};

export type ReadFileResult = {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
};

export type SearchResult = {
  query: string;
  matches: Array<{
    path: string;
    line: number;
    column: number;
    text: string;
  }>;
};

export type GitResult = {
  operation: "status" | "diff" | "log";
  output: string;
};

export type PatchResult = {
  changedFiles: string[];
};

export type ReplaceTextResult = {
  path: string;
  replacements: number;
  bytes: number;
};

export type CreateFileResult = {
  path: string;
  bytes: number;
};

export type CommandResult = {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type DaemonToolName =
  | "list_files"
  | "read_file"
  | "search_text"
  | "git_status"
  | "git_diff"
  | "create_file"
  | "replace_text"
  | "apply_patch"
  | "run_command";
