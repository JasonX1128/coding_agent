import { listOpenAgentPullRequests } from "../../../../lib/github-app";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const querySchema = z.object({
  installationId: z.coerce.number().int().positive(),
  repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)
});

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = querySchema.parse({
      installationId: url.searchParams.get("installationId"),
      repoFullName: url.searchParams.get("repoFullName")
    });
    const pullRequests = await listOpenAgentPullRequests(query);
    return NextResponse.json({ pullRequests });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list GitHub pull requests." },
      { status: 400 }
    );
  }
}
