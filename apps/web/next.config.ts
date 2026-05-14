import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@coding-agent/shared", "@coding-agent/agent-core"]
};

export default nextConfig;
