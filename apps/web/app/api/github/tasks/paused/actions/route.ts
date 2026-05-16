import { actOnPausedGitHubRun } from "../../../../../../lib/github-sandbox";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  pauseId: z.string().regex(/^[A-Za-z0-9_-]+$/),
  action: z.enum(["open_draft_pr", "stop", "discard"])
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());
    const result = await actOnPausedGitHubRun({
      pauseId: body.pauseId,
      action: body.action
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update paused GitHub run." },
      { status: 400 }
    );
  }
}
