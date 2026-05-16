import cors from "@fastify/cors";
import { applyPatch, formatPatch, parsePatch } from "diff";
import Fastify from "fastify";
import { access, mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { z } from "zod";
import type {
  CommandResult,
  GitResult,
  ListFilesResult,
  PatchResult,
  CreateFileResult,
  ReadFileResult,
  ReplaceTextResult,
  SearchResult,
  ToolResult,
  Workspace
} from "@coding-agent/shared";

const port = Number(process.env.DAEMON_PORT || 4317);
const host = "127.0.0.1";
const maxOutputBytes = 200_000;
const skippedDirectories = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "coverage",
  ".turbo",
  ".agent-sandboxes"
]);

const workspaces = new Map<string, Workspace>();

const server = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || "info"
  }
});

await server.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"]
});

server.get("/health", async () => ({
  ok: true,
  daemon: "coding-agent-local-daemon",
  workspaces: [...workspaces.values()]
}));

server.get("/workspaces", async () => ({
  workspaces: [...workspaces.values()]
}));

server.post("/workspaces", async (request, reply) => {
  const body = z
    .object({
      rootPath: z.string().min(1)
    })
    .parse(request.body);

  const rootPath = await realpath(body.rootPath);
  const rootStat = await stat(rootPath);
  if (!rootStat.isDirectory()) {
    return reply.code(400).send({ error: "Workspace root must be a directory." });
  }

  const existing = [...workspaces.values()].find((workspace) => workspace.rootPath === rootPath);
  if (existing) return { workspace: existing };

  const workspace: Workspace = {
    id: crypto.randomUUID(),
    rootPath,
    createdAt: new Date().toISOString()
  };
  workspaces.set(workspace.id, workspace);
  return { workspace };
});

server.post("/tools/list_files", async (request) => {
  const body = z
    .object({
      workspaceId: z.string(),
      path: z.string().optional().default("."),
      maxFiles: z.number().int().positive().max(1000).optional().default(200)
    })
    .parse(request.body);

  const workspace = getWorkspace(body.workspaceId);
  const root = await resolveWorkspacePath(workspace, body.path);
  const files = await listFiles(workspace.rootPath, root, body.maxFiles);

  return toolResult<ListFilesResult>("completed", `Listed ${files.length} entries.`, {
    rootPath: workspace.rootPath,
    files
  });
});

server.post("/tools/read_file", async (request) => {
  const body = z
    .object({
      workspaceId: z.string(),
      path: z.string().min(1),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional()
    })
    .parse(request.body);

  const workspace = getWorkspace(body.workspaceId);
  const absolutePath = await resolveWorkspacePath(workspace, body.path);
  const fileStat = await stat(absolutePath);
  if (!fileStat.isFile()) throw new Error("Path is not a file.");

  const content = await readFile(absolutePath, "utf8");
  const lines = content.split(/\r?\n/);
  const startLine = Math.max(1, body.startLine ?? 1);
  const endLine = Math.min(lines.length, body.endLine ?? Math.min(lines.length, startLine + 240));
  const selected = lines.slice(startLine - 1, endLine).join("\n");

  return toolResult<ReadFileResult>(
    "completed",
    `Read ${body.path}:${startLine}-${endLine}.`,
    {
      path: body.path,
      startLine,
      endLine,
      totalLines: lines.length,
      content: selected
    }
  );
});

server.post("/tools/search_text", async (request) => {
  const body = z
    .object({
      workspaceId: z.string(),
      query: z.string().min(1),
      glob: z.string().optional(),
      maxResults: z.number().int().positive().max(500).optional().default(100)
    })
    .parse(request.body);

  const workspace = getWorkspace(body.workspaceId);
  const args = ["--line-number", "--column", "--no-heading", "--color", "never"];
  if (body.glob) args.push("--glob", body.glob);
  args.push(body.query, ".");

  const result = await runProcess("rg", args, workspace.rootPath, 20_000);
  const matches = result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, body.maxResults)
    .map((line) => {
      const [filePath = "", lineNumber = "0", column = "0", ...textParts] = line.split(":");
      return {
        path: filePath,
        line: Number(lineNumber),
        column: Number(column),
        text: textParts.join(":")
      };
    });

  return toolResult<SearchResult>("completed", `Found ${matches.length} matches.`, {
    query: body.query,
    matches
  });
});

server.post("/tools/git_status", async (request) => {
  const body = z.object({ workspaceId: z.string() }).parse(request.body);
  const workspace = getWorkspace(body.workspaceId);
  const result = await runProcess("git", ["status", "--short"], workspace.rootPath, 20_000);
  const output = result.stdout || result.stderr;

  return toolResult<GitResult>(
    result.exitCode === 0 ? "completed" : "failed",
    result.exitCode === 0
      ? output.trim()
        ? "Git status has changes."
        : "Working tree is clean."
      : "Git status failed.",
    {
      operation: "status",
      output
    }
  );
});

server.post("/tools/git_diff", async (request) => {
  const body = z.object({ workspaceId: z.string() }).parse(request.body);
  const workspace = getWorkspace(body.workspaceId);
  const result = await runProcess("git", ["diff", "--", "."], workspace.rootPath, 20_000);

  return toolResult<GitResult>(
    result.exitCode === 0 ? "completed" : "failed",
    result.exitCode === 0 ? (result.stdout.trim() ? "Read current git diff." : "No git diff.") : "Git diff failed.",
    {
      operation: "diff",
      output: result.stdout || result.stderr
    }
  );
});

server.post("/tools/apply_patch", async (request, reply) => {
  const body = z
    .object({
      workspaceId: z.string(),
      patch: z.string().min(1)
    })
    .parse(request.body);

  const workspace = getWorkspace(body.workspaceId);
  const result = await applyUnifiedPatch(workspace, body.patch);
  if (result.status === "failed") return reply.code(400).send(result);
  return result;
});

server.post("/tools/create_file", async (request, reply) => {
  const body = z
    .object({
      workspaceId: z.string(),
      path: z.string().min(1),
      content: z.string(),
      overwrite: z.boolean().optional().default(false),
      allowEmpty: z.boolean().optional().default(false)
    })
    .parse(request.body);

  if (!body.allowEmpty && body.content.length === 0) {
    return reply.code(400).send(toolResult<CreateFileResult>("failed", "Refusing to create an empty file without allowEmpty=true."));
  }

  const workspace = getWorkspace(body.workspaceId);
  const absolutePath = await resolveWorkspacePath(workspace, body.path);
  if (existsSync(absolutePath) && !body.overwrite) {
    return reply.code(409).send(toolResult<CreateFileResult>("failed", "File already exists. Use replace_text or apply_patch for edits, or overwrite=true only when replacing it intentionally."));
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, body.content, "utf8");
  return toolResult<CreateFileResult>("completed", `Created ${body.path}.`, {
    path: body.path,
    bytes: Buffer.byteLength(body.content, "utf8")
  });
});

server.post("/tools/replace_text", async (request, reply) => {
  const body = z
    .object({
      workspaceId: z.string(),
      path: z.string().min(1),
      oldText: z.string().min(1),
      newText: z.string(),
      expectedReplacements: z.number().int().positive().max(100).optional().default(1)
    })
    .parse(request.body);

  const workspace = getWorkspace(body.workspaceId);
  const result = await replaceTextInFile(workspace, body.path, body.oldText, body.newText, body.expectedReplacements);
  if (result.status === "failed") return reply.code(400).send(result);
  return result;
});

server.post("/tools/run_command", async (request, reply) => {
  const body = z
    .object({
      workspaceId: z.string(),
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().max(120_000).optional().default(30_000),
      allowRisky: z.boolean().optional().default(false)
    })
    .parse(request.body);

  const workspace = getWorkspace(body.workspaceId);
  const risk = scoreCommandRisk(body.command);
  if (risk === "high" && !body.allowRisky) {
    return reply.code(403).send(
      toolResult("requires_approval", "Command was blocked by local risk policy.", undefined, risk)
    );
  }

  const startedAt = Date.now();
  const result = await runShellCommand(body.command, workspace.rootPath, body.timeoutMs);
  const durationMs = Date.now() - startedAt;

  return toolResult<CommandResult>(
    result.exitCode === 0 ? "completed" : "failed",
    `Command exited with code ${result.exitCode}.`,
    {
      command: body.command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs
    },
    risk
  );
});

server.setErrorHandler((error, _request, reply) => {
  const fastifyError = error as Error & { statusCode?: number };
  const statusCode = typeof fastifyError.statusCode === "number" ? fastifyError.statusCode : 500;
  reply.code(statusCode).send({
    status: "failed",
    summary: fastifyError.message,
    error: fastifyError.message
  });
});

await seedDefaultWorkspace();

await server.listen({ host, port });

async function seedDefaultWorkspace() {
  const rootPath = process.env.WORKSPACE_ROOT?.trim() || process.cwd();
  try {
    const resolved = await realpath(rootPath);
    const rootStat = await stat(resolved);
    if (!rootStat.isDirectory()) return;
    const workspace: Workspace = {
      id: "default",
      rootPath: resolved,
      createdAt: new Date().toISOString()
    };
    workspaces.set(workspace.id, workspace);
  } catch (error) {
    server.log.warn({ error }, "Could not seed default workspace.");
  }
}

function getWorkspace(workspaceId: string): Workspace {
  const workspace = workspaces.get(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  return workspace;
}

async function resolveWorkspacePath(workspace: Workspace, relativePath: string): Promise<string> {
  const absolute = path.resolve(workspace.rootPath, relativePath);
  const rootWithSeparator = `${workspace.rootPath}${path.sep}`;
  if (absolute !== workspace.rootPath && !absolute.startsWith(rootWithSeparator)) {
    throw new Error("Path escapes workspace root.");
  }

  if (existsSync(absolute)) {
    const resolved = await realpath(absolute);
    if (resolved !== workspace.rootPath && !resolved.startsWith(rootWithSeparator)) {
      throw new Error("Path resolves outside workspace root.");
    }
    return resolved;
  }

  const parent = await realpath(path.dirname(absolute));
  if (parent !== workspace.rootPath && !parent.startsWith(rootWithSeparator)) {
    throw new Error("Path parent resolves outside workspace root.");
  }
  return absolute;
}

async function listFiles(
  workspaceRoot: string,
  directory: string,
  maxFiles: number
): Promise<ListFilesResult["files"]> {
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
      const relative = path.relative(workspaceRoot, absolute) || ".";
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

async function replaceTextInFile(
  workspace: Workspace,
  relativePath: string,
  oldText: string,
  newText: string,
  expectedReplacements: number
): Promise<ToolResult<ReplaceTextResult>> {
  if (oldText === newText) {
    return toolResult<ReplaceTextResult>("failed", "Replacement would not change the file.", undefined, "medium");
  }

  const targetPath = await resolveWorkspacePath(workspace, relativePath);
  if (!existsSync(targetPath)) {
    return toolResult<ReplaceTextResult>("failed", `File does not exist: ${relativePath}`, undefined, "medium");
  }

  const original = await readFile(targetPath, "utf8");
  const replacements = countExactOccurrences(original, oldText);
  if (replacements !== expectedReplacements) {
    return toolResult<ReplaceTextResult>(
      "failed",
      `Expected ${expectedReplacements} exact replacement(s), found ${replacements}. Read the current file and retry with a unique exact oldText.`,
      undefined,
      "medium"
    );
  }

  const next = original.split(oldText).join(newText);
  await writeFile(targetPath, next, "utf8");
  return toolResult("completed", `Replaced ${replacements} occurrence(s) in ${relativePath}.`, {
    path: relativePath,
    replacements,
    bytes: Buffer.byteLength(next, "utf8")
  });
}

async function applyUnifiedPatch(workspace: Workspace, patch: string): Promise<ToolResult<PatchResult>> {
  const validationError = validateUnifiedPatchInput(patch);
  if (validationError) {
    return toolResult<PatchResult>("failed", validationError, undefined, "medium");
  }

  const parsed = parsePatch(patch);
  if (parsed.length === 0) {
    return toolResult<PatchResult>("failed", "Patch did not contain any file changes.", undefined, "medium");
  }

  const changedFiles: string[] = [];

  for (const filePatch of parsed) {
    const targetName = cleanPatchFileName(filePatch.newFileName !== "/dev/null" ? filePatch.newFileName : filePatch.oldFileName);
    if (!targetName) {
      return toolResult<PatchResult>("failed", "Patch target could not be determined.", undefined, "medium");
    }

    const targetPath = await resolveWorkspacePath(workspace, targetName);
    const deletingFile = filePatch.newFileName === "/dev/null";
    const creatingFile = filePatch.oldFileName === "/dev/null";

    if (deletingFile) {
      await access(targetPath);
      await unlink(targetPath);
      changedFiles.push(targetName);
      continue;
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    const original = creatingFile || !existsSync(targetPath) ? "" : await readFile(targetPath, "utf8");
    const next = applyPatch(original, formatPatch(filePatch));

    if (next === false) {
      return toolResult<PatchResult>("failed", `Patch failed to apply for ${targetName}.`, undefined, "medium");
    }

    await writeFile(targetPath, next, "utf8");
    changedFiles.push(targetName);
  }

  return toolResult("completed", `Applied patch to ${changedFiles.length} file(s).`, {
    changedFiles
  });
}

function validateUnifiedPatchInput(patch: string): string | undefined {
  const trimmed = patch.trim();
  const hasFileHeader = /^diff --git\s+/m.test(trimmed) || /^---\s+/m.test(trimmed);
  const hasNewFileHeader = /^\+\+\+\s+/m.test(trimmed);
  const hasHunk = /^@@\s+/m.test(trimmed);

  if (/^@@\s+/m.test(trimmed) && !hasFileHeader) {
    return "Patch is a detached hunk. Send a complete unified diff with file headers, or use replace_text for exact localized edits.";
  }
  if (!hasFileHeader || !hasNewFileHeader || !hasHunk) {
    return "Patch must be a complete unified diff with file headers (`diff --git` or `---`/`+++`) and valid `@@` hunk headers.";
  }
  return undefined;
}

function cleanPatchFileName(fileName?: string): string | undefined {
  if (!fileName) return undefined;
  return fileName.replace(/^(a|b)\//, "");
}

function scoreCommandRisk(command: string): "low" | "medium" | "high" {
  const lower = command.toLowerCase();
  if (/(^|\s)(sudo|rm|dd|mkfs|chmod|chown|curl|wget|ssh|scp)\b/.test(lower)) return "high";
  if (/(^|\s)(touch|truncate|tee)\b/.test(lower)) return "high";
  if (/(^|\s)git\s+push\b/.test(lower)) return "high";
  if (/[|;&`$<>]/.test(command)) return "high";
  if (/(^|\s)(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/.test(lower)) return "medium";
  if (/(^|\s)(pip|poetry|uv|cargo|go)\s+/.test(lower)) return "medium";
  return "low";
}

async function runProcess(command: string, args: string[], cwd: string, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, args, { cwd, shell: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = trimOutput(stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = trimOutput(stderr + chunk.toString());
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
  });
}

async function runShellCommand(command: string, cwd: string, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = trimOutput(stdout + chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = trimOutput(stderr + chunk.toString());
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
  });
}

function trimOutput(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= maxOutputBytes) return value;
  return value.slice(-maxOutputBytes);
}

function countExactOccurrences(value: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let index = value.indexOf(search);
  while (index !== -1) {
    count += 1;
    index = value.indexOf(search, index + search.length);
  }
  return count;
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
