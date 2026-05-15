import { runAgentTask, type ToolExecutor } from "@coding-agent/agent-core";
import type {
  AgentProvider,
  AgentRunResponse,
  CommandResult,
  DaemonToolName,
  GitResult,
  ListFilesResult,
  PatchResult,
  ReadFileResult,
  SearchResult,
  ToolResult
} from "@coding-agent/shared";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  createInstallationToken,
  findInstalledRepository,
  openPullRequest
} from "./github-app";

export type GitHubPrTaskRequest = {
  installationId: number;
  repoFullName: string;
  prompt: string;
  provider: AgentProvider;
  model?: string;
};

export type GitHubPrTaskResult = AgentRunResponse & {
  repository: string;
  branchName?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  changedFiles: string[];
  sandboxRoot: string;
};

const skippedDirectories = new Set([".git", "node_modules", ".next", "dist", "coverage", ".turbo"]);
const maxOutputBytes = 200_000;

export async function runGitHubPrTask(request: GitHubPrTaskRequest): Promise<GitHubPrTaskResult> {
  const repo = await findInstalledRepository(request.repoFullName, request.installationId);
  const installationToken = await createInstallationToken(repo.installationId);
  const sandboxRoot = await createSandboxRoot();
  const cloneUrl = tokenizedCloneUrl(repo.fullName, installationToken.token);
  const branchName = createAgentBranchName(request.prompt);

  await runRequired("git", ["clone", "--depth", "1", cloneUrl, sandboxRoot], process.cwd(), 120_000, installationToken.token);
  await runRequired("git", ["remote", "set-url", "origin", `https://github.com/${repo.fullName}.git`], sandboxRoot, 20_000);
  await runRequired("git", ["checkout", "-b", branchName], sandboxRoot, 20_000);
  await runRequired("git", ["config", "user.name", `${process.env.GITHUB_APP_SLUG || "coding-agent"}[bot]`], sandboxRoot, 20_000);
  await runRequired(
    "git",
    ["config", "user.email", `${process.env.GITHUB_APP_ID || "0"}+${process.env.GITHUB_APP_SLUG || "coding-agent"}[bot]@users.noreply.github.com`],
    sandboxRoot,
    20_000
  );

  const rootPath = await realpath(sandboxRoot);
  const executor = createWritableSandboxExecutor(rootPath);
  const result = await runAgentTask({
    provider: request.provider,
    model: request.model,
    prompt: buildPrPrompt(repo.fullName, repo.defaultBranch, branchName, request.prompt),
    executor,
    maxToolRounds: 12
  });

  const changedFiles = await changedFileNames(rootPath);
  if (changedFiles.length === 0) {
    return {
      ...result,
      repository: repo.fullName,
      branchName,
      changedFiles,
      sandboxRoot,
      text: `${result.text}\n\nNo file changes were produced, so no pull request was opened.`
    };
  }

  await runRequired("git", ["add", "-A"], rootPath, 20_000);
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
    body: prBody(request.prompt, result, changedFiles),
    head: branchName,
    base: repo.defaultBranch
  });

  return {
    ...result,
    repository: repo.fullName,
    branchName,
    pullRequestUrl: pullRequest.htmlUrl,
    pullRequestNumber: pullRequest.number,
    changedFiles,
    sandboxRoot
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

function buildPrPrompt(repoFullName: string, defaultBranch: string, branchName: string, userPrompt: string): string {
  return [
    `Repository: ${repoFullName}`,
    `Base branch: ${defaultBranch}`,
    `Working branch: ${branchName}`,
    "",
    "You are running in a disposable GitHub App sandbox.",
    "Make only the changes needed for the user's request.",
    "Use apply_patch for file edits.",
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
