"use client";

import { useMemo, useState } from "react";
import {
  DEFAULT_DAEMON_ORIGIN,
  type AgentProvider,
  type AgentRunResponse,
  type AgentToolEvent,
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
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId),
    [workspaceId, workspaces]
  );
  const selectedGithubRepo = useMemo(
    () => githubRepos.find((repo) => repo.fullName === githubRepoFullName),
    [githubRepoFullName, githubRepos]
  );

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
    setBusy("agent");
    setError(null);
    setAgentResult(null);
    try {
      const response = await fetch("/api/agent", {
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
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "Agent request failed.");
      setAgentResult(data);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(null);
    }
  }

  async function runGithubAgent() {
    setBusy("github-agent");
    setError(null);
    setGithubResult(null);
    try {
      if (!selectedGithubRepo) throw new Error("Select an installed GitHub repository first.");
      const response = await fetch("/api/github/tasks", {
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
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || "GitHub agent request failed.");
      setGithubResult(data);
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
        setGithubRepoFullName(repositories[0].fullName);
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

  const eventList = activeTab === "github" ? githubResult?.toolEvents : agentResult?.toolEvents;

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
              />
            ) : (
              <GithubAgentPanel
                githubInstallUrl={githubInstallUrl}
                githubRepos={githubRepos}
                githubRepoFullName={githubRepoFullName}
                setGithubRepoFullName={setGithubRepoFullName}
                githubPrompt={githubPrompt}
                setGithubPrompt={setGithubPrompt}
                loadGithubRepositories={loadGithubRepositories}
                runGithubAgent={runGithubAgent}
                busy={busy}
                githubResult={githubResult}
              />
            )}

            <section className="panel stack">
              <h2>Tool Events</h2>
              <ToolEvents events={eventList || []} />
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
  agentResult
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  runLocalAgent: () => void;
  busy: string | null;
  agentResult: AgentRunResponse | null;
}) {
  return (
    <section className="panel stack">
      <h2>Local Agent</h2>
      <textarea rows={6} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      <button className="primary" disabled={busy === "agent" || !prompt.trim()} onClick={runLocalAgent}>
        Run Local Agent
      </button>
      <pre className="chat-output">{agentResult?.text || "No local agent result yet."}</pre>
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
  runGithubAgent,
  busy,
  githubResult
}: {
  githubInstallUrl: string;
  githubRepos: GitHubRepository[];
  githubRepoFullName: string;
  setGithubRepoFullName: (value: string) => void;
  githubPrompt: string;
  setGithubPrompt: (value: string) => void;
  loadGithubRepositories: () => void;
  runGithubAgent: () => void;
  busy: string | null;
  githubResult: GitHubTaskResult | null;
}) {
  return (
    <section className="panel stack">
      <h2>GitHub Agent</h2>
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
    </section>
  );
}

function ToolEvents({ events }: { events: AgentToolEvent[] }) {
  if (events.length === 0) {
    return <div className="muted">No tool events yet.</div>;
  }

  return (
    <div className="stack">
      {events.map((event) => (
        <div className="event" key={event.id}>
          <strong>
            {event.name} · {event.result.status}
          </strong>
          <p>{event.result.summary}</p>
        </div>
      ))}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
