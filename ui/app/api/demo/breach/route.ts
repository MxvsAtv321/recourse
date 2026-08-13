import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DemoTrace } from "../../../../../agent/src/trace";

// Needs a real Node process to spawn the scenario, and must never be cached:
// every call is a distinct on-chain run.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 90_000;

/** next start runs with cwd = ui/, but tolerate being run from the repo root. */
function repoRoot(): string {
  const cwd = process.cwd();
  for (const c of [join(cwd, ".."), cwd]) {
    if (existsSync(join(c, "agent", "src", "engine.ts"))) return c;
  }
  throw new Error("could not locate the repo root from " + cwd);
}

function runScenario(root: string): Promise<DemoTrace> {
  const tsx = join(root, "agent", "node_modules", ".bin", "tsx");
  const script = join(root, "agent", "src", "demo", "breach-once.ts");
  if (!existsSync(tsx)) throw new Error("agent dependencies are not installed");

  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`scenario timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // The scenario tags its own failure. Scraping a stack only ever yields
        // whichever frame happened to be last, which names nothing useful.
        const tagged = err.split("\n").map((l) => l.trim()).find((l) => l.startsWith("RECOURSE_ERROR "));
        const cause = tagged ? tagged.slice("RECOURSE_ERROR ".length) : `exited ${code}`;
        reject(new Error(cause.slice(0, 200)));
        return;
      }
      try {
        resolve(JSON.parse(out) as DemoTrace);
      } catch {
        reject(new Error("scenario produced unparseable output"));
      }
    });
  });
}

export async function POST() {
  try {
    const trace = await runScenario(repoRoot());
    if (!trace?.events?.length) throw new Error("scenario produced an empty trace");
    return Response.json(trace, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    // The client falls back to the captured run. No stack ever reaches the page.
    const reason = e instanceof Error ? e.message : "unknown failure";
    console.error("[api/demo/breach]", reason);
    return Response.json({ error: reason }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
