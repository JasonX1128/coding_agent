import { getGitHubInstallUrl, listInstalledRepositories, loadInstallations } from "../../../../lib/github-app";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const repositories = await listInstalledRepositories();
    const installations = await loadInstallations();
    return NextResponse.json({
      installUrl: getGitHubInstallUrl(),
      installations,
      repositories
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not list GitHub repositories." },
      { status: 400 }
    );
  }
}
