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

export type AgentLifecycleStatus =
  | "classifying"
  | "cloning"
  | "planning"
  | "editing"
  | "validating"
  | "reviewing"
  | "opening_pr"
  | "needs_review"
  | "paused"
  | "completed"
  | "recovered";

export type AgentLifecycleEvent = {
  id: string;
  status: AgentLifecycleStatus;
  message: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  outcome?: "completed" | "failed" | "paused";
};

export type AcceptanceCriterionStatus = "met" | "partial" | "failed" | "unknown";

export type AcceptanceCriterion = {
  id: string;
  description: string;
  status: AcceptanceCriterionStatus;
  evidence?: string;
};

export type ValidationCheckStatus = "passed" | "failed" | "not_run" | "unknown";

export type ValidationCheck = {
  command: string;
  status: ValidationCheckStatus;
  summary: string;
  output?: string;
};

export type AgentReviewResult = {
  status: "approved" | "needs_work" | "unknown";
  summary: string;
  findings: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  validation: ValidationCheck[];
};

export type AgentStopReason =
  | "max_tool_rounds"
  | "provider_error"
  | "validation_failed"
  | "review_failed";

export type AgentRunResponse = {
  provider: AgentProvider;
  model: string;
  text: string;
  toolEvents: AgentToolEvent[];
  status?: "completed" | "paused" | "recovered";
  lifecycleStatus?: AgentLifecycleStatus;
  stopReason?: AgentStopReason;
  maxToolRounds?: number;
  acceptanceCriteria?: AcceptanceCriterion[];
  validation?: ValidationCheck[];
  review?: AgentReviewResult;
};

export type AgentStreamEvent =
  | { type: "lifecycle_event"; event: AgentLifecycleEvent }
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
