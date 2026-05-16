import { runAgentTask, type ToolExecutor } from "@coding-agent/agent-core";
import type {
  AcceptanceCriterion,
  AgentLifecycleEvent,
  AgentLifecycleStatus,
  AgentProvider,
  AgentReviewResult,
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
  ReplaceTextResult,
  SearchResult,
  ValidationCheck,
  ToolResult
} from "@coding-agent/shared";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  onLifecycleEvent?: (event: AgentLifecycleEvent) => void | Promise<void>;
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
  pauseId?: string;
  pauseReason?: AgentRunResponse["stopReason"];
  resumeAvailable?: boolean;
  diffSummary?: string;
};

export type PausedGitHubRunAction = "open_draft_pr" | "stop" | "discard";

type PausedGitHubRunRecord = {
  id: string;
  installationId: number;
  repoFullName: string;
  defaultBranch: string;
  branchName: string;
  sandboxRoot: string;
  prompt: string;
  provider: AgentProvider;
  model?: string;
  mode: ResolvedGitHubTaskMode;
  createdAt: string;
  updatedAt: string;
  pauseReason: NonNullable<AgentRunResponse["stopReason"]>;
  toolEvents: AgentToolEvent[];
  resultText: string;
  changedFiles: string[];
  diffSummary: string;
  acceptanceCriteria?: AcceptanceCriterion[];
  validation?: ValidationCheck[];
  review?: AgentReviewResult;
};

const skippedDirectories = new Set([".git", "node_modules", ".next", "dist", "coverage", ".turbo"]);
const maxOutputBytes = 200_000;
const validationCommandPattern = /\b(typecheck|lint|test|build|check)\b/i;

export async function runGitHubRepositoryTask(request: GitHubRepositoryTaskRequest): Promise<GitHubRepositoryTaskResult> {
  const repo = await findInstalledRepository(request.repoFullName, request.installationId);
  const installationToken = await createInstallationToken(repo.installationId);
  const sandboxRoot = await createSandboxRoot();
  const cloneUrl = tokenizedCloneUrl(repo.fullName, installationToken.token);
  await emitLifecycleEvent(request.onLifecycleEvent, "classifying", "Classifying the repository prompt into read or write mode.");
  const mode = await resolveGitHubTaskMode({
    prompt: request.prompt,
    requestedMode: request.mode || "auto",
    provider: request.provider,
    model: request.model
  });
  await emitLifecycleEvent(request.onLifecycleEvent, "classifying", `Prompt classified as ${mode} mode.`);
  const branchName = mode === "write" ? createAgentBranchName(request.prompt) : undefined;

  await emitLifecycleEvent(request.onLifecycleEvent, "cloning", `Cloning ${repo.fullName} into a disposable sandbox.`);
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
  await emitLifecycleEvent(request.onLifecycleEvent, "cloning", `Sandbox ready for ${repo.fullName}.`);

  const rootPath = await realpath(sandboxRoot);
  const executor = mode === "write" ? createWritableSandboxExecutor(rootPath) : createReadOnlySandboxExecutor(rootPath);
  const collectedToolEvents: AgentToolEvent[] = [];
  let result: AgentRunResponse;
  try {
    await emitLifecycleEvent(
      request.onLifecycleEvent,
      mode === "write" ? "editing" : "planning",
      mode === "write" ? "Running the coding agent with repository write tools." : "Running the repository agent with read-only tools."
    );
    result = await runAgentTask({
      provider: request.provider,
      model: request.model,
      prompt: buildRepositoryPrompt(repo.fullName, repo.defaultBranch, branchName, mode, request.prompt),
      executor,
      maxToolRounds: mode === "write" ? githubWriteMaxToolRounds() : 12,
      onToolStart: request.onToolStart,
      onToolEvent: async (event) => {
        collectedToolEvents.push(event);
        await request.onToolEvent?.(event);
      }
    });
    await emitLifecycleEvent(request.onLifecycleEvent, mode === "write" ? "editing" : "planning", "Agent tool loop completed.");
  } catch (error) {
    result = recoverAgentRunResponse(request.provider, request.model, collectedToolEvents, error);
    await emitLifecycleEvent(request.onLifecycleEvent, "recovered", "Recovered from a provider error after partial progress.", "failed");
  }

  result = enrichAgentRunResult(result, collectedToolEvents);
  const changedFiles = await changedFileNames(rootPath);
  const committableFiles = await committableChangedFileNames(rootPath, changedFiles);
  const immediatePauseReason = mode === "write" ? immediatePauseReasonForResult(result) : undefined;
  if (mode === "read") {
    return {
      ...result,
      repository: repo.fullName,
      mode,
      changedFiles: [],
      sandboxRoot
    };
  }

  if (!branchName) throw new Error("Write-mode GitHub task did not create a working branch.");

  if (immediatePauseReason) {
    await emitLifecycleEvent(request.onLifecycleEvent, "paused", `Paused before PR creation: ${pauseReasonLabel(immediatePauseReason)}.`, "paused");
    return pauseGitHubRun({
      installationId: repo.installationId,
      repoFullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      branchName,
      sandboxRoot: rootPath,
      prompt: request.prompt,
      provider: request.provider,
      model: request.model,
      mode,
      pauseReason: immediatePauseReason,
      result,
      changedFiles: committableFiles
    });
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

  await emitLifecycleEvent(request.onLifecycleEvent, "validating", "Summarizing validation feedback from the run.");
  const review = await reviewGitHubRun({
    provider: request.provider,
    model: request.model,
    repoFullName: repo.fullName,
    prompt: request.prompt,
    rootPath,
    result,
    changedFiles: committableFiles
  });
  result = withReviewResult(result, review);
  await emitLifecycleEvent(
    request.onLifecycleEvent,
    "reviewing",
    review.status === "approved" ? "Reviewer gate approved the proposed changes." : "Reviewer gate found issues that need a human or continuation.",
    review.status === "approved" ? "completed" : "paused"
  );

  const gatedPauseReason = pauseReasonForResult(result);
  if (gatedPauseReason) {
    await emitLifecycleEvent(request.onLifecycleEvent, "needs_review", `Paused before PR creation: ${pauseReasonLabel(gatedPauseReason)}.`, "paused");
    return pauseGitHubRun({
      installationId: repo.installationId,
      repoFullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      branchName,
      sandboxRoot: rootPath,
      prompt: request.prompt,
      provider: request.provider,
      model: request.model,
      mode,
      pauseReason: gatedPauseReason,
      result,
      changedFiles: committableFiles
    });
  }

  await emitLifecycleEvent(request.onLifecycleEvent, "opening_pr", "Opening a pull request for the reviewed changes.");
  return finalizeGitHubRun({
    installationId: repo.installationId,
    repoFullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    installationToken: installationToken.token,
    branchName,
    rootPath,
    prompt: request.prompt,
    result,
    changedFiles: committableFiles,
    mode,
    draft: false
  });
}

export async function resumeGitHubRepositoryTask({
  pauseId,
  continuation,
  onLifecycleEvent,
  onToolStart,
  onToolEvent
}: {
  pauseId: string;
  continuation?: string;
  onLifecycleEvent?: (event: AgentLifecycleEvent) => void | Promise<void>;
  onToolStart?: (event: AgentToolStartEvent) => void | Promise<void>;
  onToolEvent?: (event: AgentToolEvent) => void | Promise<void>;
}): Promise<GitHubRepositoryTaskResult> {
  const record = await readPausedRun(pauseId);
  const rootPath = await realpath(record.sandboxRoot);
  const installationToken = await createInstallationToken(record.installationId);
  const executor = createWritableSandboxExecutor(rootPath);
  const collectedToolEvents: AgentToolEvent[] = [...record.toolEvents];
  let result: AgentRunResponse;

  try {
    await emitLifecycleEvent(onLifecycleEvent, "editing", `Continuing paused repository run ${pauseId}.`);
    result = await runAgentTask({
      provider: record.provider,
      model: record.model,
      prompt: await buildResumePrompt(record, rootPath, continuation),
      executor,
      maxToolRounds: githubWriteMaxToolRounds(),
      onToolStart,
      onToolEvent: async (event) => {
        collectedToolEvents.push(event);
        await onToolEvent?.(event);
      }
    });
    await emitLifecycleEvent(onLifecycleEvent, "editing", "Continuation tool loop completed.");
  } catch (error) {
    result = recoverAgentRunResponse(record.provider, record.model, collectedToolEvents, error);
    await emitLifecycleEvent(onLifecycleEvent, "recovered", "Recovered from a provider error during continuation.", "failed");
  }

  result = enrichAgentRunResult(result, collectedToolEvents, record);
  const changedFiles = await changedFileNames(rootPath);
  const committableFiles = await committableChangedFileNames(rootPath, changedFiles);
  if (committableFiles.length === 0) {
    await deletePausedRun(record.id, false);
    return {
      ...result,
      repository: record.repoFullName,
      mode: record.mode,
      branchName: record.branchName,
      changedFiles: [],
      sandboxRoot: rootPath,
      text: `${result.text}\n\nNo non-empty file changes remain, so the paused run was closed without opening a pull request.`
    };
  }

  const immediatePauseReason = immediatePauseReasonForResult(result);
  if (immediatePauseReason) {
    await emitLifecycleEvent(onLifecycleEvent, "paused", `Paused before PR creation: ${pauseReasonLabel(immediatePauseReason)}.`, "paused");
    return pauseGitHubRun({
      installationId: record.installationId,
      repoFullName: record.repoFullName,
      defaultBranch: record.defaultBranch,
      branchName: record.branchName,
      sandboxRoot: rootPath,
      prompt: record.prompt,
      provider: record.provider,
      model: record.model,
      mode: record.mode,
      pauseReason: immediatePauseReason,
      result: { ...result, toolEvents: collectedToolEvents },
      changedFiles: committableFiles,
      pauseId: record.id
    });
  }

  await emitLifecycleEvent(onLifecycleEvent, "validating", "Summarizing validation feedback from the continuation.");
  const review = await reviewGitHubRun({
    provider: record.provider,
    model: record.model,
    repoFullName: record.repoFullName,
    prompt: record.prompt,
    rootPath,
    result,
    changedFiles: committableFiles
  });
  result = withReviewResult({ ...result, toolEvents: collectedToolEvents }, review);
  await emitLifecycleEvent(
    onLifecycleEvent,
    "reviewing",
    review.status === "approved" ? "Reviewer gate approved the continued changes." : "Reviewer gate found issues that need another continuation or a human decision.",
    review.status === "approved" ? "completed" : "paused"
  );

  const gatedPauseReason = pauseReasonForResult(result);
  if (gatedPauseReason) {
    await emitLifecycleEvent(onLifecycleEvent, "needs_review", `Paused before PR creation: ${pauseReasonLabel(gatedPauseReason)}.`, "paused");
    return pauseGitHubRun({
      installationId: record.installationId,
      repoFullName: record.repoFullName,
      defaultBranch: record.defaultBranch,
      branchName: record.branchName,
      sandboxRoot: rootPath,
      prompt: record.prompt,
      provider: record.provider,
      model: record.model,
      mode: record.mode,
      pauseReason: gatedPauseReason,
      result,
      changedFiles: committableFiles,
      pauseId: record.id
    });
  }

  await emitLifecycleEvent(onLifecycleEvent, "opening_pr", "Opening a pull request for the reviewed continuation.");
  const finalized = await finalizeGitHubRun({
    installationId: record.installationId,
    repoFullName: record.repoFullName,
    defaultBranch: record.defaultBranch,
    installationToken: installationToken.token,
    branchName: record.branchName,
    rootPath,
    prompt: record.prompt,
    result: { ...result, toolEvents: collectedToolEvents },
    changedFiles: committableFiles,
    mode: record.mode,
    draft: false
  });
  await deletePausedRun(record.id, false);
  return finalized;
}

export async function actOnPausedGitHubRun({
  pauseId,
  action
}: {
  pauseId: string;
  action: PausedGitHubRunAction;
}): Promise<GitHubRepositoryTaskResult> {
  const record = await readPausedRun(pauseId);

  if (action === "discard") {
    await deletePausedRun(record.id, true);
    return pausedActionResult(record, "Discarded the paused sandbox without opening a pull request.");
  }

  if (action === "stop") {
    await deletePausedRun(record.id, false);
    return pausedActionResult(record, "Stopped the paused run without opening a pull request. The sandbox was left on disk for inspection.");
  }

  const rootPath = await realpath(record.sandboxRoot);
  const installationToken = await createInstallationToken(record.installationId);
  const changedFiles = await committableChangedFileNames(rootPath, await changedFileNames(rootPath));
  if (changedFiles.length === 0) {
    await deletePausedRun(record.id, false);
    return pausedActionResult(record, "No non-empty file changes remain, so no draft pull request was opened.");
  }

  const finalized = await finalizeGitHubRun({
    installationId: record.installationId,
    repoFullName: record.repoFullName,
    defaultBranch: record.defaultBranch,
    installationToken: installationToken.token,
    branchName: record.branchName,
    rootPath,
    prompt: record.prompt,
    result: {
      provider: record.provider,
      model: record.model || "provider-default",
      text: `${record.resultText}\n\nOpened as a draft from a paused run. Pause reason: ${record.pauseReason}.`,
      toolEvents: record.toolEvents,
      status: "paused",
      lifecycleStatus: "paused",
      stopReason: record.pauseReason,
      acceptanceCriteria: record.acceptanceCriteria,
      validation: record.validation,
      review: record.review
    },
    changedFiles,
    mode: record.mode,
    draft: true
  });
  await deletePausedRun(record.id, false);
  return finalized;
}

async function finalizeGitHubRun({
  installationId,
  repoFullName,
  defaultBranch,
  installationToken,
  branchName,
  rootPath,
  prompt,
  result,
  changedFiles,
  mode,
  draft
}: {
  installationId: number;
  repoFullName: string;
  defaultBranch: string;
  installationToken: string;
  branchName: string;
  rootPath: string;
  prompt: string;
  result: AgentRunResponse;
  changedFiles: string[];
  mode: ResolvedGitHubTaskMode;
  draft: boolean;
}): Promise<GitHubRepositoryTaskResult> {
  await runRequired("git", ["add", "-A", "--", ...changedFiles], rootPath, 20_000);
  await runRequired("git", ["commit", "-m", commitTitle(prompt)], rootPath, 60_000);
  await runRequired(
    "git",
    ["push", tokenizedCloneUrl(repoFullName, installationToken), `HEAD:${branchName}`],
    rootPath,
    120_000,
    installationToken
  );

  const pullRequest = await openPullRequest({
    installationId,
    repoFullName,
    title: prTitle(prompt),
    body: prBody(prompt, result, changedFiles),
    head: branchName,
    base: defaultBranch,
    draft
  });

  return {
    ...result,
    repository: repoFullName,
    mode,
    branchName,
    pullRequestUrl: pullRequest.htmlUrl,
    pullRequestNumber: pullRequest.number,
    changedFiles,
    sandboxRoot: rootPath,
    status: draft ? "completed" : result.status,
    lifecycleStatus: "completed"
  };
}

async function pauseGitHubRun({
  installationId,
  repoFullName,
  defaultBranch,
  branchName,
  sandboxRoot,
  prompt,
  provider,
  model,
  mode,
  pauseReason,
  result,
  changedFiles,
  pauseId
}: {
  installationId: number;
  repoFullName: string;
  defaultBranch: string;
  branchName: string;
  sandboxRoot: string;
  prompt: string;
  provider: AgentProvider;
  model?: string;
  mode: ResolvedGitHubTaskMode;
  pauseReason: NonNullable<AgentRunResponse["stopReason"]>;
  result: AgentRunResponse;
  changedFiles: string[];
  pauseId?: string;
}): Promise<GitHubRepositoryTaskResult> {
  const id = pauseId || randomUUID();
  const diffSummary = await gitDiffSummary(sandboxRoot);
  const record: PausedGitHubRunRecord = {
    id,
    installationId,
    repoFullName,
    defaultBranch,
    branchName,
    sandboxRoot,
    prompt,
    provider,
    model,
    mode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pauseReason,
    toolEvents: result.toolEvents,
    resultText: result.text,
    changedFiles,
    diffSummary,
    acceptanceCriteria: result.acceptanceCriteria,
    validation: result.validation,
    review: result.review
  };
  await writePausedRun(record);

  return {
    ...result,
    repository: repoFullName,
    mode,
    branchName,
    changedFiles,
    sandboxRoot,
    pauseId: id,
    pauseReason,
    resumeAvailable: true,
    diffSummary,
    status: "paused",
    lifecycleStatus: "paused",
    stopReason: pauseReason,
    acceptanceCriteria: result.acceptanceCriteria,
    validation: result.validation,
    review: result.review,
    text: [
      result.text,
      "",
      `Paused for confirmation: ${pauseReasonLabel(pauseReason)}.`,
      `Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}.`,
      "Choose Continue, Open Draft PR, Stop Without PR, or Discard Sandbox from the web UI."
    ].join("\n")
  };
}

function pausedActionResult(record: PausedGitHubRunRecord, message: string): GitHubRepositoryTaskResult {
  return {
    provider: record.provider,
    model: record.model || "provider-default",
    text: message,
    toolEvents: record.toolEvents,
    status: "completed",
    lifecycleStatus: "completed",
    acceptanceCriteria: record.acceptanceCriteria,
    validation: record.validation,
    review: record.review,
    repository: record.repoFullName,
    mode: record.mode,
    branchName: record.branchName,
    changedFiles: record.changedFiles,
    sandboxRoot: record.sandboxRoot
  };
}

async function emitLifecycleEvent(
  onLifecycleEvent: ((event: AgentLifecycleEvent) => void | Promise<void>) | undefined,
  status: AgentLifecycleStatus,
  message: string,
  outcome: AgentLifecycleEvent["outcome"] = "completed"
): Promise<void> {
  if (!onLifecycleEvent) return;
  const now = Date.now();
  await onLifecycleEvent({
    id: randomUUID(),
    status,
    message,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    outcome
  });
}

function enrichAgentRunResult(
  result: AgentRunResponse,
  toolEvents: AgentToolEvent[],
  record?: Pick<PausedGitHubRunRecord, "acceptanceCriteria" | "validation" | "review">
): AgentRunResponse {
  const validation = validationChecksFromToolEvents(toolEvents, true);
  return {
    ...result,
    toolEvents,
    lifecycleStatus: result.lifecycleStatus || lifecycleStatusForResult(result),
    acceptanceCriteria: result.acceptanceCriteria || record?.acceptanceCriteria,
    validation: validation.length > 0 ? validation : result.validation || record?.validation,
    review: result.review || record?.review
  };
}

function lifecycleStatusForResult(result: AgentRunResponse): AgentLifecycleStatus {
  if (result.status === "paused") return "paused";
  if (result.status === "recovered") return "recovered";
  return "completed";
}

function validationChecksFromToolEvents(toolEvents: AgentToolEvent[], includeNotRun: boolean): ValidationCheck[] {
  const checks = toolEvents
    .filter((event) => {
      if (event.name !== "run_command") return false;
      const command = asRecord(event.args).command;
      return typeof command === "string" && validationCommandPattern.test(command);
    })
    .map((event) => {
      const data = asRecord(event.result.data);
      const args = asRecord(event.args);
      const command = typeof data.command === "string"
        ? data.command
        : typeof args.command === "string"
          ? args.command
          : "validation command";
      const output = [
        typeof data.stdout === "string" ? data.stdout.trim() : "",
        typeof data.stderr === "string" ? data.stderr.trim() : ""
      ].filter(Boolean).join("\n\n");
      const status: ValidationCheck["status"] = event.result.status === "completed"
        ? "passed"
        : event.result.status === "failed"
          ? "failed"
          : "unknown";

      return {
        command,
        status,
        summary: event.result.summary,
        output: output ? truncateMiddle(output, 6_000) : undefined
      };
    });

  if (checks.length > 0 || !includeNotRun) return checks;
  return [{
    command: "validation",
    status: "not_run",
    summary: "No validation command such as typecheck, lint, test, build, or check was detected in this run."
  }];
}

async function reviewGitHubRun({
  provider,
  model,
  repoFullName,
  prompt,
  rootPath,
  result,
  changedFiles
}: {
  provider: AgentProvider;
  model?: string;
  repoFullName: string;
  prompt: string;
  rootPath: string;
  result: AgentRunResponse;
  changedFiles: string[];
}): Promise<AgentReviewResult> {
  const validation = result.validation?.length
    ? result.validation
    : validationChecksFromToolEvents(result.toolEvents, true);
  const fallbackCriteria = fallbackAcceptanceCriteria(prompt);
  let diff = "(diff unavailable)";
  try {
    diff = await reviewDiff(rootPath, changedFiles);
  } catch (error) {
    diff = `Diff collection failed: ${errorMessage(error)}`;
  }

  if (provider === "mock") {
    return heuristicReviewResult(fallbackCriteria, validation, changedFiles);
  }

  try {
    const review = await runAgentTask({
      provider,
      model: reviewModelForProvider(provider, model),
      prompt: buildReviewPrompt({
        repoFullName,
        userPrompt: prompt,
        agentSummary: result.text,
        changedFiles,
        diff,
        validation
      }),
      executor: disabledReviewExecutor,
      toolsEnabled: false,
      maxToolRounds: 1
    });
    return parseReviewResponse(review.text, fallbackCriteria, validation);
  } catch (error) {
    return {
      status: "unknown",
      summary: `Reviewer pass failed: ${errorMessage(error)}`,
      findings: [
        "The reviewer gate could not complete. Pause the run so a human can inspect the diff or continue with another model."
      ],
      acceptanceCriteria: fallbackCriteria,
      validation
    };
  }
}

async function reviewDiff(rootPath: string, changedFiles: string[]): Promise<string> {
  const diff = await runProcess("git", ["diff", "--", "."], rootPath, 20_000);
  const untracked = await runProcess("git", ["ls-files", "--others", "--exclude-standard"], rootPath, 20_000);
  const untrackedFiles = new Set(untracked.stdout.split(/\r?\n/).filter(Boolean));
  const sections = [diff.stdout.trim()];

  for (const file of changedFiles) {
    if (!untrackedFiles.has(file)) continue;
    const absolutePath = await resolveSandboxPath(rootPath, file);
    if (!existsSync(absolutePath)) continue;
    const info = await stat(absolutePath);
    if (info.isDirectory()) continue;
    const content = await readFile(absolutePath, "utf8");
    sections.push([
      `diff --git a/${file} b/${file}`,
      "new file mode 100644",
      `--- /dev/null`,
      `+++ b/${file}`,
      "@@ new file content @@",
      truncateMiddle(content, 16_000)
    ].join("\n"));
  }

  return truncateMiddle(sections.filter(Boolean).join("\n\n") || "(no diff)", 70_000);
}

function buildReviewPrompt({
  repoFullName,
  userPrompt,
  agentSummary,
  changedFiles,
  diff,
  validation
}: {
  repoFullName: string;
  userPrompt: string;
  agentSummary: string;
  changedFiles: string[];
  diff: string;
  validation: ValidationCheck[];
}): string {
  return [
    "Review this proposed GitHub repository agent run as an enterprise coding-agent quality gate.",
    "Tools are disabled. Use only the request, agent summary, validation feedback, and diff below.",
    "",
    "Return only compact JSON with this shape:",
    "{\"status\":\"approved|needs_work|unknown\",\"summary\":\"short reviewer summary\",\"acceptanceCriteria\":[{\"id\":\"AC1\",\"description\":\"criterion\",\"status\":\"met|partial|failed|unknown\",\"evidence\":\"specific diff or validation evidence\"}],\"validation\":[{\"command\":\"command\",\"status\":\"passed|failed|not_run|unknown\",\"summary\":\"result\"}],\"findings\":[\"specific issue\"]}",
    "",
    "Review standard:",
    "- Derive 3 to 8 concrete acceptance criteria from the user's request before judging the diff.",
    "- Approve only if the diff materially satisfies the requested workflow or behavior.",
    "- Mark needs_work for superficial, color-only, placeholder, hardcoded, comment-only, unused, type-escape, or single-file guessed changes when the request needs broader implementation.",
    "- Mark needs_work if validation failed, if obvious validation was skipped without a good reason, or if the diff introduces likely compile/runtime errors.",
    "- Use unknown only when the provided diff and feedback are insufficient to judge safely.",
    "- Keep evidence specific and concise.",
    "",
    `Repository: ${repoFullName}`,
    "",
    "User request:",
    userPrompt,
    "",
    "Agent summary:",
    truncateMiddle(agentSummary, 12_000),
    "",
    "Changed files:",
    changedFiles.length > 0 ? changedFiles.map((file) => `- ${file}`).join("\n") : "- none",
    "",
    "Validation feedback:",
    JSON.stringify(validation, null, 2),
    "",
    "Diff:",
    diff
  ].join("\n");
}

function parseReviewResponse(
  text: string,
  fallbackCriteria: AcceptanceCriterion[],
  fallbackValidation: ValidationCheck[]
): AgentReviewResult {
  const parsed = parseJsonObject(text);
  if (!parsed) {
    return {
      status: "unknown",
      summary: "Reviewer did not return parseable JSON.",
      findings: [truncateMiddle(text.trim() || "Empty reviewer response.", 2_000)],
      acceptanceCriteria: fallbackCriteria,
      validation: fallbackValidation
    };
  }

  const criteria = normalizeAcceptanceCriteria(parsed.acceptanceCriteria, fallbackCriteria);
  const validation = normalizeValidationChecks(parsed.validation, fallbackValidation);
  const findings = Array.isArray(parsed.findings)
    ? parsed.findings.filter((finding): finding is string => typeof finding === "string").slice(0, 12)
    : [];
  const status = parsed.status === "approved" || parsed.status === "needs_work" || parsed.status === "unknown"
    ? parsed.status
    : "unknown";

  return {
    status,
    summary: typeof parsed.summary === "string" ? parsed.summary : "Reviewer returned structured feedback.",
    findings,
    acceptanceCriteria: criteria,
    validation
  };
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] || text.match(/\{[\s\S]*\}/)?.[0] || text.trim();
  try {
    const parsed = JSON.parse(candidate);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function normalizeAcceptanceCriteria(value: unknown, fallback: AcceptanceCriterion[]): AcceptanceCriterion[] {
  if (!Array.isArray(value)) return fallback;
  const criteria = value
    .map((item, index): AcceptanceCriterion | undefined => {
      const record = asRecord(item);
      const description = typeof record.description === "string" ? record.description.trim() : "";
      if (!description) return undefined;
      return {
        id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : `AC${index + 1}`,
        description,
        status: normalizeCriterionStatus(record.status),
        evidence: typeof record.evidence === "string" && record.evidence.trim() ? record.evidence.trim() : undefined
      };
    })
    .filter((criterion): criterion is AcceptanceCriterion => Boolean(criterion))
    .slice(0, 12);
  return criteria.length > 0 ? criteria : fallback;
}

function normalizeCriterionStatus(value: unknown): AcceptanceCriterion["status"] {
  return value === "met" || value === "partial" || value === "failed" || value === "unknown" ? value : "unknown";
}

function normalizeValidationChecks(value: unknown, fallback: ValidationCheck[]): ValidationCheck[] {
  if (!Array.isArray(value)) return fallback;
  const checks = value
    .map((item): ValidationCheck | undefined => {
      const record = asRecord(item);
      const command = typeof record.command === "string" && record.command.trim() ? record.command.trim() : "";
      if (!command) return undefined;
      return {
        command,
        status: normalizeValidationStatus(record.status),
        summary: typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : "Validation result reported by reviewer.",
        output: typeof record.output === "string" && record.output.trim() ? truncateMiddle(record.output.trim(), 6_000) : undefined
      };
    })
    .filter((check): check is ValidationCheck => Boolean(check))
    .slice(0, 12);
  return checks.length > 0 ? checks : fallback;
}

function normalizeValidationStatus(value: unknown): ValidationCheck["status"] {
  return value === "passed" || value === "failed" || value === "not_run" || value === "unknown" ? value : "unknown";
}

function fallbackAcceptanceCriteria(prompt: string): AcceptanceCriterion[] {
  const request = truncateMiddle(prompt.replace(/\s+/g, " ").trim(), 500);
  return [
    {
      id: "AC1",
      description: `The changes materially address the user request: ${request}`,
      status: "unknown"
    },
    {
      id: "AC2",
      description: "The implementation updates the files that own the requested behavior instead of adding placeholders or superficial edits.",
      status: "unknown"
    },
    {
      id: "AC3",
      description: "Relevant validation is run, or skipped validation is explicitly justified.",
      status: "unknown"
    }
  ];
}

function heuristicReviewResult(
  acceptanceCriteria: AcceptanceCriterion[],
  validation: ValidationCheck[],
  changedFiles: string[]
): AgentReviewResult {
  const failedValidation = validation.some((check) => check.status === "failed");
  const noValidation = validation.every((check) => check.status === "not_run");
  return {
    status: failedValidation || changedFiles.length === 0 ? "needs_work" : "approved",
    summary: "Mock reviewer produced a deterministic review from changed files and validation events.",
    findings: [
      ...(failedValidation ? ["At least one validation command failed."] : []),
      ...(noValidation ? ["No validation command was detected; use a real provider for semantic review."] : [])
    ],
    acceptanceCriteria: acceptanceCriteria.map((criterion) => ({
      ...criterion,
      status: changedFiles.length > 0 ? "met" : "failed",
      evidence: changedFiles.length > 0 ? `Changed files: ${changedFiles.join(", ")}` : "No changed files were produced."
    })),
    validation
  };
}

function withReviewResult(result: AgentRunResponse, review: AgentReviewResult): AgentRunResponse {
  const acceptanceCriteria = review.acceptanceCriteria;
  const validation = review.validation.length > 0 ? review.validation : result.validation;
  return {
    ...result,
    lifecycleStatus: reviewRequiresPause(review) ? "needs_review" : "completed",
    acceptanceCriteria,
    validation,
    review,
    stopReason: reviewRequiresPause(review) ? "review_failed" : result.stopReason
  };
}

function reviewRequiresPause(review?: AgentReviewResult): boolean {
  if (!review) return false;
  if (review.status !== "approved") return true;
  if (review.acceptanceCriteria.some((criterion) => criterion.status === "failed" || criterion.status === "partial")) return true;
  if (review.validation.some((check) => check.status === "failed")) return true;
  return false;
}

function reviewModelForProvider(provider: AgentProvider, selectedModel?: string): string | undefined {
  const globalModel = process.env.GITHUB_REVIEW_MODEL || process.env.AGENT_REVIEW_MODEL;
  if (globalModel) return globalModel;
  if (provider === "openai") return process.env.OPENAI_REVIEW_MODEL || selectedModel;
  if (provider === "anthropic") return process.env.ANTHROPIC_REVIEW_MODEL || selectedModel;
  if (provider === "google") return process.env.GOOGLE_REVIEW_MODEL || selectedModel;
  if (provider === "groq") return process.env.GROQ_REVIEW_MODEL || selectedModel;
  return selectedModel;
}

async function disabledReviewExecutor(_name: DaemonToolName, _args: Record<string, unknown>): Promise<ToolResult> {
  return {
    status: "failed",
    summary: "Tools are disabled for repository review."
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
      if (name === "replace_text") return replaceTextTool(rootPath, args);
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
  const validationError = validateUnifiedPatchInput(patch);
  if (validationError) {
    return toolResult<PatchResult>("failed", validationError, undefined, "medium");
  }
  const checked = await runProcess("git", ["apply", "--whitespace=nowarn", "--check", "-"], rootPath, 20_000, patch);
  if (checked.exitCode !== 0) {
    return toolResult<PatchResult>(
      "failed",
      `Patch failed validation before apply: ${checked.stderr || checked.stdout || "git apply --check failed"}`,
      undefined,
      "medium"
    );
  }
  const applied = await runProcess("git", ["apply", "--whitespace=nowarn", "-"], rootPath, 20_000, patch);
  if (applied.exitCode !== 0) {
    return toolResult<PatchResult>("failed", applied.stderr || "Patch failed to apply.", undefined, "medium");
  }
  const changedFiles = await changedFileNames(rootPath);
  return toolResult("completed", `Applied patch to ${changedFiles.length} file(s).`, { changedFiles });
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
    return toolResult<CreateFileResult>("failed", "File already exists. Use replace_text or apply_patch for edits, or overwrite=true only when replacing it intentionally.");
  }

  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return toolResult("completed", `Created ${requestedPath}.`, {
    path: requestedPath,
    bytes: Buffer.byteLength(content, "utf8")
  });
}

async function replaceTextTool(rootPath: string, args: Record<string, unknown>): Promise<ToolResult<ReplaceTextResult>> {
  const requestedPath = typeof args.path === "string" ? args.path : "";
  const oldText = typeof args.oldText === "string" ? args.oldText : "";
  const newText = typeof args.newText === "string" ? args.newText : undefined;
  const expectedReplacements = typeof args.expectedReplacements === "number"
    ? Math.max(1, Math.min(100, Math.floor(args.expectedReplacements)))
    : 1;

  if (!requestedPath) return toolResult<ReplaceTextResult>("failed", "Missing file path.");
  if (!oldText) return toolResult<ReplaceTextResult>("failed", "Missing oldText.");
  if (newText === undefined) return toolResult<ReplaceTextResult>("failed", "Missing newText.");
  if (oldText === newText) return toolResult<ReplaceTextResult>("failed", "Replacement would not change the file.");

  const absolutePath = await resolveSandboxPath(rootPath, requestedPath);
  if (!existsSync(absolutePath)) return toolResult<ReplaceTextResult>("failed", `File does not exist: ${requestedPath}`);

  const original = await readFile(absolutePath, "utf8");
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
  await writeFile(absolutePath, next, "utf8");
  return toolResult("completed", `Replaced ${replacements} occurrence(s) in ${requestedPath}.`, {
    path: requestedPath,
    replacements,
    bytes: Buffer.byteLength(next, "utf8")
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
  const base = agentSandboxBase();
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
    "",
    "Enterprise delivery loop:",
    "1. Restate the user's product intent in concrete engineering terms.",
    "2. Define acceptance criteria before editing. Include user-visible workflow, state/data behavior, UI controls, persistence/history behavior when relevant, and validation checks.",
    "3. Inspect the repository structure and identify all files that own the requested behavior. Broad feature requests usually cross UI, API, shared types, and state boundaries.",
    "4. Read the relevant source and styling files before editing.",
    "5. Implement a cohesive feature against the acceptance criteria, not a placeholder, comment-only, hardcoded, color-only, or type-escape change.",
    "6. Use create_file for new text files, replace_text for exact localized edits, and apply_patch for larger existing-file edits.",
    "7. Inspect git_diff after editing and compare the diff to every acceptance criterion.",
    "8. Run obvious checks such as typecheck, lint, build, or focused tests. Treat passing typecheck as necessary but not sufficient.",
    "9. If validation fails or an acceptance criterion is unmet, use the feedback to continue fixing before finalizing.",
    "",
    "Do not stop with advice or a written plan when the user asks you to make changes.",
    "For broad UI/design prompts, improve structure, density, hierarchy, spacing, states, and workflow fit as needed; do not treat the task as only changing colors.",
    "When the user says something should look or feel like another tool, translate the relevant interaction and layout qualities into this app without copying protected branding or assets.",
    "Do not claim a broad feature is complete if you only added local placeholder state, unused UI, a hardcoded default, or a partial sketch.",
    "Use create_file for new text files, replace_text for exact localized edits, and apply_patch for larger existing-file edits.",
    "Do not use run_command to create or edit files.",
    "Do not use touch, echo, cat, tee, heredocs, or shell redirection for file edits.",
    "",
    "Replacement protocol:",
    "Use replace_text when you have read the current file and can provide an exact oldText snippet with enough surrounding context to be unique.",
    "If replace_text reports the wrong match count, read the current target lines before retrying with a more precise oldText.",
    "",
    "Patch protocol:",
    "Prefer replace_text over apply_patch for small targeted edits.",
    "Use complete unified diffs with `diff --git a/path b/path`, `---`, `+++`, and valid `@@` hunk headers.",
    "Never submit patch fragments that start at `@@` without file headers.",
    "Prefer small patches that touch one file or one coherent concern at a time.",
    "If apply_patch fails, read the exact current lines around the target before retrying.",
    "Do not retry the same malformed patch. Make the next patch smaller and anchored to current content.",
    "After two failed patches on the same file, stop broad patching and make only a minimal single-hunk correction.",
    "",
    "Final response requirements:",
    "Summarize the implemented behavior, list the acceptance criteria you satisfied, list validation commands and results, and call out remaining gaps or follow-up work. If you cannot satisfy the request, say exactly why.",
    "",
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

export type GitHubTaskModeResolutionRequest = {
  prompt: string;
  requestedMode?: GitHubTaskMode;
  provider?: AgentProvider;
  model?: string;
};

export async function resolveGitHubTaskMode({
  prompt,
  requestedMode = "auto",
  provider = "mock",
  model
}: GitHubTaskModeResolutionRequest): Promise<ResolvedGitHubTaskMode> {
  if (requestedMode === "read" || requestedMode === "write") return requestedMode;

  const modelDecision = await classifyGitHubTaskModeWithModel({ prompt, provider, model });
  return modelDecision || fallbackGitHubTaskMode(prompt);
}

async function classifyGitHubTaskModeWithModel({
  prompt,
  provider,
  model
}: {
  prompt: string;
  provider: AgentProvider;
  model?: string;
}): Promise<ResolvedGitHubTaskMode | undefined> {
  if (provider === "mock") return undefined;

  try {
    const result = await runAgentTask({
      provider,
      model: taskModeClassifierModel(provider, model),
      prompt: [
        "Classify whether a GitHub repository agent should run in read mode or write mode.",
        "",
        "Return only compact JSON with this shape:",
        "{\"mode\":\"read\"|\"write\",\"reason\":\"short reason\"}",
        "",
        "Use read mode when the user asks for explanation, inspection, summary, review, recommendations, planning, comparison, or advice without asking you to change repository files.",
        "Use write mode when the user asks you to make, apply, implement, add, edit, update, fix, remove, refactor, redesign, restyle, polish, or otherwise change repository files, code, docs, UI, styling, or configuration.",
        "If the prompt says to make the required code changes, choose write.",
        "If the prompt is ambiguous but asks you to do or make a repository change, choose write.",
        "",
        `User request: ${prompt}`
      ].join("\n"),
      executor: disabledClassifierExecutor,
      toolsEnabled: false,
      maxToolRounds: 1
    });
    return parseTaskModeClassifierResponse(result.text);
  } catch {
    return undefined;
  }
}

function taskModeClassifierModel(provider: AgentProvider, selectedModel?: string): string | undefined {
  const globalModel = process.env.GITHUB_TASK_MODE_MODEL || process.env.AGENT_TASK_MODE_MODEL;
  if (globalModel) return globalModel;
  if (provider === "openai") return process.env.OPENAI_TASK_MODE_MODEL || selectedModel;
  if (provider === "anthropic") return process.env.ANTHROPIC_TASK_MODE_MODEL || selectedModel;
  if (provider === "google") return process.env.GOOGLE_TASK_MODE_MODEL || selectedModel;
  if (provider === "groq") return process.env.GROQ_TASK_MODE_MODEL || selectedModel;
  return selectedModel;
}

async function disabledClassifierExecutor(): Promise<ToolResult> {
  return {
    status: "failed",
    summary: "Tools are disabled for task-mode classification."
  };
}

function parseTaskModeClassifierResponse(text: string): ResolvedGitHubTaskMode | undefined {
  const trimmed = text.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  const raw = jsonMatch ? jsonMatch[0] : trimmed;
  try {
    const parsed = JSON.parse(raw) as { mode?: unknown };
    if (parsed.mode === "read" || parsed.mode === "write") return parsed.mode;
  } catch {
    const normalized = trimmed.toLowerCase();
    if (/^\s*write\b/.test(normalized)) return "write";
    if (/^\s*read\b/.test(normalized)) return "read";
  }
  return undefined;
}

function fallbackGitHubTaskMode(prompt: string): ResolvedGitHubTaskMode {
  const text = prompt.toLowerCase();
  const explicitReadOnlyPatterns = [
    /\b(do not edit|don't edit|no changes|read[- ]only|without changing|just tell me)\b/,
    /^\s*(explain|summari[sz]e|describe|analy[sz]e|inspect|audit|find|look for|what|why|how|where|which|when|plan|recommend|compare)\b/,
    /\b(tell me|what should|recommend|suggest|advice|ideas)\b/
  ];
  const textOnlyCreationPattern =
    /^\s*(please\s+|can you\s+|could you\s+|would you\s+|i want you to\s+)?(create|write|make)\s+(a\s+|an\s+)?(plan|summary|analysis|explanation|recommendation)\b/;
  const adviceOnlyPattern = /\b(tell me|what should|recommend|suggest|advice|ideas)\b/;
  const implementationVerbPattern =
    /\b(make|apply|implement|edit|update|modify|fix|redesign|restyle|polish|refactor|create|add|remove|delete)\b/;
  const pullRequestPattern = /\b(open|make|submit|raise)\b[\s\S]{0,40}\b(pr|pull request)\b/;
  const directChangePattern =
    /\b(make|apply|implement|edit|change|changes|update|modify|fix|redesign|restyle|polish|refactor|create|add|remove|delete)\b/;
  const repositoryTargetPattern =
    /\b(code|file|files|ui|ux|interface|frontend|front[- ]end|css|style|styles|styling|layout|component|docs|readme|test|route|endpoint|config)\b/;

  if (pullRequestPattern.test(text)) return "write";
  if (textOnlyCreationPattern.test(text)) return "read";
  if (adviceOnlyPattern.test(text) && !implementationVerbPattern.test(text)) return "read";
  if (explicitReadOnlyPatterns.some((pattern) => pattern.test(text)) && !directChangePattern.test(text)) return "read";
  if (directChangePattern.test(text) && repositoryTargetPattern.test(text)) return "write";
  if (/\bmake\b[\s\S]{0,80}\b(look|feel|match|resemble)\b/.test(text)) return "write";
  return "read";
}

function immediatePauseReasonForResult(result: AgentRunResponse): AgentRunResponse["stopReason"] | undefined {
  if (result.stopReason === "max_tool_rounds" || result.stopReason === "provider_error") return result.stopReason;
  return undefined;
}

function pauseReasonForResult(result: AgentRunResponse): AgentRunResponse["stopReason"] | undefined {
  if (result.stopReason === "max_tool_rounds" || result.stopReason === "provider_error") return result.stopReason;
  if (hasFailedValidation(result.toolEvents)) return "validation_failed";
  if (result.validation?.some((check) => check.status === "failed")) return "validation_failed";
  if (result.stopReason === "review_failed") return result.stopReason;
  if (reviewRequiresPause(result.review)) return "review_failed";
  return undefined;
}

function hasFailedValidation(toolEvents: AgentToolEvent[]): boolean {
  const latestValidation = [...toolEvents].reverse().find((event) => {
    if (event.name !== "run_command") return false;
    const command = asRecord(event.args).command;
    return typeof command === "string" && validationCommandPattern.test(command);
  });
  return latestValidation?.result.status === "failed";
}

async function buildResumePrompt(record: PausedGitHubRunRecord, rootPath: string, continuation?: string): Promise<string> {
  const status = await runProcess("git", ["status", "--short"], rootPath, 20_000);
  let diff = "(diff unavailable)";
  try {
    diff = await reviewDiff(rootPath, await changedFileNames(rootPath));
  } catch (error) {
    diff = `Diff collection failed: ${errorMessage(error)}`;
  }
  const recentFailures = record.toolEvents
    .filter((event) => event.result.status !== "completed")
    .slice(-6)
    .map((event) => `- ${event.name}: ${event.result.summary}${compactCommandOutput(event)}`)
    .join("\n") || "- No failed tool calls were recorded before the pause.";
  const criteriaFeedback = record.acceptanceCriteria?.length
    ? record.acceptanceCriteria.map((criterion) => `- ${criterion.id} [${criterion.status}]: ${criterion.description}${criterion.evidence ? ` Evidence: ${criterion.evidence}` : ""}`).join("\n")
    : "- No structured acceptance criteria were stored for this pause.";
  const validationFeedback = record.validation?.length
    ? record.validation.map((check) => `- ${check.command} [${check.status}]: ${check.summary}${check.output ? `\n  ${truncateMiddle(check.output, 3_000)}` : ""}`).join("\n")
    : "- No validation feedback was stored for this pause.";
  const reviewFeedback = record.review
    ? [
      `Reviewer status: ${record.review.status}`,
      `Reviewer summary: ${record.review.summary}`,
      record.review.findings.length > 0 ? `Findings:\n${record.review.findings.map((finding) => `- ${finding}`).join("\n")}` : "Findings: none"
    ].join("\n")
    : "No reviewer feedback was stored for this pause.";

  return [
    `Repository: ${record.repoFullName}`,
    `Base branch: ${record.defaultBranch}`,
    `Working branch: ${record.branchName}`,
    "",
    "Continue the paused GitHub repository task in the existing sandbox.",
    "Do not restart the task from scratch. Preserve the user's intent and the useful edits already made.",
    "Use the current diff and recent failed tool output as feedback. Read files again when exact context is needed.",
    "Reconstruct or update the acceptance criteria for the original request before editing further.",
    "Compare the current diff against those acceptance criteria and close the highest-impact gaps first.",
    "If validation failed, fix the compiler or test errors before opening a pull request.",
    "Do not treat a passing typecheck as complete if user-visible workflow criteria are still missing.",
    "If you reach a checkpoint again, leave the workspace in the best possible state for another continuation.",
    "",
    `Original user request: ${record.prompt}`,
    continuation?.trim() ? `User continuation instruction: ${continuation.trim()}` : "",
    "",
    `Pause reason: ${pauseReasonLabel(record.pauseReason)}`,
    "",
    "Recent failed or blocked tool feedback:",
    recentFailures,
    "",
    "Stored acceptance criteria feedback:",
    criteriaFeedback,
    "",
    "Stored validation feedback:",
    validationFeedback,
    "",
    "Stored reviewer feedback:",
    reviewFeedback,
    "",
    "Current git status:",
    status.stdout.trim() || "(clean)",
    "",
    "Current diff:",
    truncateMiddle(diff.trim() || "(no diff)", 28_000)
  ].filter(Boolean).join("\n");
}

function compactCommandOutput(event: AgentToolEvent): string {
  const data = asRecord(event.result.data);
  const stdout = typeof data.stdout === "string" && data.stdout.trim()
    ? `\n  stdout: ${truncateMiddle(data.stdout.trim(), 4_000)}`
    : "";
  const stderr = typeof data.stderr === "string" && data.stderr.trim()
    ? `\n  stderr: ${truncateMiddle(data.stderr.trim(), 4_000)}`
    : "";
  return `${stdout}${stderr}`;
}

async function gitDiffSummary(rootPath: string): Promise<string> {
  const statResult = await runProcess("git", ["diff", "--stat", "--", "."], rootPath, 20_000);
  const changedFiles = await changedFileNames(rootPath);
  return [
    statResult.stdout.trim(),
    changedFiles.length > 0 ? `\nChanged files:\n${changedFiles.join("\n")}` : ""
  ].filter(Boolean).join("\n") || "No diff.";
}

async function readPausedRun(pauseId: string): Promise<PausedGitHubRunRecord> {
  assertSafePauseId(pauseId);
  const content = await readFile(pausedRunPath(pauseId), "utf8");
  return JSON.parse(content) as PausedGitHubRunRecord;
}

async function writePausedRun(record: PausedGitHubRunRecord): Promise<void> {
  await mkdir(pausedRunsDirectory(), { recursive: true });
  await writeFile(pausedRunPath(record.id), JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

async function deletePausedRun(pauseId: string, discardSandbox: boolean): Promise<void> {
  const record = await readPausedRun(pauseId);
  await rm(pausedRunPath(pauseId), { force: true });
  if (discardSandbox) await removeSandbox(record.sandboxRoot);
}

async function removeSandbox(sandboxRoot: string): Promise<void> {
  const base = agentSandboxBase();
  const target = path.resolve(sandboxRoot);
  const baseWithSeparator = `${base}${path.sep}`;
  if (!target.startsWith(baseWithSeparator) || !path.basename(target).startsWith("github-pr-")) {
    throw new Error("Refusing to discard a path that does not look like an agent sandbox.");
  }
  await rm(target, { recursive: true, force: true });
}

function pausedRunsDirectory(): string {
  return path.join(agentSandboxBase(), "paused-runs");
}

function pausedRunPath(pauseId: string): string {
  assertSafePauseId(pauseId);
  return path.join(pausedRunsDirectory(), `${pauseId}.json`);
}

function assertSafePauseId(pauseId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(pauseId)) throw new Error("Invalid paused run id.");
}

function githubWriteMaxToolRounds(): number {
  const configured = Number(process.env.GITHUB_WRITE_MAX_TOOL_ROUNDS);
  return Number.isFinite(configured) ? Math.max(4, Math.min(80, Math.floor(configured))) : 18;
}

function pauseReasonLabel(reason: NonNullable<AgentRunResponse["stopReason"]>): string {
  if (reason === "max_tool_rounds") return "the run reached the tool-round checkpoint";
  if (reason === "provider_error") return "the model provider failed after partial progress";
  if (reason === "validation_failed") return "validation failed after file changes";
  if (reason === "review_failed") return "the reviewer gate found unmet acceptance criteria";
  return reason;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    "## Acceptance Criteria",
    "",
    ...(result.acceptanceCriteria?.length
      ? result.acceptanceCriteria.map((criterion) => `- ${criterion.id} [${criterion.status}]: ${criterion.description}${criterion.evidence ? ` — ${criterion.evidence}` : ""}`)
      : ["- No structured acceptance criteria were captured."]),
    "",
    "## Validation",
    "",
    ...(result.validation?.length
      ? result.validation.map((check) => `- ${check.command} [${check.status}]: ${check.summary}`)
      : ["- No validation checks were captured."]),
    "",
    "## Reviewer Gate",
    "",
    result.review ? `Status: ${result.review.status}` : "Status: not_run",
    result.review ? `Summary: ${result.review.summary}` : "",
    ...(result.review?.findings.length
      ? ["", ...result.review.findings.map((finding) => `- ${finding}`)]
      : []),
    "",
    "## Run Status",
    "",
    `Status: ${result.status || "completed"}`,
    result.lifecycleStatus ? `Lifecycle status: ${result.lifecycleStatus}` : "",
    result.stopReason ? `Stop reason: ${result.stopReason}` : "",
    "",
    "## Safety",
    "",
    "This PR was created from an `agent/*` branch. The agent did not merge or approve this PR."
  ].join("\n");
}

function recoverAgentRunResponse(
  provider: AgentProvider,
  model: string | undefined,
  toolEvents: AgentToolEvent[],
  error: unknown
): AgentRunResponse {
  return {
    provider,
    model: model || "provider-default",
    toolEvents,
    status: "recovered",
    lifecycleStatus: "recovered",
    stopReason: "provider_error",
    text: [
      "The model provider failed before returning a final response, so the repository workflow recovered from the error.",
      "",
      `Provider error: ${errorMessage(error)}`,
      "",
      "Any non-empty file changes produced before the failure were still inspected and handled by the GitHub workflow."
    ].join("\n")
  };
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

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const edge = Math.max(1, Math.floor((maxChars - 80) / 2));
  return `${value.slice(0, edge)}\n\n[...${value.length - (edge * 2)} characters omitted...]\n\n${value.slice(-edge)}`;
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

function redact(value: string, secret?: string): string {
  if (!secret) return value;
  return value.replaceAll(secret, "[redacted]");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function agentSandboxBase(): string {
  return path.resolve(process.env.AGENT_SANDBOX_ROOT || path.resolve(process.cwd(), "../..", ".agent-sandboxes"));
}
