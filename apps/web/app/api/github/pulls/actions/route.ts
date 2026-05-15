import { approvePullRequest, closePullRequest } from "../../../../../lib/github-app";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const bodySchema = z.object({
  installationId: z.number().int().positive(),
  repoFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  number: z.number().int().positive(),
  action: z.enum(["approve", "close"]),
  confirmation: z.enum(["approve", "close"])
}).refine((body) => body.action === body.confirmation, {
  message: "Confirmation must match the requested pull request action."
});

export async function POST(request: Request) {
  try {
    const body = bodySchema.parse(await request.json());

    if (body.action === "approve") {
      const review = await approvePullRequest(body);
      return NextResponse.json({
        action: body.action,
        review,
        summary: `Approved pull request #${body.number}.`
      });
    }

    const pullRequest = await closePullRequest(body);
    return NextResponse.json({
      action: body.action,
      pullRequest,
      summary: `Closed pull request #${body.number}.`
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not update GitHub pull request." },
      { status: 400 }
    );
  }
}
