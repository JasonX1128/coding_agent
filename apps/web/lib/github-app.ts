import { createSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

export type StoredInstallation = {
  id: number;
  accountLogin?: string;
  accountType?: string;
  updatedAt: string;
};

export type GitHubRepository = {
  id: number;
  installationId: number;
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
};

export type GitHubPullRequest = {
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

type InstallationToken = {
  token: string;
  expiresAt: string;
};

const githubApi = "https://api.github.com";

export function getGitHubInstallUrl(): string {
  const explicit = process.env.GITHUB_APP_INSTALL_URL?.trim();
  if (explicit) return explicit;

  const slug = process.env.GITHUB_APP_SLUG?.trim();
  if (!slug) throw new Error("GITHUB_APP_INSTALL_URL or GITHUB_APP_SLUG is required.");
  return `https://github.com/apps/${slug}/installations/new`;
}

export async function saveInstallation(installationId: number): Promise<StoredInstallation> {
  const jwt = await createAppJwt();
  const installation = await githubRequest<Record<string, unknown>>(`/app/installations/${installationId}`, {
    token: jwt
  });

  const account = installation.account && typeof installation.account === "object"
    ? (installation.account as Record<string, unknown>)
    : {};
  const stored: StoredInstallation = {
    id: installationId,
    accountLogin: typeof account.login === "string" ? account.login : undefined,
    accountType: typeof account.type === "string" ? account.type : undefined,
    updatedAt: new Date().toISOString()
  };

  const current = await loadInstallations();
  const next = [stored, ...current.filter((item) => item.id !== installationId)];
  await writeJson(installationsPath(), { installations: next });
  return stored;
}

export async function loadInstallations(): Promise<StoredInstallation[]> {
  const filePath = installationsPath();
  if (!existsSync(filePath)) return [];
  const data = JSON.parse(await readFile(filePath, "utf8")) as { installations?: StoredInstallation[] };
  return Array.isArray(data.installations) ? data.installations : [];
}

export async function syncInstallationsFromGitHub(): Promise<StoredInstallation[]> {
  const jwt = await createAppJwt();
  const discovered: StoredInstallation[] = [];
  let page = 1;

  while (true) {
    const installations = await githubRequest<Array<Record<string, unknown>>>(
      `/app/installations?per_page=100&page=${page}`,
      { token: jwt }
    );
    discovered.push(...installations.map(normalizeInstallation));
    if (installations.length < 100) break;
    page += 1;
  }

  const current = await loadInstallations();
  const merged = new Map<number, StoredInstallation>();
  for (const installation of current) merged.set(installation.id, installation);
  for (const installation of discovered) merged.set(installation.id, installation);
  const next = [...merged.values()].sort((a, b) => a.id - b.id);
  await writeJson(installationsPath(), { installations: next });
  return next;
}

export async function listInstalledRepositories(): Promise<GitHubRepository[]> {
  const installations = await syncInstallationsFromGitHub();
  const results = await Promise.all(installations.map((installation) => listInstallationRepositories(installation.id)));
  return results.flat().sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function listInstallationRepositories(installationId: number): Promise<GitHubRepository[]> {
  const installationToken = await createInstallationToken(installationId);
  const repos: GitHubRepository[] = [];
  let page = 1;

  while (true) {
    const data = await githubRequest<{ repositories?: Array<Record<string, unknown>> }>(
      `/installation/repositories?per_page=100&page=${page}`,
      { token: installationToken.token }
    );
    const pageRepos = data.repositories || [];
    repos.push(...pageRepos.map((repo) => normalizeRepository(repo, installationId)));
    if (pageRepos.length < 100) break;
    page += 1;
  }

  return repos;
}

export async function findInstalledRepository(fullName: string, installationId?: number): Promise<GitHubRepository> {
  const repos = installationId
    ? await listInstallationRepositories(installationId)
    : await listInstalledRepositories();
  const repo = repos.find((candidate) => candidate.fullName === fullName);
  if (!repo) throw new Error(`Repository is not available to the GitHub App installation: ${fullName}`);
  return repo;
}

export async function createInstallationToken(installationId: number): Promise<InstallationToken> {
  const jwt = await createAppJwt();
  const data = await githubRequest<Record<string, unknown>>(
    `/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      token: jwt
    }
  );

  if (typeof data.token !== "string") throw new Error("GitHub did not return an installation token.");
  return {
    token: data.token,
    expiresAt: typeof data.expires_at === "string" ? data.expires_at : ""
  };
}

export async function openPullRequest({
  installationId,
  repoFullName,
  title,
  body,
  head,
  base
}: {
  installationId: number;
  repoFullName: string;
  title: string;
  body: string;
  head: string;
  base: string;
}): Promise<{ htmlUrl: string; number: number }> {
  const installationToken = await createInstallationToken(installationId);
  const data = await githubRequest<Record<string, unknown>>(`/repos/${repoFullName}/pulls`, {
    method: "POST",
    token: installationToken.token,
    body: {
      title,
      body,
      head,
      base,
      maintainer_can_modify: true
    }
  });

  if (typeof data.html_url !== "string" || typeof data.number !== "number") {
    throw new Error("GitHub did not return a pull request URL.");
  }

  return {
    htmlUrl: data.html_url,
    number: data.number
  };
}

export async function listOpenAgentPullRequests({
  installationId,
  repoFullName
}: {
  installationId: number;
  repoFullName: string;
}): Promise<GitHubPullRequest[]> {
  const installationToken = await createInstallationToken(installationId);
  const pullRequests: GitHubPullRequest[] = [];
  let page = 1;

  while (true) {
    const data = await githubRequest<Array<Record<string, unknown>>>(
      `/repos/${repoFullName}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`,
      { token: installationToken.token }
    );
    pullRequests.push(...data.filter(isAgentPullRequest).map(normalizePullRequest));
    if (data.length < 100) break;
    page += 1;
  }

  return pullRequests;
}

export async function closePullRequest({
  installationId,
  repoFullName,
  number
}: {
  installationId: number;
  repoFullName: string;
  number: number;
}): Promise<GitHubPullRequest> {
  const installationToken = await createInstallationToken(installationId);
  await assertAgentPullRequest(installationToken.token, repoFullName, number);
  const data = await githubRequest<Record<string, unknown>>(`/repos/${repoFullName}/pulls/${number}`, {
    method: "PATCH",
    token: installationToken.token,
    body: { state: "closed" }
  });
  return normalizePullRequest(data);
}

export async function approvePullRequest({
  installationId,
  repoFullName,
  number
}: {
  installationId: number;
  repoFullName: string;
  number: number;
}): Promise<{ id: number; state: string; submittedAt?: string; htmlUrl?: string }> {
  const installationToken = await createInstallationToken(installationId);
  await assertAgentPullRequest(installationToken.token, repoFullName, number);
  const data = await githubRequest<Record<string, unknown>>(`/repos/${repoFullName}/pulls/${number}/reviews`, {
    method: "POST",
    token: installationToken.token,
    body: {
      event: "APPROVE",
      body: "Approved from the Coding Agent web UI after explicit user confirmation."
    }
  });

  return {
    id: requiredNumber(data.id, "review id"),
    state: typeof data.state === "string" ? data.state : "APPROVED",
    submittedAt: typeof data.submitted_at === "string" ? data.submitted_at : undefined,
    htmlUrl: typeof data.html_url === "string" ? data.html_url : undefined
  };
}

export async function githubRequest<T>(
  route: string,
  options: {
    method?: string;
    token: string;
    body?: unknown;
  }
): Promise<T> {
  const response = await fetch(`${githubApi}${route}`, {
    method: options.method || "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${options.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "coding-agent-local-dev"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof data.message === "string" ? data.message : `${response.status} ${response.statusText}`;
    throw new Error(`GitHub API ${route} failed: ${message}`);
  }
  return data as T;
}

async function createAppJwt(): Promise<string> {
  const appId = process.env.GITHUB_APP_ID?.trim();
  if (!appId) throw new Error("GITHUB_APP_ID is required.");

  const privateKey = await readPrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId
  });
  const input = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(input).end().sign(privateKey);
  return `${input}.${base64Url(signature)}`;
}

async function readPrivateKey(): Promise<string> {
  const configuredPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH?.trim();
  if (!configuredPath) throw new Error("GITHUB_APP_PRIVATE_KEY_PATH is required.");
  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(repoRoot(), configuredPath);
  return readFile(resolvedPath, "utf8");
}

function normalizeRepository(repo: Record<string, unknown>, installationId: number): GitHubRepository {
  const fullName = requiredString(repo.full_name, "repository full_name");
  const [owner, name] = fullName.split("/");
  return {
    id: requiredNumber(repo.id, "repository id"),
    installationId,
    fullName,
    owner: owner || "",
    name: name || "",
    private: Boolean(repo.private),
    defaultBranch: typeof repo.default_branch === "string" ? repo.default_branch : "main",
    htmlUrl: typeof repo.html_url === "string" ? repo.html_url : `https://github.com/${fullName}`
  };
}

function normalizeInstallation(installation: Record<string, unknown>): StoredInstallation {
  const account = installation.account && typeof installation.account === "object"
    ? (installation.account as Record<string, unknown>)
    : {};
  return {
    id: requiredNumber(installation.id, "installation id"),
    accountLogin: typeof account.login === "string" ? account.login : undefined,
    accountType: typeof account.type === "string" ? account.type : undefined,
    updatedAt: new Date().toISOString()
  };
}

function normalizePullRequest(pullRequest: Record<string, unknown>): GitHubPullRequest {
  const head = pullRequest.head && typeof pullRequest.head === "object"
    ? (pullRequest.head as Record<string, unknown>)
    : {};
  const base = pullRequest.base && typeof pullRequest.base === "object"
    ? (pullRequest.base as Record<string, unknown>)
    : {};
  const user = pullRequest.user && typeof pullRequest.user === "object"
    ? (pullRequest.user as Record<string, unknown>)
    : {};
  return {
    id: requiredNumber(pullRequest.id, "pull request id"),
    number: requiredNumber(pullRequest.number, "pull request number"),
    title: requiredString(pullRequest.title, "pull request title"),
    state: typeof pullRequest.state === "string" ? pullRequest.state : "unknown",
    draft: Boolean(pullRequest.draft),
    htmlUrl: requiredString(pullRequest.html_url, "pull request html_url"),
    authorLogin: typeof user.login === "string" ? user.login : "",
    headRef: typeof head.ref === "string" ? head.ref : "",
    headSha: typeof head.sha === "string" ? head.sha : "",
    baseRef: typeof base.ref === "string" ? base.ref : "",
    createdAt: typeof pullRequest.created_at === "string" ? pullRequest.created_at : "",
    updatedAt: typeof pullRequest.updated_at === "string" ? pullRequest.updated_at : ""
  };
}

function isAgentPullRequest(pullRequest: Record<string, unknown>): boolean {
  const title = typeof pullRequest.title === "string" ? pullRequest.title : "";
  const body = typeof pullRequest.body === "string" ? pullRequest.body : "";
  const head = pullRequest.head && typeof pullRequest.head === "object"
    ? (pullRequest.head as Record<string, unknown>)
    : {};
  const headRef = typeof head.ref === "string" ? head.ref : "";
  return headRef.startsWith("agent/") || title.startsWith("Agent:") || body.includes("created from an `agent/*` branch");
}

async function assertAgentPullRequest(token: string, repoFullName: string, number: number): Promise<void> {
  const pullRequest = await githubRequest<Record<string, unknown>>(`/repos/${repoFullName}/pulls/${number}`, { token });
  if (!isAgentPullRequest(pullRequest)) {
    throw new Error(`Pull request #${number} does not look like an agent-created pull request.`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`GitHub response missing ${label}.`);
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number") throw new Error(`GitHub response missing ${label}.`);
  return value;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function installationsPath(): string {
  return path.join(dataDir(), "github-installations.json");
}

function dataDir(): string {
  return path.join(repoRoot(), ".data");
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

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value), "utf8"));
}

function base64Url(value: Buffer): string {
  return value
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
