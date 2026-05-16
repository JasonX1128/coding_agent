import { runAgentTask, type ToolExecutor } from "@coding-agent/agent-core";
import {
  DEFAULT_DAEMON_ORIGIN,
  type AgentProvider,
  type AgentStreamEvent,
  type DaemonToolName
} from "@coding-agent/shared";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  provider: z.enum(["mock", "openai", "anthropic", "google", "groq"]).default("mock"),
  model: z.string().optional(),
  prompt: z.string().min(1),
  daemonOrigin: z.string().url().default(DEFAULT_DAEMON_ORIGIN),
  workspaceId: z.string().default("default")
});

export async function POST(request: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: AgentStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      try {
        const body = bodySchema.parse(await request.json());
        const executor = createDaemonExecutor(body.daemonOrigin, body.workspaceId);
        const result = await runAgentTask({
          provider: body.provider as AgentProvider,
          model: body.model,
          prompt: body.prompt,
          executor,
          onToolStart: (event) => send({ type: "tool_started", event }),
          onToolEvent: (event) => send({ type: "tool_event", event })
        });
        send({ type: "result", result });
      } catch (error) {
        send({
          type: "error",
          error: error instanceof Error ? error.message : "Unknown agent error"
        });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no"
    }
  });
}

function createDaemonExecutor(daemonOrigin: string, workspaceId: string): ToolExecutor {
  return async (name: DaemonToolName, args: Record<string, unknown>) => {
    const response = await fetch(`${daemonOrigin}/tools/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ...args,
        workspaceId
      })
    });

    const data = await response.json();
    if (!response.ok && data?.summary) return data;
    if (!response.ok) {
      throw new Error(data?.error || `${name} failed with ${response.status}`);
    }
    return data;
  };
}
