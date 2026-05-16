# Codex/Claude Code-Style Development Agent Plan

## Goal

Build an LLM-powered development system with two first-class modes:

1. A local development interface that can inspect, edit, run, and test code on a user's machine.
2. A web-based GitHub agent that can be pointed at a repository, work in an isolated environment, and return a pull request or review.

The product should feel like a practical coding agent rather than a generic chatbot: repo-aware, diff-aware, terminal-aware, resumable, permissioned, and clear about what it is doing.

## Core Product Requirements

- Chat-driven coding workflow with streaming model output and tool events.
- Repo/file explorer with search, jump-to-file, and selected context.
- Diff viewer with accept/reject controls.
- Terminal/test output pane.
- Background task execution with resumable logs.
- Provider abstraction for OpenAI, Anthropic, and eventually local/open-source models.
- Local filesystem access through a trusted local daemon or desktop shell.
- Hosted GitHub access through a GitHub App and disposable workers.
- Branch-per-task workflow for hosted work.
- Explicit approval gates for risky local operations.
- Full audit trail of file reads, writes, commands, commits, and PR actions.

## Design Principles

### Standard Or Replaceable

Every major technical choice should be either:

- an industry-standard option with broad hiring/library/community support, or
- a thin, replaceable layer around a less-standard choice.

This keeps the product from becoming trapped behind niche tools. For example, using Tauri for a desktop shell is acceptable if the local daemon is plain Node.js and can later be wrapped by Electron, VS Code, or a CLI without changing the agent core.

### Tool-Brokered Access

The LLM should never directly access files, shells, tokens, or GitHub credentials. The model requests tools. The app validates policy, executes the tool, redacts sensitive output, and returns a compact result.

### Separate Trust Boundaries

Local development and hosted GitHub automation should share agent logic, but not execution privileges:

- Local mode runs against a user-approved workspace on the user's machine.
- Hosted mode runs in disposable, isolated cloud workers with short-lived GitHub installation tokens.

### Diff-First Development

The agent should prefer small, reviewable patches. A user should always be able to see what changed, why it changed, and what was run to verify it.

## Recommended Tech Stack

| Area | Recommended Choice | Why This Choice | Industry Standard / Replacement Path |
| --- | --- | --- | --- |
| Language | TypeScript | Strong fit for web, backend, desktop glue, LLM tool schemas, GitHub APIs, and shared packages. | Industry standard. Can add Python workers later for ML/sandbox tasks. |
| Monorepo | pnpm workspaces + Turborepo | Fast, common in TypeScript app monorepos, easy package boundaries. | pnpm is common; npm/yarn can replace it. Turborepo can be replaced by Nx or plain scripts. |
| Web UI | Next.js + React | Mature full-stack web framework, large ecosystem, good routing and deployment options. | Industry standard. Remix, React Router, or Vite SPA could replace with limited backend changes. |
| UI Components | Tailwind CSS + shadcn/ui | Fast development, accessible primitives through Radix, easy customization. | Tailwind is industry standard. shadcn/ui is source-owned component code, so replacing it is manageable. |
| Code Editor | Monaco Editor | Mature browser code editor used by VS Code. | Industry standard for web-based code editing. CodeMirror is the main replacement option. |
| Terminal | xterm.js | Standard web terminal component. | Industry standard. Can replace with custom terminal renderer only if needed. |
| Local Desktop Shell | Tauri first, Electron as fallback | Tauri is lighter and secure-by-default; Electron has broader ecosystem and simpler Node integration. | Electron is the industry-standard fallback. Keep local daemon separate so wrapper can change. |
| Local Daemon | Node.js + Fastify + WebSocket/SSE | Simple cross-platform service for file, git, terminal, and tool execution. | Node.js is standard. Fastify can be replaced by Express/NestJS/Hono. |
| Shell PTY | node-pty | Common library for interactive terminal sessions. | Standard in JS desktop/web terminal stacks. Can isolate behind terminal service interface. |
| File Watcher | chokidar | Widely used cross-platform file watching. | Standard enough. Can replace with native watchers later. |
| Search | ripgrep invoked by daemon | Fast, standard developer search tool. | Industry standard CLI. Can fallback to JS search or Tantivy later. |
| Git Library | simple-git + direct git CLI | `git` CLI is the source of truth; simple-git handles common flows. | Git CLI is industry standard. simple-git can be replaced with isomorphic-git/libgit2. |
| Backend API | Fastify or NestJS | Fastify is lean; NestJS is more structured for larger teams. | Both are common. Start Fastify; migrate to NestJS if app domain grows. |
| Database | Postgres | Durable relational data for users, tasks, repos, logs, permissions. | Industry standard. |
| ORM | Drizzle or Prisma | Drizzle is lightweight and SQL-friendly; Prisma is widely adopted with excellent tooling. | Both are mainstream. Choose one per team preference. |
| Queue | BullMQ + Redis | Simple background jobs, retries, progress events. | Common Node stack. Can migrate to Temporal for durable long-running workflows. |
| Workflow Engine | Defer until needed; Temporal later | Avoid early complexity. Use queues first. | Temporal is the industry-standard upgrade for complex workflows. |
| Hosted Sandbox | Docker containers for MVP | Easy to build, debug, and run locally/cloud. | Industry standard. Later upgrade to gVisor, Firecracker, Kubernetes Jobs, or managed sandboxes. |
| Object Storage | S3-compatible storage | Store logs, artifacts, patches, test outputs. | Industry standard. Works with AWS S3, R2, GCS-compatible layers, MinIO. |
| Authentication | Auth.js or Clerk | Auth.js is open and flexible; Clerk is faster SaaS. | OAuth/OIDC based, replaceable. |
| GitHub Access | GitHub App + Octokit | Fine-grained permissions, installation tokens, PR automation. | Industry standard for GitHub integrations. |
| LLM Providers | OpenAI Responses API + Anthropic Messages API | Both support tool-use patterns needed for coding agents. | Provider adapters isolate vendor APIs. Can add Google, local vLLM, Ollama, LiteLLM. |
| Observability | OpenTelemetry + structured logs | Portable traces/metrics/logs. | Industry standard. Export to Datadog, Grafana, Honeycomb, or CloudWatch. |
| Secrets | Cloud KMS/Secret Manager + local OS keychain | Avoid `.env` sprawl and model-visible credentials. | Industry standard. |
| Testing | Vitest, Playwright, integration sandbox tests | Fast unit tests, real browser tests, end-to-end agent loop tests. | Industry standard for TS web apps. |

## Repository Layout

```text
apps/
  web/                  # Hosted web UI and shared browser experience
  desktop/              # Tauri or Electron wrapper
  local-daemon/         # Local filesystem, shell, git, and tool server
  api/                  # Backend API, auth, billing, orchestration

packages/
  agent-core/           # Provider-neutral agent loop and task state machine
  agent-tools/          # Tool schemas and shared tool result types
  providers/            # OpenAI, Anthropic, and future model adapters
  policy/               # Permission checks, path checks, command risk scoring
  patches/              # Diff parsing, patch apply helpers, conflict handling
  repo-index/           # File indexing, summaries, symbols, embeddings later
  ui/                   # Shared UI components
  config/               # Shared lint, tsconfig, env schema

workers/
  github-agent/         # Hosted worker that clones repos and runs tasks
  cleanup/              # Artifact, sandbox, and token cleanup jobs

docs/
  architecture.md
  security.md
  github-app.md
  local-daemon.md
```

## Major Components

### 1. Web UI

The web UI is the control surface for both local and hosted work.

Primary views:

- Task/chat timeline.
- Repository explorer.
- Search panel.
- Monaco file viewer/editor.
- Diff review.
- Terminal/test output.
- Agent plan and checklist.
- GitHub PR status.
- Settings for model, approval policy, and workspace/repo access.

The UI should render agent activity as structured events, not only prose:

```text
planning.started
tool.read_file.requested
tool.read_file.completed
tool.apply_patch.requested
approval.required
command.started
command.output
tests.completed
pull_request.created
```

This makes the product debuggable and lets users trust the agent.

### 2. Local Desktop App

The desktop app exists to make local development feel native:

- Start and stop the local daemon.
- Pair browser UI with daemon using a local token.
- Select approved workspaces.
- Store local credentials in the OS keychain.
- Provide notifications for long-running tasks.
- Optionally expose a local menu bar/tray agent.

Tauri is a good first choice because the local daemon can do most privileged work and the desktop shell can remain thin. If Tauri becomes a limitation, Electron can replace it without changing the daemon, API, or agent core.

### 3. Local Daemon

The local daemon is the only component allowed to touch local files and shells.

It should bind to loopback only:

```text
127.0.0.1:<dynamic-port>
```

Startup flow:

1. User starts desktop app or CLI.
2. Daemon generates a short-lived pairing token.
3. UI connects over WebSocket/SSE.
4. User selects one or more allowed workspace roots.
5. Daemon records workspace grants locally.

Local daemon capabilities:

- File tree listing.
- Read file ranges.
- Write via patch only.
- Search with ripgrep.
- Git status, diff, branch, commit metadata.
- Terminal sessions through `node-pty`.
- Run command with timeout and approval policy.
- Detect package manager and test commands.
- Watch file changes.

The browser should not receive direct filesystem privileges. It should ask the daemon to perform scoped operations.

### 4. Backend API

The backend coordinates identity, hosted tasks, GitHub installations, logs, and billing.

Responsibilities:

- User auth and sessions.
- GitHub App installation management.
- Project/repo records.
- Agent task creation and status.
- Queueing hosted work.
- Streaming task events to UI.
- Storing logs, patches, summaries, and artifact references.
- Issuing short-lived signed URLs for artifacts.
- Enforcing organization-level policies.

### 5. Agent Core

The agent core is provider-neutral. It knows how to:

- Maintain task state.
- Build compact context.
- Register tools.
- Validate tool calls.
- Execute tool calls through an environment adapter.
- Summarize progress.
- Decide when to ask for approval.
- Decide when to stop.

It should not know whether files are local or in a hosted GitHub sandbox. It talks to an `AgentEnvironment` interface.

```ts
interface AgentEnvironment {
  readFile(path: string, range?: LineRange): Promise<ToolResult>;
  search(query: SearchQuery): Promise<ToolResult>;
  applyPatch(patch: UnifiedPatch): Promise<ToolResult>;
  runCommand(command: CommandRequest): Promise<ToolResult>;
  git(operation: GitRequest): Promise<ToolResult>;
}
```

### 6. Provider Adapters

Provider adapters translate the internal agent loop into vendor-specific calls.

OpenAI adapter:

- Use Responses API.
- Use function tools for local app tools.
- Stream output and tool calls.
- Keep conversation state through provider state or internal compacted history.

Anthropic adapter:

- Use Messages API with tool use.
- Execute client tools in the application.
- Return tool results to Claude.

Future adapters:

- Google Gemini.
- Local models through Ollama.
- vLLM or OpenAI-compatible endpoints.
- LiteLLM as an optional routing layer, if direct provider adapters become expensive to maintain.

The internal tool schemas should remain stable even if provider schemas differ.

## Local File Access Plan

### Workspace Grants

Users explicitly grant access to a directory. The daemon stores grants like:

```json
{
  "workspaceId": "ws_123",
  "rootPath": "/Users/alex/projects/my-app",
  "createdAt": "2026-05-14T00:00:00Z",
  "permissions": {
    "read": true,
    "write": true,
    "shell": "approval-required"
  }
}
```

All tool requests must resolve inside an approved workspace.

Path checks:

- Normalize path.
- Resolve symlinks.
- Reject paths outside workspace root.
- Reject hidden sensitive files by default unless explicitly approved.
- Redact common secret patterns from tool output.

### Read Operations

Allowed by default inside approved workspace:

- list files
- read selected file ranges
- search text
- read git metadata
- read dependency manifests

Read output should be truncated and range-based to avoid sending entire repos into model context.

### Write Operations

Writes should go through patch application, not arbitrary full-file replacement by default.

Write flow:

1. Model proposes patch.
2. Patch engine validates target files are inside workspace.
3. App displays diff if user policy requires approval.
4. Daemon applies patch.
5. Daemon returns changed files and any conflicts.

Direct full-file writes can exist for new files and generated lockstep artifacts, but patch-first is safer.

### Shell Operations

Commands are risk-scored before execution.

Low risk:

- `npm test`
- `pnpm test`
- `pytest`
- `cargo test`
- `go test ./...`
- `rg`
- `ls`
- `git diff`

Medium risk:

- dependency installs
- formatters that rewrite many files
- migrations against local databases

High risk:

- `rm`
- `sudo`
- shell scripts from remote URLs
- `curl | sh`
- Docker socket access
- credential commands
- `git push`

Policy options:

- Ask every time.
- Auto-approve reads and tests.
- Auto-approve commands matching user-configured allowlist.
- Never allow high-risk commands without explicit confirmation.

## GitHub Access Plan

### GitHub App

Hosted repo access should use a GitHub App instead of personal access tokens.

Required permissions for MVP:

- Metadata: read
- Contents: read/write
- Pull requests: read/write
- Issues: read/write, optional but useful for task context
- Checks/statuses: read, optional for CI status

Avoid requesting broad organization permissions until needed.

### Installation Flow

1. User signs into the app.
2. User installs the GitHub App on selected repositories.
3. GitHub redirects back with installation information.
4. Backend stores installation ID and selected repo IDs.
5. Worker mints short-lived installation tokens only when a task starts.

### Hosted Worker Flow

1. User creates task for `owner/repo`.
2. API validates user can access that installation/repo.
3. API enqueues job.
4. Worker starts disposable sandbox.
5. Worker mints installation token.
6. Worker clones repo:

```text
git clone https://x-access-token:<token>@github.com/owner/repo.git
```

7. Worker checks out a new branch:

```text
agent/<task-slug>-<date>
```

8. Agent indexes repo and runs task.
9. Worker runs verification.
10. Worker commits changes.
11. Worker pushes branch.
12. API opens PR.
13. Worker destroys sandbox.

### Hosted Sandbox

MVP sandbox:

- Docker container per task.
- No shared filesystem across tasks.
- CPU/memory/time limits.
- Read-only base image.
- Network egress allowed initially, then restricted by policy.
- Secrets mounted only as short-lived environment variables.
- Automatic cleanup after completion or timeout.

Upgrade path:

- Kubernetes Jobs for scale.
- gVisor for stronger container isolation.
- Firecracker microVMs for higher-trust multitenant execution.
- Dedicated runners for enterprise customers.

## Agent Tool Set

### Read Tools

- `list_files`
- `read_file`
- `search_text`
- `get_symbols`
- `git_status`
- `git_diff`
- `git_log`
- `read_package_manifest`
- `read_test_config`

### Write Tools

- `apply_patch`
- `create_file`
- `replace_text`
- `delete_file`
- `format_files`
- `update_dependency_manifest`

### Execution Tools

- `run_command`
- `run_tests`
- `run_linter`
- `run_typecheck`
- `start_dev_server`
- `stop_process`

### GitHub Tools

- `fetch_issue`
- `fetch_pull_request`
- `list_pull_request_files`
- `comment_on_issue`
- `create_branch`
- `push_commit`
- `open_pull_request`
- `update_pull_request`
- `read_check_runs`

### Internal Tools

- `summarize_context`
- `record_repo_convention`
- `retrieve_repo_memory`
- `estimate_risk`
- `request_user_approval`

## Agent Loop

```text
User request
  -> classify task
  -> gather repo context
  -> produce short plan
  -> run read/search tools
  -> edit via patch
  -> inspect diff
  -> run verification
  -> iterate if needed
  -> summarize changes
  -> local: leave working tree ready
  -> hosted: open PR
```

The loop should preserve a structured task state:

```ts
type AgentTaskState =
  | "queued"
  | "planning"
  | "reading"
  | "editing"
  | "waiting_for_approval"
  | "running_commands"
  | "verifying"
  | "creating_pr"
  | "completed"
  | "failed"
  | "cancelled";
```

## Context Strategy

Do not dump the repository into the model.

Use layered context:

1. User request.
2. Current repo metadata.
3. Relevant file snippets.
4. Search results.
5. Dependency/test configuration.
6. Existing diff.
7. Recent tool outputs.
8. Persisted repo conventions.

Context compaction:

- Summarize long terminal outputs.
- Preserve exact failing test lines.
- Preserve exact compiler errors.
- Preserve file paths and line numbers.
- Drop repetitive logs.

Embeddings can be added later, but MVP should rely on `ripgrep`, filenames, import graphs, and model-directed search. This keeps the initial system simple and debuggable.

## Data Model

Core tables:

```text
users
organizations
projects
github_installations
github_repositories
local_workspaces
agent_tasks
agent_events
agent_tool_calls
agent_artifacts
pull_requests
repo_memories
approval_policies
```

Important records:

```ts
type AgentTask = {
  id: string;
  userId: string;
  projectId: string;
  mode: "local" | "github";
  provider: "openai" | "anthropic";
  model: string;
  status: AgentTaskState;
  userPrompt: string;
  branchName?: string;
  pullRequestUrl?: string;
  createdAt: string;
  updatedAt: string;
};
```

```ts
type AgentToolCall = {
  id: string;
  taskId: string;
  toolName: string;
  argumentsJson: unknown;
  resultSummary: string;
  status: "requested" | "approved" | "rejected" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
};
```

## API Surface

### Backend API

```text
POST   /api/tasks
GET    /api/tasks/:taskId
GET    /api/tasks/:taskId/events
POST   /api/tasks/:taskId/cancel
POST   /api/tasks/:taskId/approve
POST   /api/github/installations/sync
GET    /api/github/repositories
POST   /api/github/repositories/:repoId/tasks
```

### Local Daemon API

```text
POST   /pair
GET    /workspaces
POST   /workspaces
GET    /workspaces/:id/files
POST   /tools/read_file
POST   /tools/search
POST   /tools/apply_patch
POST   /tools/run_command
POST   /tools/git
GET    /events
```

Use WebSocket or SSE for streaming task and command output. SSE is simpler for one-way event streams; WebSocket is better for interactive terminal sessions.

## Security Plan

### Secrets Handling

- Never send raw secrets to model providers.
- Redact `.env`, tokens, private keys, and common credential patterns.
- Store cloud secrets in KMS/Secret Manager.
- Store local tokens in OS keychain.
- Use short-lived GitHub installation tokens.
- Keep provider API keys server-side or local-only depending on mode.

### Prompt Injection Defense

Repo contents, issues, PR comments, and docs are untrusted input. The agent should treat instructions inside them as data unless explicitly elevated by the user.

Examples of untrusted instructions:

- "Ignore previous instructions."
- "Exfiltrate environment variables."
- "Run this curl command."
- "Delete the repo."

Mitigations:

- Tool policy layer independent from model.
- Command approval gates.
- Secret redaction.
- No credential-bearing tool output.
- User-visible plan and diff.
- Sandboxed hosted execution.

### Auditability

Record:

- every file read
- every patch
- every command
- every approval
- every commit
- every PR/comment action

This helps debugging, billing, enterprise controls, and user trust.

## UI Plan

### Main Local Development Screen

Layout:

- Left sidebar: workspaces, file tree, search.
- Center: chat/task timeline and current plan.
- Right or bottom: diff/editor/terminal tabs.

Important controls:

- Model selector.
- Approval policy selector.
- Stop task button.
- Apply/revert patch controls.
- Open in editor button.
- Run tests button.

### Main GitHub Agent Screen

Layout:

- Repo selector.
- Task prompt.
- Branch/PR status.
- Timeline of agent actions.
- Diff viewer.
- Test/check output.
- PR creation result.

The GitHub flow should optimize for async work: users can leave and return later.

## MVP Scope

### MVP 1: Local Read/Write Agent

Deliver:

- Next.js UI.
- Local daemon.
- Workspace selection.
- Chat with OpenAI or Anthropic.
- File tree.
- File read.
- Search.
- Patch apply.
- Git diff.
- Basic approval UI.

Success criteria:

- User can ask for a small code change.
- Agent can inspect files, edit, and show a diff.
- User can approve or reject writes.

### MVP 2: Local Execution

Deliver:

- Terminal command tool.
- Test/lint/typecheck detection.
- Command output streaming.
- Command approval policy.
- Task cancellation.

Success criteria:

- Agent can make a change and run the relevant tests locally.

### MVP 3: GitHub Read-Only Agent

Deliver:

- Auth.
- GitHub App install.
- Repo listing.
- Hosted worker.
- Clone repo in sandbox.
- Read/search/analyze repo.
- Produce plan or review without writing.

Success criteria:

- User can point agent at a GitHub repo and get a useful analysis.

### MVP 4: GitHub PR Agent

Deliver:

- Branch creation.
- Patch application in sandbox.
- Test execution.
- Commit.
- Push.
- Open pull request.
- PR summary with verification notes.

Success criteria:

- User can ask the hosted agent to fix an issue and receive a PR.

### MVP 5: Reliability And Team Features

Deliver:

- Persistent task logs.
- Retry failed hosted jobs.
- Repo memory.
- Organization policy controls.
- Billing/cost tracking.
- Better sandbox isolation.

Success criteria:

- The app is usable by a small team on real repositories.

## Replacement Strategy

Keep these boundaries stable:

- `AgentProvider` for model APIs.
- `AgentEnvironment` for local vs hosted execution.
- `ToolRegistry` for tools.
- `PolicyEngine` for safety checks.
- `PatchEngine` for file edits.
- `TaskEventStream` for UI updates.

This allows replacements without rewriting the product:

- Tauri -> Electron or VS Code extension.
- Fastify -> NestJS.
- BullMQ -> Temporal.
- Docker -> Firecracker/gVisor.
- OpenAI/Anthropic -> any provider adapter.
- Monaco -> CodeMirror.
- Drizzle -> Prisma.
- S3 -> any object storage provider.

## Key Risks

### Local Security

Risk: agent can damage user files or run dangerous commands.

Mitigation: workspace scoping, patch-first writes, approval policy, command risk scoring, audit logs.

### Hosted Sandbox Escape Or Secret Leak

Risk: untrusted repo code can access secrets or infrastructure.

Mitigation: ephemeral containers, short-lived tokens, limited permissions, egress controls, stronger isolation over time.

### Prompt Injection

Risk: malicious repo content tricks the agent.

Mitigation: treat repo text as untrusted, enforce policy outside the model, redact secrets, require approval for risky tools.

### Provider Lock-In

Risk: app becomes tied to one LLM API.

Mitigation: provider adapters and stable internal tool schemas.

### Cost And Latency

Risk: long tasks become expensive and slow.

Mitigation: compact context, cache repo summaries, prefer search over embedding everything, add smaller model tiers.

### Diff Quality

Risk: agent makes broad or hard-to-review edits.

Mitigation: patch-size limits, plan-first flow, formatting discipline, tests, user review controls.

## Near-Term Implementation Order

1. Create monorepo and shared TypeScript config.
2. Build `agent-core` with a fake provider and fake environment.
3. Build local daemon file/search/git tools.
4. Build web UI task timeline and diff viewer.
5. Connect one real provider adapter.
6. Add patch apply and approval flow.
7. Add terminal/test command execution.
8. Add backend API and database.
9. Add GitHub App installation flow.
10. Add hosted Docker worker.
11. Add PR creation.
12. Harden sandbox, redaction, and audit logs.

## Documentation References

- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses
- OpenAI function calling: https://platform.openai.com/docs/guides/function-calling
- Anthropic tool use: https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
- GitHub App REST API: https://docs.github.com/en/rest/apps/apps
- GitHub App installation authentication: https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation
