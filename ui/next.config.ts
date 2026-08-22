import { dirname, join } from "node:path";
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
    // Node resolution walks up from the importing file, so a bare specifier in
    // agent/src never reaches ui/node_modules: ui is not an ancestor of agent.
    // On this machine it happened to resolve from agent/node_modules, which is
    // an artifact of a local install and is absent on a clean checkout. The
    // deploy installs only ui's dependencies, so say where they are.
    const uiModules = join(dirname(fileURLToPath(import.meta.url)), "node_modules");
    config.resolve.modules = [uiModules, ...(config.resolve.modules ?? ["node_modules"])];
    return config;
  },
};

export default nextConfig;
