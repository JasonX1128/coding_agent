"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_DAEMON_ORIGIN,
  type AgentProvider,
  type AgentRunResponse,
  type AgentStreamEvent,
  type AgentToolEvent,
  type AgentToolStartEvent,
  type Workspace
} from "@coding-agent/shared";

type DaemonStatus = "unknown" | "online" | "offline";
type ActiveTab = "local" | "github";

type ToolPayload = {
  status?: string;
  summary?: string;
  data?: unknown;
  error?: string;
};

type GitHubRepository = {
  id: number;
  installationId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
};

type GitHubTaskResult = AgentRunResponse & {
  repository?: string;
  mode?: "read" | "write";
  branchName?: string;
  pullRequestUrl?: string;
  pullRequestNumber?: number;
  changedFiles?: string[];
  sandboxRoot?: string;
};

type GitHubPullRequest = {
  id: number;
  number: number;
  title: string;
  state: string;
  draft: boolean;
  htmlUrl: string;
  authorLogin: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  createdAt: string;
  updatedAt: string;
};

type LiveToolEvent = AgentToolStartEvent & {
  result?: AgentToolEvent["result"];
  finishedAt?: number;
  durationMs?: number;
};

type RunTimer = {
  startedAt: number;
  finishedAt?: number;
};

type ActivityEntry = {
  id: string;
  time: number;
  message: string;
  tone: "info" | "running" | "done" | "error";
};

export default function Home() {
  const [activeTab, setActiveTab] = useState<ActiveTab>("local");
  const [daemonOrigin, setDaemonOrigin] = useState(DEFAULT_DAEMON_ORIGIN);
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus>("unknown");
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState("default");
  const [workspacePath, setWorkspacePath] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("mock");
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("Inspect this repository and summarize what is implemented.");
  const [agentResult, setAgentResult] = useState<AgentRunResponse | null>(null);
  // Supporting Chat History
  const [chatSessions, setChatSessions] = useState<Record<string, { id: string; title: string; messages: { prompt: string; result: AgentRunResponse; timestamp: number }[] }>>({});
  const [currentChatId, setCurrentChatId] = useState<string>("default");

  const [localToolEvents, setLocalToolEvents] = useState<LiveToolEvent[]>([]);
  const [localRunTimer, setLocalRunTimer] = useState<RunTimer | null>(null);
  const [localActivity, setLocalActivity] = useState<ActivityEntry[]>([]);
  const [toolOutput, setToolOutput] = useState<ToolPayload | null>(null);
  const [selectedFile, setSelectedFile] = useState("DEVELOPMENT_AGENT_PLAN.md");
  const [searchQuery, setSearchQuery] = useState("agent");
  const [command, setCommand] = useState("npm run typecheck");
  const [patch, setPatch] = useState("");
  const [githubInstallUrl, setGithubInstallUrl] = useState("/api/github/install");
  const [githubRepos, setGithubRepos] = useState<GitHubRepository[]>([]);
  const [githubRepoFullName, setGithubRepoFullName] = useState("");
  const [githubPrompt, setGithubPrompt] = useState("Inspect this repository and summarize what it does.");
  const [githubResult, setGithubResult] = useState<GitHubTaskResult | null>(null);
  const [githubToolEvents, setGithubToolEvents] = useState<LiveToolEvent[]>([]);
  const [githubRunTimer, setGithubRunTimer] = useState<RunTimer | null>(null);
  const [githubActivity, setGithubActivity] = useState<ActivityEntry[]>([]);
  const [githubPullRequests, setGithubPullRequests] = useState<GitHubPullRequest[]>([]);
  const [githubPullMessage, setGithubPullMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId),
    [workspaceId, workspaces]
  );
  const selectedGithubRepo = useMemo(
    () => githubRepos.find((repo) => repo.fullName === githubRepoFullName),
    [githubRepoFullName, githubRepos]
  );

  useEffect(() => {
    const interval = window.setInterval(() => setClockNow(Date.now()), 200);
    return () => window.clearInterval(interval);
  }, []);

  async function connectDaemon() {
    setBusy("daemon");
    setError(null);
    try {
      const response = await fetch(`${daemonOrigin}/health`);
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Daemon health check failed.");
      setDaemonStatus("online");
      setWorkspaces(data.workspaces || []);
      if (data.workspaces?.[0]?.id) setWorkspaceId(data.workspaces[0].id);
      setToolOutput({
        status: "completed",
        summary: `Connected to daemon with ${data.workspaces?.length || 0} workspace(s).`,
        data
      });
    } catch (caught) {
      setDaemonStatus("offline");
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function addWorkspace() {
    setBusy("workspace");
    setError(null);
    try {
      const response = await fetch(`${daemonOrigin}/workspaces`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rootPath: workspacePath })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || data?.summary || "Could not add workspace.");
      await connectDaemon();
      setWorkspaceId(data.workspace.id);
      setWorkspacePath("");
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function callDaemonTool(tool: string, body: Record<string, unknown> = {}) {
    setBusy(tool);
    setError(null);
    try {
      const response = await fetch(`${daemonOrigin}/tools/${tool}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId, ...body })
      });
      const data = await response.json();
      setToolOutput(data);
      if (!response.ok && data?.status !== "requires_approval") {
        throw new Error(data?.error || data?.summary || `${tool} failed.`);
      }
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function runLocalAgent() {
    const startedAt = Date.now();
    const runContext = selectedWorkspace?.rootPath || workspaceId;
    setBusy("agent");
    setError(null);
    setAgentResult(null);
    setLocalToolEvents([]);
    setLocalRunTimer({ startedAt });
    setLocalActivity([createActivityEntry(
      `Starting local run with ${provider}${model ? ` (${model})` : ""} in ${runContext}.`,
      "running",
      startedAt
    )]);
    try {
      const response = await fetch("/api/agent/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model: model || undefined,
          prompt,
          daemonOrigin,
          workspaceId
        })
      });

      // Update session history
      const data = await readAgentStream<AgentRunResponse>(response, {
        onToolStart: (event) => {
          setLocalToolEvents((current) => upsertLiveToolEvent(current, event));
          setLocalActivity((current) => [
            ...current,
            createActivityEntry(describeToolStart(event), "running", event.startedAt, `${event.id}:start`)
          ]);
        },
        onToolEvent: (event) => {
          setLocalToolEvents((current) => upsertLiveToolEvent(current, event));
          setLocalActivity((current) => [
            ...current,
            createActivityEntry(describeToolFinish(event), activityToneForTool(event), event.finishedAt, `${event.id}:finish`)
          ]);
        }
      });

      setAgentResult(data);

      setChatSessions((prev) => {
        const session = prev[currentChatId] || { id: currentChatId, title: prompt.slice(0, 30), messages: [] };
        return {
          ...prev,
          [currentChatId]: {
            ...session,
            messages: [
              ...session.messages,
              { prompt, result: data, timestamp: Date.now() }
            ]
          }
        };
      });

      setLocalActivity((current) => [
        ...current,
        createActivityEntry(describeRunFinish(startedAt, Date.now(), data.toolEvents), "done")
      ]);
    } catch (caught) {
      setLocalActivity((current) => [
        ...current,
        createActivityEntry(`Run stopped with an error: ${errorMessage(caught)}`, "error")
      ]);
      setError(errorMessage(caught));
    } finally {
      setLocalRunTimer((current) => current && current.startedAt === startedAt
        ? { ...current, finishedAt: Date.now() }
        : current);
      setBusy(null);
    }
  }

  async function runGithubAgent() {
    const startedAt = Date.now();
    setBusy("github-agent");
    setError(null);
    setGithubResult(null);
    setGithubToolEvents([]);
    setGithubRunTimer({ startedAt });
    setGithubActivity([createActivityEntry(
      `Starting GitHub repository run for ${selectedGithubRepo?.fullName || "the selected repository"} with ${provider}${model ? ` (${model})` : ""}.`,
      "running",
      startedAt
    )]);
    try {
      if (!selectedGithubRepo) throw new Error("Select an installed GitHub repository first.");
      const response = await fetch("/api/github/tasks/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: selectedGithubRepo.installationId,
          repoFullName: selectedGithubRepo.fullName,
          prompt: githubPrompt,
          provider,
          model: model || undefined,
          mode: "auto"
        })
      });
      const data = await readAgentStream<GitHubTaskResult>(response, {
        onToolStart: (event) => {
          setGithubToolEvents((current) => upsertLiveToolEvent(current, event));
          setGithubActivity((current) => [
            ...current,
            createActivityEntry(describeToolStart(event), "running", event.startedAt, `${event.id}:start`)
          ]);
        },
        onToolEvent: (event) => {
          setGithubToolEvents((current) => upsertLiveToolEvent(current, event));
          setGithubActivity((current) => [
            ...current,
            createActivityEntry(describeToolFinish(event), activityToneForTool(event), event.finishedAt, `${event.id}:finish`)
          ]);
        }
      });
      setGithubResult(data);
      setGithubActivity((current) => [
        ...current,
        createActivityEntry(describeGitHubRunFinish(startedAt, Date.now(), data), "done")
      ]);
    } catch (caught) {
      setGithubActivity((current) => [
        ...current,
        createActivityEntry(`Run stopped with an error: ${errorMessage(caught)}`, "error")
      ]);
      setError(errorMessage(caught));
    } finally {
      setGithubRunTimer((current) => current && current.startedAt === startedAt
        ? { ...current, finishedAt: Date.now() }
        : current);
      setBusy(null);
    }
  }

  function selectGithubRepo(fullName: string) {
    setGithubRepoFullName(fullName);
    setGithubPullRequests([]);
    setGithubPullMessage("");
  }

  async function fetchGithubPullRequestsForSelected(): Promise<GitHubPullRequest[]> {
    if (!selectedGithubRepo) throw new Error("Select an installed GitHub repository first.");
    const params = new URLSearchParams({
      installationId: String(selectedGithubRepo.installationId),
      repoFullName: selectedGithubRepo.fullName
    });
    const response = await fetch(`/api/github/pulls?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error || "Could not load GitHub pull requests.");
    return Array.isArray(data.pullRequests) ? data.pullRequests : [];
  }

  async function loadGithubPullRequests() {
    setBusy("github-pulls");
    setError(null);
    try {
      const pullRequests = await fetchGithubPullRequestsForSelected();
      setGithubPullRequests(pullRequests);
      setGithubPullMessage(`Loaded ${pullRequests.length} open agent pull request(s).`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function updateGithubPullRequest(number: number, action: "approve" | "close") {
    const label = action === "approve" ? "approve" : "close";
    const confirmed = window.confirm(`Confirm that you want to ${label} pull request #${number}.`);
    if (!confirmed) return;

    setBusy(`github-pr-${action}-${number}`);
    setError(null);
    try {
      if (!selectedGithubRepo) throw new Error("Select an installed GitHub repository first.");
      const response = await fetch("/api/github/pulls/actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          installationId: selectedGithubRepo.installationId,
          repoFullName: selectedGithubRepo.fullName,
          number,
          action,
          confirmation: action
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `Could not ${action} pull request.`);
      setGithubPullMessage(data.summary || `Pull request #${number} updated.`);
      setToolOutput({
        status: "completed",
        summary: data.summary || `Pull request #${number} updated.`,
        data
      });
      setGithubPullRequests(await fetchGithubPullRequestsForSelected());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function loadGithubRepositories() {
    setBusy("github-repos");
    setError(null);
    try {
      const response = await fetch("/api/github/repositories");
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Could not load GitHub repositories.");
      const repositories = Array.isArray(data.repositories) ? data.repositories : [];
      setGithubInstallUrl(data.installUrl || "/api/github/install");
      setGithubRepos(repositories);
      if (!githubRepoFullName && repositories[0]?.fullName) {
        selectGithubRepo(repositories[0].fullName);
      }
      setToolOutput({
        status: "completed",
        summary: `Loaded ${repositories.length} GitHub repositories available to the app.`,
        data
      });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  const eventList = activeTab === "github"
    ? githubResult?.toolEvents || githubToolEvents
    : agentResult?.toolEvents || localToolEvents;
  const activityList = activeTab === "github" ? githubActivity : localActivity;
  const activeRunTimer = activeTab === "github" ? githubRunTimer : localRunTimer;

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand">
          <h1>Coding Agent MVP</h1>
          <span>Local daemon tools plus prompt-driven GitHub repository tasks.</span>
        </div>
        <div className={`status-pill ${daemonStatus === "online" ? "ok" : ""}`}>
          daemon: {daemonStatus}
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <section className="stack">
            <h2>Connection</h2>
            <label className="stack">
              <span className="hint">Daemon origin</span>
              <input value={daemonOrigin} onChange={(event) => setDaemonOrigin(event.target.value)} />
            </label>
            <button className="primary" disabled={busy === "daemon"} onClick={connectDaemon}>
              Connect
            </button>
            <label className="stack">
              <span className="hint">Workspace</span>
              <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
                {workspaces.length === 0 ? <option value="default">default</option> : null}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.rootPath}
                  </option>
                ))}
              </select>
            </label>
            <div className="statusline">{selectedWorkspace?.rootPath || "No workspace loaded yet."}</div>
          </section>

          <section className="stack">
            <h2>Add Workspace</h2>
            <input
              placeholder="/path/to/repository"
              value={workspacePath}
              onChange={(event) => setWorkspacePath(event.target.value)}
            />
            <button disabled={!workspacePath || busy === "workspace"} onClick={addWorkspace}>
              Add
            </button>
          </section>

          <section className="stack">
            <h2>Model</h2>
            <div className="two">
              <select value={provider} onChange={(event) => setProvider(event.target.value as AgentProvider)}>
                <option value="mock">mock</option>
                <option value="openai">openai</option>
                <option value="anthropic">anthropic</option>
                <option value="google">google</option>
                <option value="groq">groq</option>
              </select>
              <input placeholder="model override" value={model} onChange={(event) => setModel(event.target.value)} />
            </div>
          </section>

          <section className="stack">
            <h2>Workspace Tools</h2>
            <button onClick={() => callDaemonTool("list_files", { path: ".", maxFiles: 160 })}>
              List files
            </button>
            <button onClick={() => callDaemonTool("git_status")}>Git status</button>
            <button onClick={() => callDaemonTool("git_diff")}>Git diff</button>
          </section>
        </aside>

        <section className="main-grid">
          <div className="stack">
            <div className="panel">
              <div className="tabs">
                <button className={`tab ${activeTab === "local" ? "active" : ""}`} onClick={() => setActiveTab("local")}>
                  Local
                </button>
                <button className={`tab ${activeTab === "github" ? "active" : ""}`} onClick={() => setActiveTab("github")}>
                  GitHub
                </button>
              </div>
            </div>

            {activeTab === "local" ? (
              <LocalAgentPanel
                prompt={prompt}
                setPrompt={setPrompt}
                runLocalAgent={runLocalAgent}
                busy={busy}
                agentResult={agentResult}
                chatSessions={chatSessions}
                currentChatId={currentChatId}
                runTimer={localRunTimer}
                now={clockNow}
              />
            ) : (
              <GithubAgentPanel
                githubInstallUrl={githubInstallUrl}
                githubRepos={githubRepos}
                githubRepoFullName={githubRepoFullName}
                setGithubRepoFullName={selectGithubRepo}
                githubPrompt={githubPrompt}
                setGithubPrompt={setGithubPrompt}
                loadGithubRepositories={loadGithubRepositories}
                loadGithubPullRequests={loadGithubPullRequests}
                updateGithubPullRequest={updateGithubPullRequest}
                runGithubAgent={runGithubAgent}
                busy={busy}
                githubResult={githubResult}
                githubPullRequests={githubPullRequests}
                githubPullMessage={githubPullMessage}
                runTimer={githubRunTimer}
                now={clockNow}
              />
            )}

            <section className="panel stack">
              <h2>Run Activity</h2>
              <RunActivity entries={activityList} timer={activeRunTimer} now={clockNow} />
            </section>

            <section className="panel stack">
              <h2>Tool Events</h2>
              <ToolEvents events={eventList || []} now={clockNow} />
            </section>
          </div>

          <div className="stack">
            <section className="panel stack">
              <h2>Direct Tool Output</h2>
              {error ? <div className="error">{error}</div> : null}
              <pre>{toolOutput ? JSON.stringify(toolOutput, null, 2) : "No direct tool output yet."}</pre>
            </section>

            <section className="panel stack">
              <h2>Read File</h2>
              <div className="row">
                <input value={selectedFile} onChange={(event) => setSelectedFile(event.target.value)} />
                <button onClick={() => callDaemonTool("read_file", { path: selectedFile })}>Read</button>
              </div>
            </section>

            <section className="panel stack">
              <h2>Search</h2>
              <div className="row">
                <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
                <button onClick={() => callDaemonTool("search_text", { query: searchQuery })}>Search</button>
              </div>
            </section>

            <section className="panel stack">
              <h2>Patch</h2>
              <textarea
                rows={8}
                placeholder="Paste a unified diff patch here."
                value={patch}
                onChange={(event) => setPatch(event.target.value)}
              />
              <button disabled={!patch.trim()} onClick={() => callDaemonTool("apply_patch", { patch })}>
                Apply Patch
              </button>
            </section>

            <section className="panel stack">
              <h2>Command</h2>
              <input value={command} onChange={(event) => setCommand(event.target.value)} />
              <div className="row">
                <button onClick={() => callDaemonTool("run_command", { command })}>Run</button>
                <button onClick={() => callDaemonTool("run_command", { command, allowRisky: true })}>
                  Run With Approval
                </button>
              </div>
              <span className="hint">High-risk shell syntax is blocked unless explicitly approved.</span>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function LocalAgentPanel({
  prompt,
  setPrompt,
  runLocalAgent,
  busy,
  agentResult,
  chatSessions,
  currentChatId,
  runTimer,
  now
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  runLocalAgent: () => void;
  busy: string | null;
  agentResult: AgentRunResponse | null;
  chatSessions: Record<string, { id: string; title: string; messages: { prompt: string; result: AgentRunResponse; timestamp: number }[] }>;
  currentChatId: string;
  runTimer: RunTimer | null;
  now: number;
}) {
  return (
    <section className="panel stack">
      <div className="section-header">
        <h2>Local Agent</h2>
        <RunTimerBadge timer={runTimer} now={now} />
      </div>
      <textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      <button className="primary" disabled={busy === "agent" || !prompt.trim()} onClick={runLocalAgent}>
        Run Local Agent
      </button>
      {chatSessions[currentChatId]?.messages.map((m, i) => (
        <pre key={i} className="chat-output">
          <strong>Prompt:</strong> {m.prompt}<br/>
          <strong>Result:</strong> {m.result.text}
        </pre>
      ))}
    </section>
  );
}

function GithubAgentPanel({
  githubInstallUrl,
  githubRepos,
  githubRepoFullName,
  setGithubRepoFullName,
  githubPrompt,
  setGithubPrompt,
  loadGithubRepositories,
  loadGithubPullRequests,
  updateGithubPullRequest,
  runGithubAgent,
  busy,
  githubResult,
  githubPullRequests,
  githubPullMessage,
  runTimer,
  now
}: {
  githubInstallUrl: string;
  githubRepos: GitHubRepository[];
  githubRepoFullName: string;
  setGithubRepoFullName: (value: string) => void;
  githubPrompt: string;
  setGithubPrompt: (value: string) => void;
  loadGithubRepositories: () => void;
  loadGithubPullRequests: () => void;
  updateGithubPullRequest: (number: number, action: "approve" | "close") => void;
  runGithubAgent: () => void;
  busy: string | null;
  githubResult: GitHubTaskResult | null;
  githubPullRequests: GitHubPullRequest[];
  githubPullMessage: string;
  runTimer: RunTimer | null;
  now: number;
}) {
  return (
    <section className="panel stack">
      <div className="section-header">
        <h2>GitHub Agent</h2>
        <RunTimerBadge timer={runTimer} now={now} />
      </div>
      <div className="row">
        <a className="button-link" href={githubInstallUrl}>
          Install App
        </a>
        <button disabled={busy === "github-repos"} onClick={loadGithubRepositories}>
          Load Repositories
        </button>
      </div>
      <label className="stack">
        <span className="hint">Installed repository</span>
        <select value={githubRepoFullName} onChange={(event) => setGithubRepoFullName(event.target.value)}>
          {githubRepos.length === 0 ? <option value="">No repositories loaded</option> : null}
          {githubRepos.map((repo) => (
            <option key={`${repo.installationId}:${repo.id}`} value={repo.fullName}>
              {repo.fullName} · {repo.defaultBranch}{repo.private ? " · private" : ""}
            </option>
          ))}
        </select>
      </label>
      <textarea rows={5} value={githubPrompt} onChange={(event) => setGithubPrompt(event.target.value)} />
      <button className="primary" disabled={busy === "github-agent" || !githubRepoFullName || !githubPrompt.trim()} onClick={runGithubAgent}>
        Run Agent
      </button>
      <div className="statusline">
        {githubResult?.pullRequestUrl ? (
          <a href={githubResult.pullRequestUrl} target="_blank" rel="noreferrer">
            Pull request #{githubResult.pullRequestNumber}: {githubResult.pullRequestUrl}
          </a>
        ) : githubResult?.repository ? (
          `Repository: ${githubResult.repository} · ${githubResult.mode === "write" ? "write run" : "read-only run"}`
        ) : (
          "Install the GitHub App, load repositories, then select one and prompt the agent."
        )}
      </div>
      <pre className="chat-output">{githubResult?.text || "No GitHub agent result yet."}</pre>

      <div className="divider" />

      <div className="section-header">
        <h3>Open Agent Pull Requests</h3>
        <button disabled={busy === "github-pulls" || !githubRepoFullName} onClick={loadGithubPullRequests}>
          Refresh
        </button>
      </div>
      <span className="hint">
        Actions require browser confirmation and are submitted by the GitHub App identity.
      </span>
      {githubPullMessage ? <div className="statusline">{githubPullMessage}</div> : null}
      {githubPullRequests.length === 0 ? (
        <div className="muted">No open agent pull requests loaded.</div>
      ) : (
        <div className="pr-list">
          {githubPullRequests.map((pullRequest) => (
            <article className="pr-card" key={pullRequest.id}>
              <div className="pr-main">
                <a href={pullRequest.htmlUrl} target="_blank" rel="noreferrer">
                  #{pullRequest.number} {pullRequest.title}
                </a>
                <div className="pr-meta">
                  {pullRequest.headRef} → {pullRequest.baseRef}
                  {pullRequest.draft ? " · draft" : ""} · updated {formatRelativeDate(pullRequest.updatedAt)}
                </div>
              </div>
              <div className="pr-actions">
                <button
                  disabled={busy === `github-pr-approve-${pullRequest.number}`}
                  onClick={() => updateGithubPullRequest(pullRequest.number, "approve")}
                >
                  Approve
                </button>
                <button
                  className="danger"
                  disabled={busy === `github-pr-close-${pullRequest.number}`}
                  onClick={() => updateGithubPullRequest(pullRequest.number, "close")}
                >
                  Close
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ToolEvents({ events, now }: { events: LiveToolEvent[]; now: number }) {
  if (events.length === 0) {
    return <div className="muted">No tool events yet.</div>;
  }

  return (
    <div className="stack">
      {events.map((event) => {
        const elapsedMs = event.durationMs ?? Math.max(0, (event.finishedAt || now) - event.startedAt);
        return (
          <div className="event" key={event.id}>
            <div className="event-head">
              <strong>
                {event.name} · {event.result?.status || "running"}
              </strong>
              <span className={`timer-chip ${event.finishedAt ? "done" : "running"}`}>
                {formatDuration(elapsedMs)}
              </span>
            </div>
            <p>{event.result?.summary || "Tool call requested."}</p>
          </div>
        );
      })}
    </div>
  );
}

function RunActivity({ entries, timer, now }: { entries: ActivityEntry[]; timer: RunTimer | null; now: number }) {
  if (entries.length === 0) {
    return <div className="muted">No run activity yet.</div>;
  }

  const finished = Boolean(timer?.finishedAt);
  const visibleEntries = finished ? entries.slice(-1) : entries.slice(-6);
  const summary = describeActivitySummary(entries, timer, now);

  if (finished) {
    return (
      <div className="activity-wrap">
        <div className="activity-summary">
          <strong>{summary}</strong>
          <span className="hint">{entries[entries.length - 1]?.message}</span>
        </div>
        <details className="activity-details">
          <summary>Open full run log ({entries.length} entries)</summary>
          <ActivityList entries={entries} />
        </details>
      </div>
    );
  }

  return (
    <div className="activity-wrap">
      <div className="activity-summary">
        <strong>{summary}</strong>
        <span className="hint">{entries[entries.length - 1]?.message}</span>
      </div>
      <ActivityList entries={visibleEntries} />
    </div>
  );
}

function ActivityList({ entries }: { entries: ActivityEntry[] }) {
  return (
    <ol className="activity-list">
      {entries.map((entry) => (
        <li className={`activity-item ${entry.tone}`} key={entry.id}>
          <span className="activity-time">{formatClockTime(entry.time)}</span>
          <span>{entry.message}</span>
        </li>
      ))}
    </ol>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function RunTimerBadge({ timer, now }: { timer: RunTimer | null; now: number }) {
  if (!timer) return <span className="timer-badge idle">idle</span>;
  const elapsedMs = Math.max(0, (timer.finishedAt || now) - timer.startedAt);
  return (
    <span className={`timer-badge ${timer.finishedAt ? "done" : "running"}`}>
      {timer.finishedAt ? "done" : "running"} · {formatDuration(elapsedMs)}
    </span>
  );
}

async function readAgentStream<T extends AgentRunResponse>(
  response: Response,
  handlers: {
    onToolStart: (event: AgentToolStartEvent) => void;
    onToolEvent: (event: AgentToolEvent) => void;
  }
): Promise<T> {
  if (!response.body) throw new Error("Agent stream response did not include a body.");
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.error || "Agent stream request failed.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: T | null = null;

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as AgentStreamEvent;
    if (event.type === "tool_started") {
      handlers.onToolStart(event.event);
      return;
    }
    if (event.type === "tool_event") {
      handlers.onToolEvent(event.event);
      return;
    }
    if (event.type === "result") {
      finalResult = event.result as T;
      return;
    }
    if (event.type === "error") {
      throw new Error(event.error);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) handleLine(line);
  }

  buffer += decoder.decode();
  handleLine(buffer);

  if (!finalResult) throw new Error("Agent stream ended without a final result.");
  return finalResult;
}

function upsertLiveToolEvent(events: LiveToolEvent[], event: LiveToolEvent): LiveToolEvent[] {
  const index = events.findIndex((candidate) => candidate.id === event.id);
  if (index === -1) return [...events, event];
  return events.map((candidate, candidateIndex) => (
    candidateIndex === index ? { ...candidate, ...event } : candidate
  ));
}

function createActivityEntry(
  message: string,
  tone: ActivityEntry["tone"],
  time = Date.now(),
  id = crypto.randomUUID()
): ActivityEntry {
  return { id, message, time, tone };
}

function describeToolStart(event: AgentToolStartEvent): string {
  const args = asRecord(event.args);
  switch (event.name) {
    case "list_files":
      return `Listing files in ${stringArg(args.path, ".")}${numberArg(args.maxFiles) ? `, up to ${numberArg(args.maxFiles)} entries` : ""}.`;
    case "read_file":
      return `Reading ${stringArg(args.path, "a file")}${lineRangeDescription(args)}.`;
    case "search_text":
      return `Searching for "${stringArg(args.query, "")}"${stringArg(args.glob) ? ` in ${stringArg(args.glob)}` : ""}.`;
    case "git_status":
      return "Checking git status.";
    case "git_diff":
      return "Reading the current git diff.";
    case "create_file":
      return `Creating ${stringArg(args.path, "a file")} with ${String(stringArg(args.content, "")).length} characters.`;
    case "apply_patch":
      return `Applying a patch with ${String(stringArg(args.patch, "")).length} characters.`;
    case "run_command":
      return `Running command: ${stringArg(args.command, "")}.`;
    default:
      return `Running ${event.name}.`;
  }
}

function describeToolFinish(event: AgentToolEvent): string {
  const status = event.result.status.replace("_", " ");
  return `${capitalize(status)} ${event.name} in ${formatDuration(event.durationMs)}: ${event.result.summary}`;
}

function activityToneForTool(event: AgentToolEvent): ActivityEntry["tone"] {
  if (event.result.status === "completed") return "done";
  if (event.result.status === "failed") return "error";
  return "info";
}

function describeRunFinish(startedAt: number, finishedAt: number, toolEvents: AgentToolEvent[]): string {
  return `Finished in ${formatDuration(finishedAt - startedAt)} after ${toolEvents.length} tool call${toolEvents.length === 1 ? "" : "s"}.`;
}

function describeGitHubRunFinish(startedAt: number, finishedAt: number, result: GitHubTaskResult): string {
  const base = describeRunFinish(startedAt, finishedAt, result.toolEvents);
  if (result.pullRequestUrl) return `${base} Opened pull request #${result.pullRequestNumber}.`;
  if (result.mode === "write") return `${base} Write-mode run completed without opening a pull request.`;
  return `${base} Read-only repository response completed.`;
}

function describeActivitySummary(entries: ActivityEntry[], timer: RunTimer | null, now: number): string {
  const elapsed = timer ? formatDuration(Math.max(0, (timer.finishedAt || now) - timer.startedAt)) : "0.0s";
  if (timer?.finishedAt) {
    const errors = entries.filter((entry) => entry.tone === "error").length;
    return errors > 0
      ? `Finished with ${errors} issue${errors === 1 ? "" : "s"} in ${elapsed}`
      : `Finished in ${elapsed}`;
  }
  return `Working for ${elapsed}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringArg(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lineRangeDescription(args: Record<string, unknown>): string {
  const startLine = numberArg(args.startLine);
  const endLine = numberArg(args.endLine);
  if (startLine && endLine) return ` lines ${startLine}-${endLine}`;
  if (startLine) return ` from line ${startLine}`;
  if (endLine) return ` through line ${endLine}`;
  return "";
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function formatDuration(ms: number): string {
  const tenths = Math.max(0, Math.floor(ms / 100));
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  const remainder = tenths % 10;
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}.${remainder}s`;
  return `${seconds}.${remainder}s`;
}

function formatClockTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatRelativeDate(value: string): string {
  if (!value) return "unknown";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
