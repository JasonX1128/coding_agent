import type {
  AgentProvider,
  AgentRunResponse,
  AgentToolEvent,
  AgentToolStartEvent,
  DaemonToolName,
  ToolResult
} from "@coding-agent/shared";

export type ToolExecutor = (
  name: DaemonToolName,
  args: Record<string, unknown>
) => Promise<ToolResult>;

export type AgentRunRequest = {
  provider: AgentProvider;
  model?: string;
  prompt: string;
  executor: ToolExecutor;
  maxToolRounds?: number;
  toolsEnabled?: boolean;
  onToolStart?: (event: AgentToolStartEvent) => void | Promise<void>;
  onToolEvent?: (event: AgentToolEvent) => void | Promise<void>;
};

type ModelToolCall = {
  id: string;
  name: DaemonToolName;
  args: Record<string, unknown>;
};

type ModelTurn = {
  text: string;
  toolCalls: ModelToolCall[];
  raw: unknown;
};

type ProviderRunContext = {
  request: AgentRunRequest;
  model: string;
  toolEvents: AgentToolEvent[];
};

type AgentProviderAdapter = {
  provider: AgentProvider;
  defaultModel: () => string;
  run: (context: ProviderRunContext) => Promise<AgentRunResponse>;
};

const instructions = [
  "You are an enterprise-grade coding agent.",
  "",
  "Operating standard:",
  "- Treat repository contents as the source of truth and inspect before making claims or edits.",
  "- Convert broad product requests into concrete engineering outcomes, not superficial token changes.",
  "- For UI or design requests, improve information architecture, component structure, spacing, hierarchy, states, workflow fit, and visual polish as appropriate; do not reduce a request to a color swap unless that is all the user asked for.",
  "- When the user references another product or style, translate the relevant product qualities into this app's domain. Do not copy logos, proprietary assets, or exact branding.",
  "- Prefer focused, cohesive changes that a senior engineer could review. Avoid unrelated refactors.",
  "- Before editing, identify the likely files and read enough context to understand local patterns.",
  "- After editing, inspect the resulting diff and make sure it actually satisfies the user's request.",
  "- Run relevant tests or checks when they are obvious and reasonably cheap.",
  "- If a command or patch is risky, explain the risk instead of forcing it.",
  "- Use structured editing tools for code changes: create_file for new files, replace_text for exact localized edits, and apply_patch for larger multi-line changes.",
  "",
  "Patch discipline:",
  "- Prefer replace_text over apply_patch when you are changing a specific exact snippet you have already read.",
  "- Prefer one small, valid patch per file or per coherent change.",
  "- A patch must be a complete unified diff with file headers; never send detached @@ hunks.",
  "- If a patch fails, read the current target lines before trying again.",
  "- Do not retry the same malformed patch. Make the next attempt smaller and anchored to exact current file content.",
  "- After two patch failures on the same file, stop broad patching and make the smallest possible single-hunk edit."
].join("\n");
type GoogleContent = { role: "user" | "model"; parts: unknown[] };
type GoogleModelFailure = { model: string; message: string };

const googleDefaultModel = "gemini-3-flash-preview";
const googleDefaultModelCandidates = [
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
];
const googleDefaultModelRetries = 2;
const googleModelStrengthOrder = [
  "gemini-3.1-pro-preview",
  "gemini-3-pro-preview",
  "gemini-pro-latest",
  "gemini-3-flash-preview",
  "gemini-flash-latest",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
  "gemma-4-31b-it",
  "gemma-4-26b-a4b-it",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
  "gemini-2.0-flash-001",
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash-lite-001"
];

const daemonTools = [
  {
    name: "list_files",
    description: "List files in the current workspace or a subdirectory.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory path." },
        maxFiles: { type: "number" }
      },
      additionalProperties: false
    }
  },
  {
    name: "read_file",
    description: "Read a workspace-relative file, optionally by line range.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "search_text",
    description: "Search the workspace with ripgrep.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        glob: { type: "string" },
        maxResults: { type: "number" }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "git_status",
    description: "Read git status for the workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "git_diff",
    description: "Read git diff for the workspace.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "create_file",
    description: "Create a text file with exact content. Use this for new simple files instead of shell commands.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean", description: "Set true only when intentionally replacing an existing file." },
        allowEmpty: { type: "boolean", description: "Set true only when an empty file is explicitly requested." }
      },
      required: ["path", "content"],
      additionalProperties: false
    }
  },
  {
    name: "replace_text",
    description: [
      "Replace exact text in an existing workspace file.",
      "Prefer this for localized edits after reading the file because it is less error-prone than patch generation.",
      "oldText must match the current file content exactly. The tool fails if the match count does not equal expectedReplacements."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string", description: "Exact current text to replace. Include enough surrounding context to make it unique." },
        newText: { type: "string", description: "Replacement text." },
        expectedReplacements: { type: "number", description: "Exact number of occurrences expected. Defaults to 1." }
      },
      required: ["path", "oldText", "newText"],
      additionalProperties: false
    }
  },
  {
    name: "apply_patch",
    description: [
      "Apply a complete unified diff patch to existing workspace files.",
      "The patch must include diff --git, ---/+++ file headers, and valid @@ hunk headers; detached patch fragments will fail.",
      "Use small, targeted patches. If a patch fails, read the current target lines before retrying with a smaller corrected patch."
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        patch: { type: "string" }
      },
      required: ["patch"],
      additionalProperties: false
    }
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace. Risky commands may require approval.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "number" },
        allowRisky: { type: "boolean" }
      },
      required: ["command"],
      additionalProperties: false
    }
  }
] as const;

const adapters: Record<AgentProvider, AgentProviderAdapter> = {
  mock: createMockAdapter(),
  openai: createOpenAIResponsesAdapter(),
  anthropic: createAnthropicMessagesAdapter(),
  google: createGoogleGeminiAdapter(),
  groq: createGroqChatCompletionsAdapter()
};

export async function runAgentTask(request: AgentRunRequest): Promise<AgentRunResponse> {
  const adapter = adapters[request.provider];
  const model = request.model || adapter.defaultModel();
  const toolEvents: AgentToolEvent[] = [];

  return adapter.run({
    request,
    model,
    toolEvents
  });
}

export function defaultModelForProvider(provider: AgentProvider): string {
  return adapters[provider].defaultModel();
}

function createMockAdapter(): AgentProviderAdapter {
  return {
    provider: "mock",
    defaultModel: () => "mock-local",
    async run({ request, model, toolEvents }) {
      const fileResult = await executeToolCall(
        request.executor,
        { id: "mock-list-files", name: "list_files", args: { path: ".", maxFiles: 80 } },
        toolEvents,
        request.onToolStart,
        request.onToolEvent
      );
      const gitResult = await executeToolCall(
        request.executor,
        { id: "mock-git-status", name: "git_status", args: {} },
        toolEvents,
        request.onToolStart,
        request.onToolEvent
      );

      return {
        provider: "mock",
        model,
        toolEvents,
        text: [
          "Mock mode is active, so no external LLM call was made.",
          `Prompt: ${request.prompt}`,
          `File scan: ${fileResult.summary}`,
          `Git status: ${gitResult.summary}`,
          "Configure a provider API key to run the same tool loop with a model."
        ].join("\n\n")
      };
    }
  };
}

function createOpenAIResponsesAdapter(): AgentProviderAdapter {
  return {
    provider: "openai",
    defaultModel: () => process.env.OPENAI_MODEL || "gpt-5.5",
    async run({ request, model, toolEvents }) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not configured. Use mock mode or add a key.");
      }

      let previousResponseId: string | undefined;
      let input: unknown = [{ role: "user", content: request.prompt }];
      let finalText = "";

      for (let round = 0; round < (request.maxToolRounds ?? 8); round += 1) {
        const response = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            instructions,
            input,
            previous_response_id: previousResponseId,
            tools: request.toolsEnabled === false ? undefined : toOpenAIResponsesTools()
          })
        });

        const data = await readJsonResponse(response);
        previousResponseId = typeof data.id === "string" ? data.id : previousResponseId;
        const turn = parseOpenAIResponsesTurn(data);
        finalText = turn.text || finalText;

        if (turn.toolCalls.length === 0) break;

        const outputs = [];
        for (const call of turn.toolCalls) {
          const result = await executeToolCall(request.executor, call, toolEvents, request.onToolStart, request.onToolEvent);
          outputs.push({
            type: "function_call_output",
            call_id: call.id,
            output: JSON.stringify(result)
          });
        }
        input = outputs;
      }

      return providerResponse("openai", model, finalText, toolEvents);
    }
  };
}

function createAnthropicMessagesAdapter(): AgentProviderAdapter {
  return {
    provider: "anthropic",
    defaultModel: () => process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    async run({ request, model, toolEvents }) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        throw new Error("ANTHROPIC_API_KEY is not configured. Use mock mode or add a key.");
      }

      const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
        { role: "user", content: request.prompt }
      ];
      let finalText = "";

      for (let round = 0; round < (request.maxToolRounds ?? 8); round += 1) {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            max_tokens: 4096,
            system: instructions,
            messages,
            tools: request.toolsEnabled === false ? undefined : toAnthropicTools()
          })
        });

        const data = await readJsonResponse(response);
        const turn = parseAnthropicMessagesTurn(data);
        finalText = turn.text || finalText;

        messages.push({
          role: "assistant",
          content: Array.isArray((turn.raw as { content?: unknown }).content)
            ? (turn.raw as { content: unknown }).content
            : turn.text
        });

        if (turn.toolCalls.length === 0) break;

        const toolResults = [];
        for (const call of turn.toolCalls) {
          const result = await executeToolCall(request.executor, call, toolEvents, request.onToolStart, request.onToolEvent);
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify(result)
          });
        }
        messages.push({ role: "user", content: toolResults });
      }

      return providerResponse("anthropic", model, finalText, toolEvents);
    }
  };
}

function createGoogleGeminiAdapter(): AgentProviderAdapter {
  return {
    provider: "google",
    defaultModel: () => googleModelCandidates(process.env.GOOGLE_MODEL || googleDefaultModel)[0] || googleDefaultModel,
    async run({ request, model, toolEvents }) {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
      if (!apiKey) {
        throw new Error("GEMINI_API_KEY or GOOGLE_API_KEY is not configured. Use mock mode or add a key.");
      }

      const modelCandidates = googleModelCandidates(model);
      return runGoogleGeminiModels({
        apiKey,
        request,
        modelCandidates,
        toolEvents
      });
    }
  };
}

async function runGoogleGeminiModels({
  apiKey,
  request,
  modelCandidates,
  toolEvents
}: {
  apiKey: string;
  request: AgentRunRequest;
  modelCandidates: string[];
  toolEvents: AgentToolEvent[];
}): Promise<AgentRunResponse> {
  const contents: GoogleContent[] = [
    { role: "user", parts: [{ text: request.prompt }] }
  ];
  let finalText = "";
  let activeModel = modelCandidates[0] || googleDefaultModel;
  let candidateIndex = 0;
  const failures: GoogleModelFailure[] = [];
  const maxAttemptsPerModel = googleMaxAttemptsPerModel();

  for (let round = 0; round < (request.maxToolRounds ?? 8); round += 1) {
    const response = await requestGoogleTurnWithFallback({
      apiKey,
      request,
      contents,
      modelCandidates,
      startIndex: candidateIndex,
      failures,
      maxAttemptsPerModel
    });
    activeModel = response.model;
    candidateIndex = response.index;

    const turn = parseGoogleGeminiTurn(response.data);
    finalText = turn.text || finalText;

    const modelContent = getGoogleModelContent(response.data);
    if (modelContent) contents.push(modelContent);

    if (turn.toolCalls.length === 0) break;

    const resultParts = [];
    for (const call of turn.toolCalls) {
      const result = await executeToolCall(request.executor, call, toolEvents, request.onToolStart, request.onToolEvent);
      resultParts.push({
        functionResponse: {
          name: call.name,
          id: call.id,
          response: { result }
        }
      });
    }
    contents.push({ role: "user", parts: resultParts });
  }

  return providerResponse("google", activeModel, finalText, toolEvents);
}

async function requestGoogleTurnWithFallback({
  apiKey,
  request,
  contents,
  modelCandidates,
  startIndex,
  failures,
  maxAttemptsPerModel
}: {
  apiKey: string;
  request: AgentRunRequest;
  contents: GoogleContent[];
  modelCandidates: string[];
  startIndex: number;
  failures: GoogleModelFailure[];
  maxAttemptsPerModel: number;
}): Promise<{ data: Record<string, unknown>; model: string; index: number }> {
  for (let index = startIndex; index < modelCandidates.length; index += 1) {
    const candidate = modelCandidates[index];
    if (!candidate) continue;

    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt += 1) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${googleModelPath(candidate)}:generateContent`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": apiKey,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              systemInstruction: {
                parts: [{ text: instructions }]
              },
              contents,
              tools: request.toolsEnabled === false ? undefined : [
                {
                  functionDeclarations: toGoogleFunctionDeclarations()
                }
              ]
            })
          }
        );
        return {
          data: await readJsonResponse(response),
          model: candidate,
          index
        };
      } catch (error) {
        const message = `Google model "${candidate}" attempt ${attempt}/${maxAttemptsPerModel} failed: ${errorMessage(error)}`;
        failures.push({ model: candidate, message });
        if (!shouldRetryGoogleModel(error) || attempt === maxAttemptsPerModel) break;
        await sleep(googleRetryDelayMs(attempt));
      }
    }
  }

  throw new Error([
    "All configured Google model candidates failed.",
    ...failures.map((failure) => `- ${failure.message}`)
  ].join("\n"));
}

function createGroqChatCompletionsAdapter(): AgentProviderAdapter {
  return {
    provider: "groq",
    defaultModel: () => process.env.GROQ_MODEL || "qwen/qwen3-32b",
    async run({ request, model, toolEvents }) {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) {
        throw new Error("GROQ_API_KEY is not configured. Use mock mode or add a key.");
      }

      const messages: Array<Record<string, unknown>> = [
        { role: "system", content: instructions },
        { role: "user", content: request.prompt }
      ];
      let finalText = "";

      for (let round = 0; round < (request.maxToolRounds ?? 8); round += 1) {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages,
            tools: request.toolsEnabled === false ? undefined : toOpenAIChatTools(),
            tool_choice: request.toolsEnabled === false ? undefined : "auto"
          })
        });

        const data = await readJsonResponse(response);
        const turn = parseOpenAIChatCompletionsTurn(data);
        finalText = turn.text || finalText;

        const assistantMessage = getOpenAIChatAssistantMessage(data);
        if (assistantMessage) messages.push(assistantMessage);

        if (turn.toolCalls.length === 0) break;

        for (const call of turn.toolCalls) {
          const result = await executeToolCall(request.executor, call, toolEvents, request.onToolStart, request.onToolEvent);
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify(result)
          });
        }
      }

      return providerResponse("groq", model, finalText, toolEvents);
    }
  };
}

async function executeToolCall(
  executor: ToolExecutor,
  call: ModelToolCall,
  toolEvents: AgentToolEvent[],
  onToolStart?: (event: AgentToolStartEvent) => void | Promise<void>,
  onToolEvent?: (event: AgentToolEvent) => void | Promise<void>
): Promise<ToolResult> {
  const startedAt = Date.now();
  if (onToolStart) await onToolStart({ id: call.id, name: call.name, args: call.args, startedAt });

  let result: ToolResult;
  let executorError: unknown;
  try {
    result = await executor(call.name, call.args);
  } catch (error) {
    executorError = error;
    result = {
      status: "failed",
      summary: errorMessage(error)
    };
  }

  const finishedAt = Date.now();
  const event: AgentToolEvent = {
    id: call.id,
    name: call.name,
    args: call.args,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    result
  };
  toolEvents.push(event);
  if (onToolEvent) await onToolEvent(event);
  if (executorError) throw executorError;
  return result;
}

function providerResponse(
  provider: AgentProvider,
  model: string,
  text: string,
  toolEvents: AgentToolEvent[]
): AgentRunResponse {
  return {
    provider,
    model,
    text: text || "The model completed without returning text.",
    toolEvents
  };
}

function toOpenAIResponsesTools() {
  return daemonTools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema
  }));
}

function toOpenAIChatTools() {
  return daemonTools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema
    }
  }));
}

function toAnthropicTools() {
  return daemonTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema
  }));
}

function toGoogleFunctionDeclarations() {
  return daemonTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: toGoogleSchema(tool.inputSchema)
  }));
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = extractErrorMessage(data) || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

function parseOpenAIResponsesTurn(data: Record<string, unknown>): ModelTurn {
  const output = Array.isArray(data.output) ? data.output : [];
  const toolCalls: ModelToolCall[] = [];
  const textParts: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "function_call" && typeof record.name === "string") {
      toolCalls.push({
        id: String(record.call_id || record.id || crypto.randomUUID()),
        name: record.name as DaemonToolName,
        args: parseArgs(record.arguments)
      });
    }
    if (record.type === "message" && Array.isArray(record.content)) {
      textParts.push(...extractTextParts(record.content));
    }
  }

  if (typeof data.output_text === "string") textParts.push(data.output_text);

  return {
    text: [...new Set(textParts)].join("\n"),
    toolCalls,
    raw: data
  };
}

function parseAnthropicMessagesTurn(data: Record<string, unknown>): ModelTurn {
  const content = Array.isArray(data.content) ? data.content : [];
  const toolCalls: ModelToolCall[] = [];
  const textParts: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      textParts.push(record.text);
    }
    if (record.type === "tool_use" && typeof record.name === "string") {
      toolCalls.push({
        id: String(record.id || crypto.randomUUID()),
        name: record.name as DaemonToolName,
        args: parseArgs(record.input)
      });
    }
  }

  return {
    text: textParts.join("\n"),
    toolCalls,
    raw: data
  };
}

function parseGoogleGeminiTurn(data: Record<string, unknown>): ModelTurn {
  const content = getGoogleModelContent(data);
  const parts = Array.isArray(content?.parts) ? content.parts : [];
  const toolCalls: ModelToolCall[] = [];
  const textParts: string[] = [];

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (typeof record.text === "string") {
      textParts.push(record.text);
    }

    const functionCall = record.functionCall;
    if (!functionCall || typeof functionCall !== "object") continue;
    const callRecord = functionCall as Record<string, unknown>;
    if (typeof callRecord.name !== "string") continue;

    toolCalls.push({
      id: String(callRecord.id || crypto.randomUUID()),
      name: callRecord.name as DaemonToolName,
      args: parseArgs(callRecord.args)
    });
  }

  return {
    text: textParts.join("\n"),
    toolCalls,
    raw: data
  };
}

function parseOpenAIChatCompletionsTurn(data: Record<string, unknown>): ModelTurn {
  const message = getOpenAIChatAssistantMessage(data);
  const toolCalls: ModelToolCall[] = [];
  const textParts: string[] = [];

  if (typeof message?.content === "string") textParts.push(message.content);
  const rawToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];

  for (const item of rawToolCalls) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const fn = record.function;
    if (!fn || typeof fn !== "object") continue;
    const functionRecord = fn as Record<string, unknown>;
    if (typeof functionRecord.name !== "string") continue;

    toolCalls.push({
      id: String(record.id || crypto.randomUUID()),
      name: functionRecord.name as DaemonToolName,
      args: parseArgs(functionRecord.arguments)
    });
  }

  return {
    text: textParts.join("\n"),
    toolCalls,
    raw: data
  };
}

function getGoogleModelContent(data: Record<string, unknown>):
  | { role: "model"; parts: unknown[] }
  | undefined {
  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  const first = candidates[0];
  if (!first || typeof first !== "object") return undefined;
  const content = (first as Record<string, unknown>).content;
  if (!content || typeof content !== "object") return undefined;
  const record = content as Record<string, unknown>;
  if (!Array.isArray(record.parts)) return undefined;
  return {
    role: "model",
    parts: record.parts
  };
}

function getOpenAIChatAssistantMessage(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0];
  if (!first || typeof first !== "object") return undefined;
  const message = (first as Record<string, unknown>).message;
  return message && typeof message === "object" ? (message as Record<string, unknown>) : undefined;
}

function extractTextParts(content: unknown[]): string[] {
  const textParts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") textParts.push(record.text);
  }
  return textParts;
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function toGoogleSchema(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(input)) {
    if (key === "additionalProperties") continue;
    if (key === "type" && typeof rawValue === "string") {
      output.type = googleSchemaType(rawValue);
      continue;
    }
    if (key === "properties" && rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      output.properties = Object.fromEntries(
        Object.entries(rawValue as Record<string, unknown>).map(([propertyName, propertySchema]) => [
          propertyName,
          toGoogleSchema(propertySchema)
        ])
      );
      continue;
    }
    if (key === "items") {
      output.items = toGoogleSchema(rawValue);
      continue;
    }
    output[key] = rawValue;
  }

  return output;
}

function googleSchemaType(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "object") return "OBJECT";
  if (normalized === "array") return "ARRAY";
  if (normalized === "string") return "STRING";
  if (normalized === "number") return "NUMBER";
  if (normalized === "integer") return "INTEGER";
  if (normalized === "boolean") return "BOOLEAN";
  return value.toUpperCase();
}

function googleModelCandidates(primaryModel: string): string[] {
  const configuredCandidates = parseModelList(process.env.GOOGLE_MODEL_CANDIDATES);
  const candidates = configuredCandidates.length > 0
    ? configuredCandidates
    : [
      primaryModel,
      process.env.GOOGLE_MODEL,
      process.env.GOOGLE_BACKUP_MODEL,
      process.env.GOOGLE_LAST_RESORT_MODEL,
      ...googleDefaultModelCandidates
    ];

  return [...new Set(candidates
    .filter((model): model is string => Boolean(model))
    .map((model) => model.replace(/^models\//, "")))]
    .sort((left, right) => googleModelStrength(left) - googleModelStrength(right));
}

function parseModelList(value?: string): string[] {
  return (value || "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function googleModelStrength(model: string): number {
  const normalized = model.replace(/^models\//, "");
  const index = googleModelStrengthOrder.indexOf(normalized);
  return index === -1 ? googleModelStrengthOrder.length : index;
}

function googleModelPath(model: string): string {
  return encodeURIComponent(model.replace(/^models\//, ""));
}

function googleMaxAttemptsPerModel(): number {
  const configured = Number(process.env.GOOGLE_MODEL_RETRIES);
  const retries = Number.isFinite(configured) ? Math.max(0, Math.min(5, Math.floor(configured))) : googleDefaultModelRetries;
  return retries + 1;
}

function shouldRetryGoogleModel(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return [
    "high demand",
    "try again later",
    "temporarily unavailable",
    "unavailable",
    "overloaded",
    "resource exhausted",
    "quota",
    "rate limit",
    "429",
    "500",
    "502",
    "503",
    "504",
    "network",
    "fetch failed",
    "econnreset",
    "etimedout"
  ].some((pattern) => message.includes(pattern));
}

function googleRetryDelayMs(attempt: number): number {
  return Math.min(4_000, 500 * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function extractErrorMessage(data: Record<string, unknown>): string | undefined {
  const error = data.error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}
