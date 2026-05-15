import { saveInstallation } from "../../../../lib/github-app";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const installationId = Number(url.searchParams.get("installation_id"));
    if (!Number.isFinite(installationId) || installationId <= 0) {
      throw new Error("GitHub setup callback did not include a valid installation_id.");
    }

    await saveInstallation(installationId);
    return NextResponse.redirect(new URL("/?githubInstalled=1", request.url));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "GitHub setup failed." },
      { status: 400 }
    );
  }
}
