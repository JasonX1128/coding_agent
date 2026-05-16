# Suggested Next Steps to Improve the Coding Agent

This document outlines potential areas for improvement to enhance the functionality, reliability, and usability of the coding agent project.

## 1. Core Agent Enhancements
- **Multi-turn Context Management:** Improve the agent's ability to maintain long-term context across multiple requests within the same workspace or GitHub repository.
- **Agent Reasoning/Planning:** Implement a more robust "Chain-of-Thought" or planning step before executing tool calls to reduce unnecessary actions or hallucinations.
- **Model Agnostic Fine-tuning:** Explore providing a mechanism to fine-tune smaller models for specific coding tasks (e.g., code explanation or formatting) to reduce latency and costs compared to using large frontier models for every step.

## 2. GitHub Integration
- **Advanced Pull Request Management:** Enhance the UI to support commenting directly on PR lines, managing complex reviews, and rebasing/handling merge conflicts automatically within the agent's tool loop.
- **GitHub Actions Integration:** Allow the agent to inspect CI/CD logs directly to automatically diagnose and fix build/test failures after applying a patch.
- **Improved Security/Permissions:** Granular permission control for the GitHub App to ensure the agent only modifies authorized files or branches.

## 3. Local Workspace & Daemon
- **Streaming UI:** Upgrade the web UI to stream agent responses and tool outputs in real-time for better feedback loops.
- **Persistent Local Caching:** Add a caching layer for repository indexes (e.g., using a vector database or local search index) to speed up code search across large repositories.
- **More Robust Sandboxing:** Strengthen the local daemon's isolation, perhaps by exploring containerized execution (e.g., Docker or WebAssembly/Wasm-based sandboxes) for running code or tests.

## 4. Usability & UX
- **User Config:** Add a settings page to the web UI for persistent storage of API keys, model preferences, and custom agent instructions.
- **Agent Personas:** Allow users to define different personas (e.g., "Reviewer", "Implementer", "Debugger") to guide the agent's tone and approach.
- **Improved Observability:** Add a dashboard to track agent performance, cost, token usage, and history of actions performed across different sessions.

## 5. Testing & Reliability
- **End-to-End Testing:** Implement a suite of end-to-end tests that simulate full agent workflows (clone -> prompt -> edit -> PR) in a test environment.
- **Regression Testing for Agent Tools:** Build a testing framework that ensures changes to the `agent-core` don't break existing tool implementations (file reading, patching, etc.).
