# Coding Agent MVP

This repository implements the first working slice of the plan in `DEVELOPMENT_AGENT_PLAN.md`:

- a browser UI for local coding-agent workflows,
- a local daemon that safely brokers file/search/git/patch/command access,
- a provider-neutral agent core with OpenAI, Anthropic, and mock modes,
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

