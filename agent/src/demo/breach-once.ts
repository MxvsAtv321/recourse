/**
 * Runs the BREACH_PROVED scenario once against the already running local anvil
 * and prints the resulting DemoTrace as JSON on stdout.
 *
 * The API route spawns this rather than importing the engine, so the Next.js
 * bundle never has to resolve viem or the Foundry artifacts.
 *
 * On failure it writes one tagged line to stderr and exits non-zero. The caller
 * reads that line rather than scraping a stack, which only ever yields whatever
 * frame happened to be last.
 */
import { runBreachScenario } from "../engine.js";
import { buildDemoTrace } from "../trace.js";

try {
  const run = await runBreachScenario();
  process.stdout.write(JSON.stringify(buildDemoTrace(run)));
} catch (e) {
  const err = e as { shortMessage?: string; message?: string };
  const msg = (err.shortMessage ?? err.message ?? String(e)).split("\n")[0];
  process.stderr.write(`RECOURSE_ERROR ${msg}`);
  process.exit(1);
}
