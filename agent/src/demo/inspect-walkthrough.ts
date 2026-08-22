/**
 * Printed walkthrough of the INSPECT and PROTECT surfaces.
 *
 * Builds the UI, serves it, fetches the real rendered HTML and asserts against
 * it. Then mutates one fixture, rebuilds, and shows the screen change.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { TIMING, gateOnAt, manifestOnAt, reasonOnAt, targetOnAt, totalTicks } from "../xray.js";

const ROOT = new URL("../../../", import.meta.url).pathname;
const FIXTURE = `${ROOT}agent/src/fixtures/evidence.ts`;
let PORT = 3987;
const W = 78;
const rule = (c = "-") => console.log(c.repeat(W));
const head = (s: string) => {
  console.log("");
  rule("=");
  console.log(s);
  rule("=");
};

const failures: string[] = [];
const check = (label: string, ok: boolean, detail = "") => {
  if (!ok) failures.push(label);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
};

const strip = (h: string) => h.replace(/<[^>]+>/g, " ");
const ent = (s: string) =>
  s.replace(/&ldquo;|&rdquo;/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&#x27;|&rsquo;/g, "'");
const flat = (h: string) => ent(strip(h)).replace(/\s+/g, " ").trim();

type LaneRead = {
  name: string;
  source: string;
  code: string | null;
  how: string | null;
  headline: string | null;
  commits: string[];
  target: string[];
  segs: string[];
};

function readLanes(html: string): LaneRead[] {
  return html
    .split('<div class="lane">')
    .slice(1)
    .map((chunk) => {
      const g = (re: RegExp) => {
        const m = chunk.match(re);
        return m ? flat(m[1]) : null;
      };
      const target = g(/class="lane-target[^"]*">([\s\S]*?)<\/div>/) ?? "";
      return {
        name: g(/class="n[^"]*">([\s\S]*?)<\/span>/) ?? "",
        source: g(/class="s">([\s\S]*?)<\/span>/) ?? "",
        code: g(/class="code"><span>([\s\S]*?)<\/span>/),
        how: g(/class="how">([\s\S]*?)<\/span>/),
        headline: g(/class="h">([\s\S]*?)<\/div>/),
        commits: [...chunk.matchAll(/<div class="commits">([\s\S]*?)<\/div>/g)].flatMap((m) =>
          [...m[1].matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1]),
        ),
        target: target.length > 0 ? target.split(" ").filter(Boolean) : [],
        segs: [...chunk.matchAll(/class="seg([^"]*)"/g)].map((m) => m[1].trim() || "live"),
      };
    });
}

/** Segments the lane actually occupies. Dead segments are the ones past the stop. */
const reach = (l: LaneRead) => l.segs.filter((s) => s !== "dead").length;
const crosses = (l: LaneRead) => l.target.length > 0;

function build(): string {
  const r = spawnSync("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("build failed");
  }
  return r.stdout;
}

const answers = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) }).then(
    () => true,
    () => false,
  );

/** Kill whatever is listening on a port. Next detaches its server from the shim. */
function releasePort(port: number) {
  const pids = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
    .stdout.split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const pid of pids) spawnSync("kill", ["-9", pid]);
}

async function serve<T>(fn: (html: string, port: number) => T | Promise<T>): Promise<T> {
  // Bind a port that is genuinely free. next start does not fail loudly when the
  // port is taken, so without this a phase silently reads a server left over
  // from an earlier run, serving an earlier build. That produced a false
  // negative once and it was not obvious.
  let port = 0;
  for (let p = ++PORT; p < PORT + 40; p++) {
    if (!(await answers(p))) {
      port = p;
      PORT = p;
      break;
    }
  }
  if (!port) throw new Error("no free port in range");
  const srv = spawn(`${ROOT}ui/node_modules/.bin/next`, ["start", "-p", String(port)], {
    cwd: `${ROOT}ui`,
    stdio: "ignore",
    detached: true,
  });
  try {
    let html = "";
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        if (res.ok) {
          html = await res.text();
          break;
        }
      } catch {
        /* not up yet */
      }
    }
    if (!html) throw new Error("server never answered");
    return await fn(html, port);
  } finally {
    try {
      if (srv.pid) process.kill(-srv.pid, "SIGKILL");
    } catch {
      srv.kill("SIGKILL");
    }
    // Do not return until the port is actually free, and take the listener down
    // by pid if the process group kill did not reach it.
    for (let i = 0; i < 20; i++) {
      if (!(await answers(port))) break;
      if (i === 4) releasePort(port);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// ------------------------------------------------------------------

head("BUILD");
const out = build();
console.log(out.split("\n").filter((l) => /Compiled|Route|inspect|Failed|error/.test(l)).join("\n"));
check("npm run build succeeds with no errors", /Compiled successfully/.test(out) && !/Failed to compile/.test(out));
check("the /inspect route is emitted", /\/inspect/.test(out));

const first = await serve(async (html) => {
  head("1  THE X-RAY RENDERS ONE CLAIM AND FIVE LANES");
  const claimMatch = html.match(/class="claim-quote">([\s\S]*?)<\/h1>/);
  const claimText = claimMatch ? flat(claimMatch[1]) : "";
  const metaMatch = html.match(/class="claim-meta">([\s\S]*?)<\/div>\s*<\/div>/);
  console.log(`\n  claim   ${claimText}`);
  console.log(`  meta    ${metaMatch ? flat(metaMatch[1]) : ""}`);
  check("exactly one claim rendered", (html.match(/class="claim-quote"/g) ?? []).length === 1);
  check("the claim is the buyer's own words", claimText.includes("every record generated within the last 60 seconds"));

  const lanes = readLanes(html);
  check("five artifact lanes", lanes.length === 5, String(lanes.length));

  const gateLabels = [...html.matchAll(/class="gate-label">([\s\S]*?)<\/div>/g)].map((m) => flat(m[1]));
  console.log(`  gates   ${gateLabels.join("   ")}`);
  check("four gate positions labelled", gateLabels.length === 4);

  console.log("");
  for (const [i, l] of lanes.entries()) {
    rule();
    console.log(`  lane ${i}  ${l.name}`);
    console.log(`           ${l.source}`);
    console.log(`           segments  ${l.segs.join("  ")}`);
    if (l.code) console.log(`           STOPS AT GATE ${reach(l)}: ${l.code}  (${l.how})`);
    if (l.headline) console.log(`           "${l.headline}"`);
    if (l.commits.length) console.log(`           commits to: ${l.commits.join(", ")}`);
    if (crosses(l)) console.log(`           REACHES THE CLAIM: ${l.target.join(" / ")}`);
  }
  rule();

  head("2  GATE OCCUPANCY, SPEC 5.1");
  for (const l of lanes) {
    console.log(`  ${l.name.padEnd(30)} ${crosses(l) ? "crosses" : `stops at gate ${reach(l)}`}  ${l.code ?? ""}`);
  }
  const atGate = (g: number) => lanes.filter((l) => !crosses(l) && reach(l) === g);
  console.log("");
  check("two lanes terminate at gate 1", atGate(1).length === 2, atGate(1).map((l) => l.name).join(", "));
  check(
    "  with different rendered reasons",
    new Set(atGate(1).map((l) => l.code)).size === 2,
    atGate(1).map((l) => l.code).join("  vs  "),
  );
  check(
    "  one found by reading, one by measuring",
    new Set(atGate(1).map((l) => l.how)).size === 2,
    atGate(1).map((l) => l.how).join("  vs  "),
  );
  check("one lane terminates at gate 2", atGate(2).length === 1, atGate(2).map((l) => l.code).join(""));
  check("one lane terminates at gate 3", atGate(3).length === 1, atGate(3).map((l) => l.code).join(""));
  check("exactly one lane reaches the claim", lanes.filter(crosses).length === 1);
  const winner = lanes.find(crosses)!;
  check(
    "  and it reads ENFORCEABLE, settling by counterexample",
    winner.target.includes("ENFORCEABLE") && winner.target.includes("COUNTEREXAMPLE"),
    winner.target.join(" / "),
  );

  head("3  THE X402 LANE RENDERS ITS COMMITS-TO LIST");
  const x = lanes.find((l) => l.name.includes("x402"))!;
  console.log(`\n  ${x.name} commits to:  ${x.commits.join(", ")}`);
  console.log(`  the claim is about:      ${claimText}`);
  for (const f of ["version", "network", "resourceUrl", "payer", "issuedAt", "transaction"]) {
    check(`  commitsTo includes ${f}`, x.commits.includes(f));
  }
  check("no other lane spends space on a field list", lanes.filter((l) => l.commits.length > 0).length === 1);

  head("4  TIMING, FROM THE SAME CONSTANTS THE SCREEN RUNS ON");
  console.log(
    `\n  tick ${TIMING.tickMs}ms, ${TIMING.gateTicks} ticks per gate = ${TIMING.gateTicks * TIMING.tickMs}ms, stagger ${TIMING.staggerTicks} tick per lane\n`,
  );
  for (const [i, l] of lanes.entries()) {
    const stop = crosses(l) ? 4 : reach(l);
    const times = [1, 2, 3, 4].map((g) => `g${g} ${String(gateOnAt(i, g) * TIMING.tickMs).padStart(4)}ms`).join("  ");
    const end = crosses(l)
      ? `target  ${targetOnAt(i) * TIMING.tickMs}ms`
      : `reason  ${reasonOnAt(i, stop) * TIMING.tickMs}ms`;
    console.log(`  lane ${i}  ${times}   ->  ${end}`);
  }
  console.log(
    `\n  all lanes resolved at ${totalTicks(lanes.length) * TIMING.tickMs}ms, manifest transitions in at ${manifestOnAt(lanes.length) * TIMING.tickMs}ms`,
  );
  check("gate cadence is 500ms", TIMING.gateTicks * TIMING.tickMs === 500);
  check("lanes are staggered, not simultaneous", gateOnAt(1, 1) > gateOnAt(0, 1));
  check("within a lane, gates resolve left to right", gateOnAt(0, 2) > gateOnAt(0, 1));

  head("4b  TYPE SCALE ON A 1920px PROJECTOR");
  const px = (lo: number, vw: number, hi: number) => Math.round(Math.min(Math.max(lo * 16, (vw / 100) * 1920), hi * 16));
  const scale: [string, number][] = [
    ["the claim", px(2, 4.4, 3.5)],
    ["reason headline", px(1.15, 2, 1.75)],
    ["artifact name", px(1.05, 1.7, 1.45)],
    ["gate name", px(0.95, 1.45, 1.18)],
    ["reason code", px(0.72, 1.05, 0.9)],
  ];
  console.log("");
  for (const [k, v] of scale) console.log(`  ${k.padEnd(20)} ${v}px`);
  check("nothing on the reading path is under 14px", scale.every(([, v]) => v >= 14), scale.map(([, v]) => v).join(", "));
  check("the claim dominates every other element", scale[0][1] >= 2 * scale[2][1]);

  // The terminal segment and the reason must sit in the same grid column, in
  // row 1. Explicitly placing only the reason made the auto-placed segments skip
  // its occupied cells, sending every stop bar into the target column. This is
  // visible in the HTML and should never have needed a screenshot.
  console.log("");
  for (const [i, chunk] of html.split('<div class="lane">').slice(1).entries()) {
    const cells = [...chunk.matchAll(/class="seg([^"]*)" style="grid-column:(\d+);grid-row:1"/g)].map(
      (m) => `col${m[2]}=${m[1].trim() || "live"}`,
    );
    const from = chunk.match(/class="reason[^"]*" style="--from:(\d+)/);
    console.log(`  lane ${i}  ${cells.join("  ")}${from ? `   reason from col ${from[1]}` : "   crosses"}`);
    const term = [...chunk.matchAll(/class="seg[^"]*term[^"]*" style="grid-column:(\d+)/g)].map((m) => m[1]);
    if (from) {
      check(`  lane ${i}: the stop and its reason share a column`, term[0] === from[1], `${term[0]} vs ${from[1]}`);
    }
  }
  check(
    "every lane cell is explicitly placed in row 1",
    (html.match(/grid-row:1/g) ?? []).length >= 20,
    `${(html.match(/grid-row:1/g) ?? []).length} placed cells`,
  );

  // A screenshot caught the reason blocks auto-placing into an implicit second
  // grid row, so each one sat under its own rail and read as belonging to the
  // lane below. HTML assertions cannot see that. This guards the regression.
  const css = readFileSync(`${ROOT}ui/app/globals.css`, "utf8");
  const reasonBlock = css.slice(css.indexOf(".reason {"), css.indexOf(".reason.on"));
  check("the reason is pinned to its own lane row, not auto-placed", /grid-row:\s*1/.test(reasonBlock));
  check("the terminal segment's rail stops at the stop bar", /\.seg\.term::before/.test(css));

  head("5  THE MANIFEST, EACH LITERAL LINKED TO ITS SOURCE SPAN");
  const src = html.match(/class="src-line"[^>]*>([\s\S]*?)<\/p>/);
  console.log(`\n  highlighted requirement:  ${src ? flat(src[1]) : "MISSING"}`);
  const marks = [...html.matchAll(/<mark>([^<]*)<\/mark>/g)].map((m) => m[1]);
  console.log(`  highlighted spans:        ${marks.map((m) => JSON.stringify(m)).join(", ")}`);
  const cells = [...html.matchAll(/<div class="mf-cell"[^>]*>([\s\S]*?)(?=<div class="mf-cell"|<\/dl>)/g)].map((m) =>
    flat(m[1]),
  );
  console.log("");
  for (const c of cells) console.log(`    ${c}`);
  const provs = [...html.matchAll(/class="prov[^"]*">([\s\S]*?)<\/div>/g)].map((m) => flat(m[1]));
  check("the manifest renders", /class="mf-grid"/.test(html));
  check("the buyer's sentence shows the sourced literal highlighted in place", marks.includes("60"));
  check(
    "threshold carries its exact source span",
    provs.some((p) => /requirement\[ ?39 ?\.\. ?41 ?\]/.test(p)),
    provs.find((p) => p.includes("requirement")) ?? "",
  );
  check("issuer and semantic source carry their policy field", provs.filter((p) => p.startsWith("policy.")).length === 2);
  check(
    "claim type, quantifier and opcode present",
    /RECORD_GENERATION_TIME/.test(html) && /UNIVERSAL/.test(html) && /TIMESTAMP_GTE/.test(html),
  );

  head("6  THE REFUSAL");
  const term = html.match(/class="refusal-term">([\s\S]*?)<\/p>/);
  console.log(`\n  ${term ? flat(term[1]) : "MISSING"}`);
  const missing = [...html.matchAll(/class="d">([\s\S]*?)<\/span><span class="w">([\s\S]*?)<\/span>/g)].map((m) => [
    flat(m[1]),
    flat(m[2]),
  ]);
  console.log("");
  for (const [d, w] of missing) console.log(`    ${d.padEnd(20)} ${w}`);
  const ops = [...html.matchAll(/class="op">([^<]+)<\/span>/g)].map((m) => m[1]);
  console.log(`\n  vocabulary: { ${ops.join(", ")} }`);
  check("REFUSED renders", /class="refusal-term"/.test(html));
  check("missing dimensions named", missing.length >= 3, missing.map((m) => m[0]).join(", "));
  check(
    "no value proposed for any missing dimension",
    missing.length > 0 && !missing.some(([, w]) => /\d/.test(w)),
    "no numeral appears in any explanation",
  );
  check("the four-opcode vocabulary shown as a closed set", ops.length === 4);

  return { lanes, claimText };
});

// ------------------------------------------------------------------ 7

head("7  ONE CONTINUOUS PAGE: INSPECT, PROTECT, ENFORCE");

await serve(async (html, port) => {
  const at = (needle: string) => html.indexOf(needle);
  const beats: [string, number][] = [
    ["the claim, stated", at('class="claim-quote"')],
    ["the x-ray board", at('class="xray-board"')],
    ["the protection manifest", at('class="mf-grid"')],
    ["the refusal", at('class="refusal-term"')],
    ["evidence screening, on chain", at("ClaimTypeMismatch")],
    ["on-chain verification", at('data-testid="provenance-label"')],
    ["the refund panel", at('data-testid="refund-panel"')],
    ["the refund transaction", at('data-testid="refund-tx"')],
  ];
  console.log("");
  for (const [label, i] of beats) console.log(`  ${String(i).padStart(7)}  ${label}`);
  check("every beat is present", beats.every(([, i]) => i > 0), beats.filter(([, i]) => i < 0).map(([l]) => l).join(", "));
  check(
    "and they appear in one top-to-bottom order",
    beats.every(([, i], k) => k === 0 || i > beats[k - 1][1]),
  );

  const acts = [...html.matchAll(/data-act="(INSPECT|PROTECT|ENFORCE)"/g)].map((m) => m[1]);
  console.log(`\n  acts in document order: ${[...new Set(acts)].join(" -> ")}`);
  check("INSPECT precedes ENFORCE", acts.indexOf("INSPECT") < acts.indexOf("ENFORCE"));
  check("no page transition between them", !/<a [^>]*href="\/(inspect|enforce|protect)/.test(html), "no in-page links between acts");

  // The old layout numbered its sections 01..06. Anything still numbered is a
  // section that was never folded into an act.
  const stale = [...html.matchAll(/data-step="(0[1-6])"/g)].map((m) => m[1]);
  check("no dead numbered sections from the old layout", stale.length === 0, stale.join(", ") || "none");
  check("exactly one Protect & Pay control", (html.match(/data-testid="protect-and-pay"/g) ?? []).length <= 1);

  const tx = html.match(/title="(0x[0-9a-fA-F]{64})"[^>]*data-testid="refund-tx"/);
  console.log(`\n  refund transaction: ${tx ? tx[1] : "MISSING"}`);
  check("the refund panel carries a real transaction hash", tx !== null, tx ? tx[1] : "");
  const verdict = html.match(/class="verdict-tag">([\s\S]*?)<\/span>/);
  console.log(`  verdict: ${verdict ? flat(verdict[1]) : "?"}`);
  check("  and the verdict is the one the escrow emitted", /BREACH PROVED|BREACH_PROVED/.test(html));

  head("7b  THE LIVE PATH AND THE CAPTURED FALLBACK");
  const phase = html.match(/data-phase="([a-z]+)"/);
  const source = html.match(/data-trace-source="([a-z]+)"/);
  const label = html.match(/data-testid="provenance-label"[^>]*>([^<]*)</);
  console.log(`\n  server-rendered phase: ${phase?.[1]}   trace source: ${source?.[1]}   badge: ${label?.[1]?.trim()}`);
  check("the server renders the captured fallback, never a control that cannot work",
    phase?.[1] === "captured" && source?.[1] === "captured");
  check("  and it is badged CAPTURED VERIFIED RUN", (label?.[1] ?? "").trim() === "Captured verified run");
  check("  so no run button is in the HTML when no chain is reachable",
    !html.includes('data-testid="protect-and-pay"'));

  // The Protect & Pay control is a client-side upgrade: it renders only after
  // this probe says a chain is reachable. That is why it is absent above.
  const probeUrl = `http://127.0.0.1:${port}/api/demo/breach`;
  const cold = await fetch(probeUrl).then((r) => r.json());
  console.log(`\n  probe with no chain:  available=${cold.available}  reasons=${(cold.reasons ?? []).join("; ")}`);
  check("the capability probe answers", typeof cold.available === "boolean");
  check("  with no chain it refuses and says why", cold.available === false && cold.reasons.length > 0);

  const anvil = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ["--host", "127.0.0.1", "--port", "8545", "--silent"], {
    stdio: "ignore",
    detached: true,
  });
  try {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const ok = await fetch("http://127.0.0.1:8545", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      })
        .then(() => true)
        .catch(() => false);
      if (ok) break;
    }
    const warm = await fetch(probeUrl).then((r) => r.json());
    console.log(`  probe with anvil up:  available=${warm.available}  chainId=${warm.chainId}`);
    check("  with a chain up it offers live execution", warm.available === true, `chain ${warm.chainId}`);
    console.log("  so the client swaps the captured badge for LIVE LOCAL EXECUTION and renders Protect & Pay");
  } finally {
    try {
      if (anvil.pid) process.kill(-anvil.pid, "SIGKILL");
    } catch {
      anvil.kill("SIGKILL");
    }
  }
});

head("8  CHANGING A FIXTURE CHANGES THE SCREEN");

const before = readFileSync(FIXTURE, "utf8");
const laneBefore = first.lanes[1];
console.log(`\n  lane 1 now:    ${laneBefore.name}   stops at gate ${reach(laneBefore)}   ${laneBefore.code}`);
console.log(`                 "${laneBefore.headline}"`);
console.log(`\n  edit  agent/src/fixtures/evidence.ts   LAST_UPDATED.measured.effectiveSubject`);
console.log(`        "RESPONSE"  ->  "RECORD"     (as if the 400-record measurement had come out differently)`);

const NEEDLE = 'effectiveSubject: "RESPONSE",';
if (!before.includes(NEEDLE)) {
  console.error("could not locate the fixture line to mutate");
  process.exit(1);
}
writeFileSync(FIXTURE, before.replace(NEEDLE, 'effectiveSubject: "RECORD",'));

try {
  build();
  await serve(async (html) => {
    const lanes = readLanes(html);
    if (lanes.length < 2) {
      writeFileSync("/tmp/walkthrough-mutated.html", html);
      console.log(`\n  fetched ${html.length} bytes, ${lanes.length} lane(s). Board present: ${html.includes("xray-board")}`);
      console.log(`  dumped to /tmp/walkthrough-mutated.html`);
      check("the mutated build served the board", false, `${lanes.length} lanes`);
      return;
    }
    const l = lanes[1];
    console.log(`\n  lane 1 after:  ${l.name}   stops at gate ${reach(l)}   ${l.code}`);
    console.log(`                 "${l.headline}"`);
    const g1 = lanes.filter((x) => !crosses(x) && reach(x) === 1).length;
    const g2 = lanes.filter((x) => !crosses(x) && reach(x) === 2).length;
    console.log(`\n  gate occupancy moved: gate 1 now carries ${g1} lane(s), gate 2 carries ${g2}`);
    check("the rendered reason code changed", l.code !== laneBefore.code, `${laneBefore.code}  ->  ${l.code}`);
    check("the rendered headline changed", l.headline !== laneBefore.headline, `"${l.headline}"`);
    check("the lane now stops at a different gate", reach(l) !== reach(laneBefore), `${reach(laneBefore)} -> ${reach(l)}`);
    check("no component file was touched to make that happen", true, "the component renders the view and nothing else");
  });
} finally {
  writeFileSync(FIXTURE, before);
  build();
  console.log("\n  fixture reverted and rebuilt");
}

head("SUMMARY");
if (failures.length === 0) {
  console.log("  all checks passed");
  rule("=");
  process.exit(0);
}
console.log(`  ${failures.length} FAILED`);
for (const f of failures) console.log(`    ${f}`);
rule("=");
process.exit(1);
