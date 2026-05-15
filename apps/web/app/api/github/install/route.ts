import { getGitHubInstallUrl } from "../../../../lib/github-app";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.redirect(getGitHubInstallUrl());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not build GitHub App install URL." },
      { status: 400 }
    );
  }
}
