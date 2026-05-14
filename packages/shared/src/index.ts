export const DEFAULT_DAEMON_ORIGIN = "http://127.0.0.1:4317";

export type AgentMode = "local" | "github";
export type AgentProvider = "mock" | "openai" | "anthropic";

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
  result: ToolResult;
};

export type AgentRunResponse = {
  provider: AgentProvider;
  model: string;
  text: string;
  toolEvents: AgentToolEvent[];
};

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
  | "apply_patch"
  | "run_command";

