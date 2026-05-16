import type { AgentProvider, AgentStreamEvent } from "@coding-agent/shared";
import { runGitHubRepositoryTask } from "../../../../../lib/github-sandbox";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  installationId: z.number().int().positive(),
  repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prompt: z.string().min(1),
  provider: z.enum(["mock", "openai", "anthropic", "google", "groq"]).default("mock"),
  model: z.string().optional(),
  mode: z.enum(["auto", "read", "write"]).optional().default("auto"),
  autopilot: z.boolean().optional().default(false)
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
        const result = await runGitHubRepositoryTask({
          installationId: body.installationId,
          repoFullName: body.repoFullName,
          prompt: body.prompt,
          provider: body.provider as AgentProvider,
          model: body.model,
          mode: body.mode,
          autopilot: body.autopilot,
          signal: request.signal,
          onLifecycleEvent: (event) => send({ type: "lifecycle_event", event }),
          onToolStart: (event) => send({ type: "tool_started", event }),
          onToolEvent: (event) => send({ type: "tool_event", event })
        });
        send({ type: "result", result });
      } catch (error) {
        send({
          type: "error",
          error: error instanceof Error ? error.message : "GitHub repository task failed."
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
