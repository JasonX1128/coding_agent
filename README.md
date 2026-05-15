# Coding Agent MVP

This repository implements the first working slice of the plan in `DEVELOPMENT_AGENT_PLAN.md`:

- a browser UI for local coding-agent workflows,
- a local daemon that safely brokers file/search/git/patch/command access,
- a provider-neutral agent core with OpenAI, Anthropic, Google Gemini, Groq, and mock modes,
- a local GitHub repo-analysis route that can clone a GitHub repository into a disposable local sandbox.

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

Supported provider environment variables:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
GOOGLE_MODEL
GOOGLE_BACKUP_MODEL
GOOGLE_LAST_RESORT_MODEL
GROQ_API_KEY
```

The Google adapter defaults to `gemini-3.1-flash-lite` and falls back to
`gemma-4-31b-it` if the primary Google model request fails before any local tool
side effects occur. It also keeps `gemini-2.5-flash-lite` as a final safety net
because provider-side availability can differ by key and model version. Override
those with `GOOGLE_MODEL`, `GOOGLE_BACKUP_MODEL`, and `GOOGLE_LAST_RESORT_MODEL`.

## Local Workspace Flow

1. Start `npm run dev`.
2. In the web UI, connect to the daemon.
3. Add a workspace root, for example this repository path.
4. Use file search/read/git/diff/patch/command tools directly, or ask the chat panel to inspect the workspace.

## GitHub Repo Flow

The GitHub panel accepts a GitHub repository URL such as:

```text
https://github.com/vercel/next.js
```

For the MVP, the web route clones public repositories locally under `.agent-sandboxes/` and runs the same agent tool loop against the clone. Private repository support can use `GITHUB_TOKEN` during local development. Production should use the GitHub App flow described in the plan.
