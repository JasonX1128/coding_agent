import type { AgentProvider } from "@coding-agent/shared";
import { runGitHubRepositoryTask } from "../../../../lib/github-sandbox";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  installationId: z.number().int().positive(),
  repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  prompt: z.string().min(1),
  provider: z.enum(["mock", "openai", "anthropic", "google", "groq"]).default("mock"),
  model: z.string().optional(),
  mode: z.enum(["auto", "read", "write"]).optional().default("auto")
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const result = await runGitHubRepositoryTask({
      installationId: body.installationId,
      repoFullName: body.repoFullName,
      prompt: body.prompt,
      provider: body.provider as AgentProvider,
      model: body.model,
      mode: body.mode
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "GitHub repository task failed." },
      { status: 400 }
    );
  }
}
