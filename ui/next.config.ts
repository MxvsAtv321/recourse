import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // A stray lockfile above this repo makes Next guess the wrong workspace root.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  // The agent workspace is ESM TypeScript and imports with explicit .js
  // specifiers, which is correct for Node but which webpack does not map back to
  // .ts on its own. The INSPECT surface imports the engine directly rather than
  // reading a pre-baked JSON, so the mapping has to exist here.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
