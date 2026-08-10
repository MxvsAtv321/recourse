import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunArtifact } from "../../agent/src/artifact";

export type { RunArtifact };

/**
 * Reads the artifact written by `npm run capture`, which executes the five
 * scenarios against a live anvil node. If it is missing the page says so
 * rather than inventing numbers.
 */
export function loadRun(): RunArtifact | null {
  try {
    const raw = readFileSync(join(process.cwd(), "data", "run.json"), "utf8");
    return JSON.parse(raw) as RunArtifact;
  } catch {
    return null;
  }
}
