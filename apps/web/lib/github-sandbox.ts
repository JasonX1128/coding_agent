import { runAgentTask, type ToolExecutor } from "@coding-agent/agent-core";
import type {
  AgentProvider,
  AgentToolEvent,
  AgentToolStartEvent,
  AgentRunResponse,
  CommandResult,
  CreateFileResult,
  DaemonToolName,
  GitResult,
  ListFilesResult,
  PatchResult,
  ReadFileResult,
  SearchResult,
  ToolResult
} from "@coding-agent/shared";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  createInstallationToken,
  findInstalledRepository,
  openPullRequest
} from "./github-app";

export type GitHubTaskMode = "auto" | "read" | "write";
type ResolvedGitHubTaskMode = Exclude<GitHubTaskMode, "auto">;

export type GitHubRepositoryTaskRequest = {
  installationId: number;
  repoFullName: string;
  prompt: string;
  provider: AgentProvider;
  model?: string;
  mode?: GitHubTaskMode;
  onToolStart?: (event: AgentToolStartEvent) => void | Promise<void>;
  onToolEvent?: (event: AgentToolEvent) => void | Promise<void>;
};

export type GitHubRepositoryTaskResult = AgentRunResponse & {
  repository: string;
  mode: ResolvedGitHubTaskMode;
  branchName?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  changedFiles: string[];
  sandboxRoot: string;
};

const skippedDirectories = new Set([".git", "node_modules", ".next", "dist", "coverage", ".turbo"]);
const maxOutputBytes = 200_000;

export async function runGitHubRepositoryTask(request: GitHubRepositoryTaskRequest): Promise<GitHubRepositoryTaskResult> {
  const repo = await findInstalledRepository(request.repoFullName, request.installationId);
  const installationToken = await createInstallationToken(repo.installationId);
  const sandboxRoot = await createSandboxRoot();
  const cloneUrl = tokenizedCloneUrl(repo.fullName, installationToken.token);
  const mode = resolveGitHubTaskMode(request.prompt, request.mode || "auto");
  const branchName = mode === "write" ? createAgentBranchName(request.prompt) : undefined;

  await runRequired("git", ["clone", "--depth", "1", cloneUrl, sandboxRoot], process.cwd(), 120_000, installationToken.token);
  await runRequired("git", ["remote", "set-url", "origin", `https://github.com/${repo.fullName}.git`], sandboxRoot, 20_000);
  if (mode === "write" && branchName) {
    await runRequired("git", ["checkout", "-b", branchName], sandboxRoot, 20_000);
    await runRequired("git", ["config", "user.name", `${process.env.GITHUB_APP_SLUG || "coding-agent"}[bot]`], sandboxRoot, 20_000);
    await runRequired(
      "git",
      ["config", "user.email", `${process.env.GITHUB_APP_ID || "0"}+${process.env.GITHUB_APP_SLUG || "coding-agent"}[bot]@users.noreply.github.com`],
      sandboxRoot,
      20_000
    );
  }

  const rootPath = await realpath(sandboxRoot);
  const executor = mode === "write" ? createWritableSandboxExecutor(rootPath) : createReadOnlySandboxExecutor(rootPath);
  const result = await runAgentTask({
    provider: request.provider,
    model: request.model,
    prompt: buildRepositoryPrompt(repo.fullName, repo.defaultBranch, branchName, mode, request.prompt),
    executor,
    maxToolRounds: 12,
    onToolStart: request.onToolStart,
    onToolEvent: request.onToolEvent
  });

  const changedFiles = await changedFileNames(rootPath);
  const committableFiles = await committableChangedFileNames(rootPath, changedFiles);
  if (mode === "read") {
    return {
      ...result,
      repository: repo.fullName,
      mode,
      changedFiles: [],
      sandboxRoot
    };
  }

  if (committableFiles.length === 0) {
    return {
      ...result,
      repository: repo.fullName,
      mode,
      branchName,
      changedFiles: committableFiles,
      sandboxRoot,
      text: `${result.text}\n\nNo non-empty file changes were produced, so no pull request was opened.`
    };
  }

  if (!branchName) throw new Error("Write-mode GitHub task did not create a working branch.");

  await runRequired("git", ["add", "-A", "--", ...committableFiles], rootPath, 20_000);
  await runRequired("git", ["commit", "-m", commitTitle(request.prompt)], rootPath, 60_000);
  await runRequired(
    "git",
    ["push", tokenizedCloneUrl(repo.fullName, installationToken.token), `HEAD:${branchName}`],
    rootPath,
    120_000,
    installationToken.token
  );

  const pullRequest = await openPullRequest({
    installationId: repo.installationId,
    repoFullName: repo.fullName,
    title: prTitle(request.prompt),
    body: prBody(request.prompt, result, committableFiles),
    head: branchName,
    base: repo.defaultBranch
  });

  return {
    ...result,
    repository: repo.fullName,
    mode,
    branchName,
    pullRequestUrl: pullRequest.htmlUrl,
    pullRequestNumber: pullRequest.number,
    changedFiles: committableFiles,
    sandboxRoot
  };
}

function createReadOnlySandboxExecutor(rootPath: string): ToolExecutor {
  return async (name: DaemonToolName, args: Record<string, unknown>) => {
    try {
      if (name === "list_files") return listFilesTool(rootPath, args);
      if (name === "read_file") return readFileTool(rootPath, args);
      if (name === "search_text") return searchTool(rootPath, args);
      if (name === "git_status") return gitTool(rootPath, "status");
      if (name === "git_diff") return gitTool(rootPath, "diff");
      return toolResult("requires_approval", `${name} is disabled because this prompt is running in read-only repository mode.`, undefined, "medium");
    } catch (error) {
      return toolResult("failed", error instanceof Error ? error.message : "Unknown sandbox tool error");
    }
  };
}

function createWritableSandboxExecutor(rootPath: string): ToolExecutor {
  return async (name: DaemonToolName, args: Record<string, unknown>) => {
    try {
      if (name === "list_files") return listFilesTool(rootPath, args);
      if (name === "read_file") return readFileTool(rootPath, args);
      if (name === "search_text") return searchTool(rootPath, args);
      if (name === "git_status") return gitTool(rootPath, "status");
      if (name === "git_diff") return gitTool(rootPath, "diff");
      if (name === "create_file") return createFileTool(rootPath, args);
      if (name === "apply_patch") return applyPatchTool(rootPath, args);
      if (name === "run_command") return runCommandTool(rootPath, args);
      return toolResult("failed", `Unsupported tool: ${name}`);
    } catch (error) {
      return toolResult("failed", error instanceof Error ? error.message : "Unknown sandbox tool error");
    }
  };
}

async function listFilesTool(rootPath: string, args: Record<string, unknown>): Promise<ToolResult<ListFilesResult>> {
  const requestedPath = typeof args.path === "string" ? args.path : ".";
  const maxFiles = typeof args.maxFiles === "number" ? Math.min(args.maxFiles, 500) : 160;
  const directory = await resolveSandboxPath(rootPath, requestedPath);
  const files = await listFiles(rootPath, directory, maxFiles);
  return toolResult("completed", `Listed ${files.length} entries.`, { rootPath, files });
}

async function readFileTool(rootPath: string, args: Record<string, unknown>): Promise<ToolResult<ReadFileResult>> {
  const requestedPath = typeof args.path === "string" ? args.path : "";
  if (!requestedPath) return toolResult("failed", "Missing file path.");
  const absolutePath = await resolveSandboxPath(rootPath, requestedPath);
  const content = await readFile(absolutePath, "utf8");
  const lines = content.split(/\r?\n/);
  const startLine = typeof args.startLine === "number" ? Math.max(1, args.startLine) : 1;
  const endLine = typeof args.endLine === "number"
    ? Math.min(lines.length, args.endLine)
    : Math.min(lines.length, startLine + 240);
  return toolResult("completed", `Read ${requestedPath}:${startLine}-${endLine}.`, {
    path: requestedPath,
    startLine,
    endLine,
    totalLines: lines.length,
    content: lines.slice(startLine - 1, endLine).join("\n")
  });
}

async function searchTool(rootPath: string, args: Record<string, unknown>): Promise<ToolResult<SearchResult>> {
  const query = typeof args.query === "string" ? args.query : "";
  if (!query) return toolResult("failed", "Missing search query.");
  const rg = await runProcess("rg", ["--line-number", "--column", "--no-heading", "--color", "never", query, "."], rootPath, 30_000);
  const maxResults = typeof args.maxResults === "number" ? Math.min(args.maxResults, 300) : 100;
  const matches = rg.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, maxResults)
    .map((line) => {
      const [filePath = "", lineNumber = "0", column = "0", ...textParts] = line.split(":");
      return {
        path: filePath,
        line: Number(lineNumber),
        column: Number(column),
        text: textParts.join(":")
      };
    });
  return toolResult("completed", `Found ${matches.length} matches.`, { query, matches });
}

async function gitTool(rootPath: string, operation: "status" | "diff"): Promise<ToolResult<GitResult>> {
  const args = operation === "status" ? ["status", "--short"] : ["diff", "--", "."];
  const git = await runProcess("git", args, rootPath, 20_000);
  const output = git.stdout || git.stderr;
  return toolResult(git.exitCode === 0 ? "completed" : "failed", `${operation} ${git.exitCode === 0 ? "completed" : "failed"}.`, {
    operation,
    output
  });
}

async function applyPatchTool(rootPath: string, args: Record<string, unknown>): Promise<ToolResult<PatchResult>> {
  const patch = typeof args.patch === "string" ? args.patch : "";
  if (!patch.trim()) return toolResult<PatchResult>("failed", "Missing patch.");
  const applied = await runProcess("git", ["apply", "--whitespace=nowarn", "-"], rootPath, 20_000, patch);
  if (applied.exitCode !== 0) {
    return toolResult<PatchResult>("failed", applied.stderr || "Patch failed to apply.", undefined, "medium");
  }
  const changedFiles = await changedFileNames(rootPath);
  return toolResult("completed", `Applied patch to ${changedFiles.length} file(s).`, { changedFiles });
}

async function createFileTool(rootPath: string, args: Record<string, unknown>): Promise<ToolResult<CreateFileResult>> {
  const requestedPath = typeof args.path === "string" ? args.path : "";
  const content = typeof args.content === "string" ? args.content : "";
  const overwrite = args.overwrite === true;
  const allowEmpty = args.allowEmpty === true;

  if (!requestedPath) return toolResult<CreateFileResult>("failed", "Missing file path.");
  if (!allowEmpty && content.length === 0) {
    return toolResult<CreateFileResult>("failed", "Refusing to create an empty file without allowEmpty=true.");
  }

  const absolutePath = await resolveSandboxPath(rootPath, requestedPath);
  if (existsSync(absolutePath) && !overwrite) {
    return toolResult<CreateFileResult>("failed", "File already exists. Use apply_patch for edits, or overwrite=true only when replacing it intentionally.");
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return toolResult("completed", `Created ${requestedPath}.`, {
    path: requestedPath,
    bytes: Buffer.byteLength(content, "utf8")
  });
}

async function runCommandTool(rootPath: string, args: Record<string, unknown>): Promise<ToolResult<CommandResult>> {
  const command = typeof args.command === "string" ? args.command : "";
  if (!command) return toolResult<CommandResult>("failed", "Missing command.");
  const risk = scoreCommandRisk(command);
  if (risk === "high") {
    return toolResult<CommandResult>("requires_approval", "High-risk commands are blocked in GitHub App sandboxes.", undefined, risk);
  }

  const startedAt = Date.now();
  const result = await runProcess(command, [], rootPath, 60_000, undefined, true);
  return toolResult(result.exitCode === 0 ? "completed" : "failed", `Command exited with code ${result.exitCode}.`, {
    command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - startedAt
  }, risk);
}

async function createSandboxRoot(): Promise<string> {
  const base = process.env.AGENT_SANDBOX_ROOT || path.resolve(repoRoot(), ".agent-sandboxes");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, "github-pr-"));
}

async function resolveSandboxPath(rootPath: string, relativePath: string): Promise<string> {
  const absolute = path.resolve(rootPath, relativePath);
  const rootWithSeparator = `${rootPath}${path.sep}`;
  if (absolute !== rootPath && !absolute.startsWith(rootWithSeparator)) {
    throw new Error("Path escapes sandbox root.");
  }
  if (existsSync(absolute)) {
    const resolved = await realpath(absolute);
    if (resolved !== rootPath && !resolved.startsWith(rootWithSeparator)) {
      throw new Error("Path resolves outside sandbox root.");
    }
    return resolved;
  }
  return absolute;
}

async function listFiles(rootPath: string, directory: string, maxFiles: number): Promise<ListFilesResult["files"]> {
  const files: ListFilesResult["files"] = [];
  const queue = [directory];

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    if (!current) break;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(rootPath, absolute) || ".";
      if (entry.isDirectory()) {
        files.push({ path: relative, type: "directory" });
        queue.push(absolute);
      } else if (entry.isFile()) {
        const info = await stat(absolute);
        files.push({ path: relative, type: "file", size: info.size });
      }
    }
  }

  return files;
}

async function changedFileNames(rootPath: string): Promise<string[]> {
  const diff = await runProcess("git", ["diff", "--name-only"], rootPath, 20_000);
  const staged = await runProcess("git", ["diff", "--cached", "--name-only"], rootPath, 20_000);
  const untracked = await runProcess("git", ["ls-files", "--others", "--exclude-standard"], rootPath, 20_000);
  return [...new Set([...diff.stdout.split(/\r?\n/), ...staged.stdout.split(/\r?\n/), ...untracked.stdout.split(/\r?\n/)].filter(Boolean))];
}

async function committableChangedFileNames(rootPath: string, changedFiles: string[]): Promise<string[]> {
  const result: string[] = [];
  for (const file of changedFiles) {
    const absolutePath = await resolveSandboxPath(rootPath, file);
    if (!existsSync(absolutePath)) {
      result.push(file);
      continue;
    }
    const info = await stat(absolutePath);
    if (info.isDirectory()) continue;
    if (info.size > 0 || await isTracked(rootPath, file)) result.push(file);
  }
  return result;
}

async function isTracked(rootPath: string, file: string): Promise<boolean> {
  const result = await runProcess("git", ["ls-files", "--error-unmatch", "--", file], rootPath, 20_000);
  return result.exitCode === 0;
}

async function runRequired(command: string, args: string[], cwd: string, timeoutMs: number, secret?: string): Promise<void> {
  const result = await runProcess(command, args, cwd, timeoutMs, undefined, false, secret);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
  shell = false,
  secret?: string
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell, env: sandboxEnv() });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = trimOutput(stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = trimOutput(stderr + chunk.toString());
    });
    child.on("close", (exitCode: number | null) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: redact(stdout, secret),
        stderr: redact(stderr, secret)
      });
    });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
    if (input) child.stdin.end(input);
  });
}

function sandboxEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV || "production",
    CI: "1",
    npm_config_fund: "false",
    npm_config_audit: "false"
  };
}

function tokenizedCloneUrl(fullName: string, token: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${fullName}.git`;
}

function buildRepositoryPrompt(
  repoFullName: string,
  defaultBranch: string,
  branchName: string | undefined,
  mode: ResolvedGitHubTaskMode,
  userPrompt: string
): string {
  const writeInstructions = [
    `Working branch: ${branchName}`,
    "",
    "The user's prompt appears to request code or file changes, so write tools are enabled.",
    "Do not stop with advice or a written plan when the user asks you to make changes.",
    "Inspect the relevant files, then use create_file or apply_patch to implement the requested change.",
    "Use create_file for new text files and apply_patch for edits to existing files.",
    "Do not use run_command to create or edit files.",
    "Do not use touch, echo, cat, tee, heredocs, or shell redirection for file edits.",
    "Before finishing, ensure any new file requested by the user has non-empty content.",
    "A pull request will be opened only if non-empty file changes are produced."
  ];

  const readInstructions = [
    "The user's prompt appears to ask for analysis, explanation, planning, review, or another text-only response.",
    "Read-only tools are enabled.",
    "Do not attempt to create, edit, commit, push, approve, merge, or open a pull request.",
    "Answer with useful text based on repository inspection."
  ];

  return [
    `Repository: ${repoFullName}`,
    `Base branch: ${defaultBranch}`,
    "",
    "You are running in a disposable GitHub App sandbox.",
    "Do only the work needed for the user's request.",
    ...(mode === "write" ? writeInstructions : readInstructions),
    "Do not approve, merge, or push directly to the base branch.",
    "Run relevant tests if they are obvious and reasonably cheap.",
    "",
    `User request: ${userPrompt}`
  ].join("\n");
}

function createAgentBranchName(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 42) || "task";
  return `agent/${slug}-${Date.now().toString(36)}`;
}

function commitTitle(prompt: string): string {
  return `chore: ${humanTitle(prompt)}`;
}

function prTitle(prompt: string): string {
  return `Agent: ${humanTitle(prompt)}`;
}

function humanTitle(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim().slice(0, 72);
  return line || "apply requested changes";
}

export function resolveGitHubTaskMode(prompt: string, requestedMode: GitHubTaskMode = "auto"): ResolvedGitHubTaskMode {
  if (requestedMode === "read" || requestedMode === "write") return requestedMode;
  return promptLooksWriteIntent(prompt) ? "write" : "read";
}

const changeTargetPattern =
  /\b(ui|ux|interface|screen|page|layout|style|styles|styling|css|theme|visual|design|component|button|panel|sidebar|toolbar|form|code|app|application|website|site|frontend|front[- ]end|view)\b/;
const changeActionPattern =
  /\b(make|build|create|add|write|edit|change|changes|update|updates|modify|fix|implement|refactor|remove|delete|rename|move|replace|redesign|restyle|polish|improve|revamp)\b/;

function promptLooksWriteIntent(prompt: string): boolean {
  const text = prompt.toLowerCase();
  const explicitReadOnlyPatterns = [
    /\b(do not edit|don't edit|no changes|read[- ]only|without changing|just tell me)\b/,
    /^\s*(explain|summari[sz]e|describe|analy[sz]e|inspect|review|audit|find|look for|what|why|how|where|which|when|plan|recommend|compare)\b/
  ];
  const adviceOnlyPattern = /\b(tell me|what should|recommend|suggest|advice|ideas)\b/;
  const directImplementationPattern =
    /\b(make|apply|implement|edit|update|modify|fix|redesign|restyle|polish|improve|revamp|create|add|write)\b/;
  const textOnlyCreationPattern =
    /^\s*(please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+)?(create|write|make)\s+(a\s+|an\s+)?(plan|summary|analysis|explanation|recommendation)\b/;
  const fileArtifactPattern = /\b(file|readme|test|bug|feature|function|component|endpoint|route|code|docs|documentation|markdown|md)\b/;
  const pullRequestPattern = /\b(open|make|submit|raise)\b[\s\S]{0,40}\b(pr|pull request)\b/;
  const writePatterns = [
    /^\s*(please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+|let'?s\s+)?(add|create|write|edit|change|update|modify|fix|implement|refactor|remove|delete|rename|move|replace|redesign|restyle|polish|improve|revamp)\b/,
    /\b(fix|implement|add|create|write|edit|change|changes|update|updates|modify|refactor|remove|delete|rename|move|replace|redesign|restyle|polish|improve|revamp)\b[\s\S]{0,100}\b(file|readme|test|bug|feature|function|component|endpoint|route|code|docs|documentation|markdown|md|ui|ux|interface|layout|style|styles|styling|css|theme|visual|design|frontend|front[- ]end|page|screen)\b/,
    /\b(file|readme|test|bug|feature|function|component|endpoint|route|code|docs|documentation|markdown|md|ui|ux|interface|layout|style|styles|styling|css|theme|visual|design|frontend|front[- ]end|page|screen)\b[\s\S]{0,100}\b(add|create|write|edit|change|changes|update|updates|modify|fix|implement|refactor|remove|delete|rename|move|replace|redesign|restyle|polish|improve|revamp)\b/,
    /\bmake\b[\s\S]{0,80}\b(file|files|change|changes|edit|edits|update|updates|commit|code|ui|ux|interface|layout|style|styles|styling|css|theme|visual|design|frontend|front[- ]end|page|screen)\b/,
    /\bmake\b[\s\S]{0,80}\b(look|feel|match|resemble)\b/,
    /\bfix\s+(it|this|that)\b/
  ];

  if (pullRequestPattern.test(text)) return true;
  if (textOnlyCreationPattern.test(text) && !fileArtifactPattern.test(text)) return false;
  if (adviceOnlyPattern.test(text) && !directImplementationPattern.test(text)) return false;
  if (changeActionPattern.test(text) && changeTargetPattern.test(text)) return true;
  if (explicitReadOnlyPatterns.some((pattern) => pattern.test(text)) && !writePatterns.some((pattern) => pattern.test(text))) {
    return false;
  }
  return writePatterns.some((pattern) => pattern.test(text));
}

function prBody(prompt: string, result: AgentRunResponse, changedFiles: string[]): string {
  return [
    "## Request",
    "",
    prompt,
    "",
    "## Agent Summary",
    "",
    result.text,
    "",
    "## Changed Files",
    "",
    ...changedFiles.map((file) => `- \`${file}\``),
    "",
    "## Safety",
    "",
    "This PR was created from an `agent/*` branch. The agent did not merge or approve this PR."
  ].join("\n");
}

function scoreCommandRisk(command: string): "low" | "medium" | "high" {
  const lower = command.toLowerCase();
  if (/(^|\s)(sudo|rm|dd|mkfs|chmod|chown|curl|wget|ssh|scp)\b/.test(lower)) return "high";
  if (/(^|\s)(touch|truncate|tee)\b/.test(lower)) return "high";
  if (/(^|\s)git\s+(push|checkout|reset|clean|merge|rebase)\b/.test(lower)) return "high";
  if (/[|;&`$<>]/.test(command)) return "high";
  if (/(^|\s)(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/.test(lower)) return "medium";
  return "low";
}

function toolResult<T>(
  status: ToolResult<T>["status"],
  summary: string,
  data?: T,
  risk?: ToolResult<T>["risk"]
): ToolResult<T> {
  return { status, summary, data, risk };
}

function trimOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxOutputBytes) return value;
  return value.slice(-maxOutputBytes);
}

function redact(value: string, secret?: string): string {
  if (!secret) return value;
  return value.replaceAll(secret, "[redacted]");
}

function repoRoot(): string {
  let current = process.cwd();
  while (true) {
    if (existsSync(path.join(current, "DEVELOPMENT_AGENT_PLAN.md"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}
