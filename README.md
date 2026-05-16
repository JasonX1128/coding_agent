# Coding Agent MVP

This repository implements the first working slice of the plan in `DEVELOPMENT_AGENT_PLAN.md`:

- a browser UI for local coding-agent workflows,
- a local daemon that safely brokers file/search/git/patch/command access,
- a provider-neutral agent core with OpenAI, Anthropic, Google Gemini, Groq, and mock modes,
- a GitHub App repository-task route that can inspect repositories or open PRs from prompt-driven work.

## Quick Start

```bash
npm install
cp .env.example .env.local
npm run dev
```

Then open:

```text
http://localhost:3000
```

The local daemon runs on:

```text
http://127.0.0.1:4317
```

If no provider API key is configured, select `mock` in the UI. Mock mode still exercises the tool pipeline by calling the local daemon or GitHub sandbox tools.

Agent runs in the web UI stream tool events live. The Tool Events panel shows a
tool as `running` as soon as the model requests it, updates that row when the
tool completes, then fills in the chat output when the final model response
arrives. Each running tool has a live per-call timer that freezes at completion,
and the active Local/GitHub agent panel shows an overall run timer. The Run
Activity panel narrates what the agent is doing from live stream events, then
compresses to a summary with an expandable full log when the run finishes. The
non-streaming JSON routes still exist for simple API clients.

Supported provider environment variables:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
GOOGLE_MODEL
GOOGLE_MODEL_CANDIDATES
GOOGLE_MODEL_RETRIES
GOOGLE_BACKUP_MODEL
GOOGLE_LAST_RESORT_MODEL
GROQ_API_KEY
GITHUB_TASK_MODE_MODEL
OPENAI_TASK_MODE_MODEL
ANTHROPIC_TASK_MODE_MODEL
GOOGLE_TASK_MODE_MODEL
GROQ_TASK_MODE_MODEL
```

The Google adapter queries model candidates in strength order by default:
`gemini-3-flash-preview`, `gemini-3.1-flash-lite`, `gemma-4-31b-it`,
`gemma-4-26b-a4b-it`, `gemini-2.5-flash`, then `gemini-2.5-flash-lite`. It falls through on model
availability, quota, rate-limit, and high-demand errors, including failures that
happen after earlier tool calls in the same run. Override the full ordered pool
with `GOOGLE_MODEL_CANDIDATES`, and set `GOOGLE_MODEL_RETRIES` to control the
number of retries before moving to the next candidate. You can also append
legacy fallbacks with `GOOGLE_MODEL`, `GOOGLE_BACKUP_MODEL`, and
`GOOGLE_LAST_RESORT_MODEL`. If a provider failure happens after file edits, the
GitHub workflow still preserves non-empty changes and opens a pull request
instead of discarding the run.

When GitHub repository tasks run in `auto` mode, the app asks the selected model
to classify the prompt as `read` or `write` with tools disabled. Set
`GITHUB_TASK_MODE_MODEL` or a provider-specific override such as
`GOOGLE_TASK_MODE_MODEL` or `GROQ_TASK_MODE_MODEL` to use a smaller classifier
model than the main coding model.

## Local Workspace Flow

1. Start `npm run dev`.
2. In the web UI, connect to the daemon.
3. Add a workspace root, for example this repository path.
4. Use file search/read/git/diff/patch/command tools directly, or ask the chat panel to inspect and edit the workspace. The agent also has an exact replacement edit tool for localized changes.

## GitHub Repo Flow

The GitHub tab supports two flows:

1. GitHub App repository flow for installed repositories.
2. Legacy public-URL analysis through `/api/github-agent`.

### GitHub App Repository Flow

Create and install a GitHub App, then set:

```text
GITHUB_APP_ID
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY_PATH
GITHUB_APP_SLUG
GITHUB_APP_INSTALL_URL
```

The GitHub App needs **Pull requests: Read and write** for listing PRs,
creating PRs, closing PRs, and submitting approval reviews. Keep branch
protection on the default branch so the app still cannot bypass your merge rules.

The private key should live in:

```text
.secrets/github-app-private-key.pem
```

Run the app:

```bash
set -a
source .env
set +a
npm run dev
```

Then:

1. Open `http://localhost:3000`.
2. Select the GitHub tab.
3. Click **Install App** if the app is not installed yet.
4. Click **Load Repositories**.
5. Select an installed repository.
6. Enter a prompt.
7. Click **Run Agent**.

The prompt determines the outcome. Analysis, explanation, planning, review, and
inspection prompts run read-only and return a text response. Prompts that ask the
agent to add, edit, fix, implement, or open a PR run in write mode.

In write mode, the app clones the repository into `.agent-sandboxes/`, creates an
`agent/*` branch, runs the agent with file/search/exact replacement/patch/git/command tools,
commits non-empty changes, pushes the branch with a short-lived installation
token, and opens a pull request against the repository default branch. If no
non-empty file changes are produced, it returns the agent response without
opening a pull request.

The GitHub tab can also refresh open agent pull requests for the selected
repository. It only shows PRs that look agent-created, such as `agent/*` branches
or `Agent:` titles. From the web UI you can approve or close one of those PRs
after an explicit browser confirmation. The approval is submitted by the GitHub
App identity, so repository branch-protection rules determine whether that
approval counts.

Prompt-running agent tasks do not approve or merge pull requests automatically.
Protect `main` or your default branch with GitHub rulesets if you want GitHub
itself to enforce PR-only changes and review requirements.

### Public URL Analysis

The legacy route at `/api/github-agent` accepts a public GitHub URL such as:

```text
https://github.com/vercel/next.js
```

It clones public repositories locally under `.agent-sandboxes/` and runs the same
agent read/search loop against the clone. Private repository support for this
legacy route can use `GITHUB_TOKEN`, but the GitHub App flow is preferred.
