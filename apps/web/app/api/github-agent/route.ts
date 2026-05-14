import { runAgentTask, type ToolExecutor } from "@coding-agent/agent-core";
import type { AgentProvider, DaemonToolName, ToolResult } from "@coding-agent/shared";
import { NextResponse } from "next/server";
import { mkdir, mkdtemp, readFile, readdir, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  repoUrl: z.string().url(),
  prompt: z.string().min(1),
  provider: z.enum(["mock", "openai", "anthropic", "google", "groq"]).default("mock"),
  model: z.string().optional()
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const repo = parseGitHubUrl(body.repoUrl);
    const sandboxRoot = await createSandboxRoot();
    const cloneUrl = buildCloneUrl(repo.owner, repo.name);

    const clone = await runProcess("git", ["clone", "--depth", "1", cloneUrl, sandboxRoot], process.cwd(), 120_000);
    if (clone.exitCode !== 0) {
      throw new Error(clone.stderr || clone.stdout || "git clone failed");
    }

    const rootPath = await realpath(sandboxRoot);
    const executor = createSandboxExecutor(rootPath);
    const result = await runAgentTask({
      provider: body.provider as AgentProvider,
      model: body.model,
      prompt: `Repository: ${repo.owner}/${repo.name}\n\nTask: ${body.prompt}`,
      executor
    });

    return NextResponse.json({
      ...result,
      repository: `${repo.owner}/${repo.name}`,
      sandboxRoot
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown GitHub agent error"
      },
      { status: 400 }
    );
  }
}

function parseGitHubUrl(repoUrl: string): { owner: string; name: string } {
  const url = new URL(repoUrl);
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
    throw new Error("Only github.com repository URLs are supported in this MVP.");
  }

  const [owner, rawName] = url.pathname.replace(/^\/+/, "").split("/");
  if (!owner || !rawName) throw new Error("GitHub URL must include owner and repository.");
  const name = rawName.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("GitHub owner or repository name contains unsupported characters.");
  }
  return { owner, name };
}

function buildCloneUrl(owner: string, name: string): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return `https://github.com/${owner}/${name}.git`;
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${name}.git`;
}

async function createSandboxRoot(): Promise<string> {
  const base = process.env.AGENT_SANDBOX_ROOT || path.resolve(process.cwd(), "../..", ".agent-sandboxes");
  await mkdir(base, { recursive: true });
  const tempPrefix = path.join(base, "github-");
  return mkdtemp(tempPrefix);
}

function createSandboxExecutor(rootPath: string): ToolExecutor {
  return async (name: DaemonToolName, args: Record<string, unknown>) => {
    if (name === "apply_patch" || name === "run_command") {
      return toolResult("requires_approval", `${name} is disabled for GitHub analysis mode in this MVP.`, undefined, "medium");
    }

    if (name === "list_files") {
      const requestedPath = typeof args.path === "string" ? args.path : ".";
      const maxFiles = typeof args.maxFiles === "number" ? Math.min(args.maxFiles, 500) : 120;
      const directory = await resolveSandboxPath(rootPath, requestedPath);
      const files = await listFiles(rootPath, directory, maxFiles);
      return toolResult("completed", `Listed ${files.length} entries.`, { rootPath, files });
    }

    if (name === "read_file") {
      const requestedPath = typeof args.path === "string" ? args.path : "";
      if (!requestedPath) return toolResult("failed", "Missing file path.");
      const absolutePath = await resolveSandboxPath(rootPath, requestedPath);
      const content = await readFile(absolutePath, "utf8");
      const lines = content.split(/\r?\n/);
      const startLine = typeof args.startLine === "number" ? Math.max(1, args.startLine) : 1;
      const endLine = typeof args.endLine === "number" ? Math.min(lines.length, args.endLine) : Math.min(lines.length, startLine + 240);
      return toolResult("completed", `Read ${requestedPath}:${startLine}-${endLine}.`, {
        path: requestedPath,
        startLine,
        endLine,
        totalLines: lines.length,
        content: lines.slice(startLine - 1, endLine).join("\n")
      });
    }

    if (name === "search_text") {
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

    if (name === "git_status") {
      const git = await runProcess("git", ["status", "--short"], rootPath, 20_000);
      return toolResult("completed", git.stdout.trim() ? "Git status has changes." : "Working tree is clean.", {
        operation: "status",
        output: git.stdout || git.stderr
      });
    }

    if (name === "git_diff") {
      const git = await runProcess("git", ["diff", "--", "."], rootPath, 20_000);
      return toolResult("completed", git.stdout.trim() ? "Read current git diff." : "No git diff.", {
        operation: "diff",
        output: git.stdout
      });
    }

    return toolResult("failed", `Unsupported tool: ${name}`);
  };
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

async function listFiles(rootPath: string, directory: string, maxFiles: number) {
  const skipped = new Set([".git", "node_modules", ".next", "dist", "coverage"]);
  const files: Array<{ path: string; type: "file" | "directory"; size?: number }> = [];
  const queue = [directory];

  while (queue.length > 0 && files.length < maxFiles) {
    const current = queue.shift();
    if (!current) break;
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      if (entry.isDirectory() && skipped.has(entry.name)) continue;
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

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-200_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-200_000);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr: redactToken(stderr) });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
  });
}

function redactToken(value: string): string {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) return value;
  return value.replaceAll(token, "[redacted]");
}

function toolResult<T>(
  status: ToolResult<T>["status"],
  summary: string,
  data?: T,
  risk?: ToolResult<T>["risk"]
): ToolResult<T> {
  return {
    status,
    summary,
    data,
    risk
  };
}
