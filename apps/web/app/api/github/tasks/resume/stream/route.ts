import type { AgentStreamEvent } from "@coding-agent/shared";
import { resumeGitHubRepositoryTask } from "../../../../../../lib/github-sandbox";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  pauseId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  continuation: z.string().optional()
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
        const result = await resumeGitHubRepositoryTask({
          pauseId: body.pauseId,
          continuation: body.continuation,
          onToolStart: (event) => send({ type: "tool_started", event }),
          onToolEvent: (event) => send({ type: "tool_event", event })
        });
        send({ type: "result", result });
      } catch (error) {
        send({
          type: "error",
          error: error instanceof Error ? error.message : "Could not resume GitHub repository task."
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
