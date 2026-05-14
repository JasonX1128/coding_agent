import { runAgentTask, type ToolExecutor } from "@coding-agent/agent-core";
import { DEFAULT_DAEMON_ORIGIN, type AgentProvider, type DaemonToolName } from "@coding-agent/shared";
import { NextResponse } from "next/server";
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
  try {
    const body = bodySchema.parse(await request.json());
    const executor = createDaemonExecutor(body.daemonOrigin, body.workspaceId);
    const result = await runAgentTask({
      provider: body.provider as AgentProvider,
      model: body.model,
      prompt: body.prompt,
      executor
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown agent error"
      },
      { status: 400 }
    );
  }
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
