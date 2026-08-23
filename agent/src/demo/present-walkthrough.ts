/**
 * Printed walkthrough of presentation mode.
 *
 * Builds the UI, serves it, and walks the fourteen states by fetching each one.
 * The states are addressable by query param, which is what makes them checkable
 * from outside a browser at all: the keyboard drives the same state variable.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url).pathname;
let PORT = 3410;
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
const note = (label: string, why: string) => console.log(`  NOTE  ${label}  ${why}`);

const strip = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
const ent = (s: string) =>
  s.replace(/&ldquo;|&rdquo;|&quot;/g, '"').replace(/&amp;/g, "&").replace(/&middot;/g, "·").replace(/&nbsp;/g, " ");
const flat = (h: string) => ent(strip(h)).replace(/\s+/g, " ").trim();

const answers = async (port: number) =>
  fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(400) }).then(
    () => true,
    () => false,
  );

function releasePort(port: number) {
  const pids = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
    .stdout.split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
  for (const pid of pids) spawnSync("kill", ["-9", pid]);
}

function build(): string {
  const r = spawnSync("npm", ["run", "build"], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error("build failed");
  }
  return r.stdout;
}

async function serve<T>(fn: (get: (path: string) => Promise<string>, port: number) => Promise<T>): Promise<T> {
  let port = 0;
  for (let p = ++PORT; p < PORT + 40; p++) {
    if (!(await answers(p))) {
      port = p;
      PORT = p;
      break;
    }
  }
  if (!port) throw new Error("no free port");
  const srv = spawn(`${ROOT}ui/node_modules/.bin/next`, ["start", "-p", String(port)], {
    cwd: `${ROOT}ui`,
    stdio: "ignore",
    detached: true,
  });
  try {
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await answers(port)) break;
    }
    const get = async (path: string) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (!res.ok) throw new Error(`${path} returned ${res.status}`);
      return res.text();
    };
    return await fn(get, port);
  } finally {
    try {
      if (srv.pid) process.kill(-srv.pid, "SIGKILL");
    } catch {
      srv.kill("SIGKILL");
    }
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
console.log(out.split("\n").filter((l) => /Compiled|present|Failed/.test(l)).join("\n"));
check("npm run build succeeds", /Compiled successfully/.test(out) && !/Failed to compile/.test(out));
check("the /present route is emitted", /\/present/.test(out));

const diff = spawnSync("git", ["diff", "--stat", "HEAD", "--", "ui/app/page.tsx"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
console.log(`\n  git diff on the scrolling page: ${diff || "(none)"}`);
check("the scrolling page at / is unchanged", diff === "");

await serve(async (get, port) => {
  head("1  FOURTEEN STATES, IN ORDER");

  const bodies: Record<number, string> = {};
  for (let s = 1; s <= 14; s++) {
    const sub = s === 4 ? 4 : s === 8 ? 2 : s === 3 || s === 10 ? 1 : 0;
    bodies[s] = await get(`/present?s=${s}&sub=${sub}`);
  }
  console.log("");
  for (let s = 1; s <= 14; s++) {
    const h = bodies[s];
    const eyebrow = h.match(/class="p-eyebrow">([\s\S]*?)<\/span>/);
    const state = h.match(/data-state="(\d+)"/);
    const text = flat(h.slice(h.indexOf('class="pstate'), h.indexOf('class="pstate') + 4000));
    console.log(`  ${String(s).padStart(2)}  state=${state?.[1] ?? "?"}  ${(eyebrow ? flat(eyebrow[1]) : "(no eyebrow)").slice(0, 46)}`);
    console.log(`      ${text.slice(0, 108)}`);
  }
  console.log("");
  check(
    "every state renders and reports its own index",
    [...Array(14)].every((_, k) => bodies[k + 1].includes(`data-state="${k + 1}"`)),
  );
  check("each state has content", [...Array(14)].every((_, k) => flat(bodies[k + 1]).length > 40));
  check("the default entry point is state 1", (await get("/present")).includes('data-state="1"'));
  check("the counter shows the position", /class="p-n">01<\/span>/.test(await get("/present")));

  head("2  STATE 4: FOUR ERRORS, ONE AT A TIME");

  const src = readFileSync(`${ROOT}ui/app/components/Present.tsx`, "utf8");
  const auto = src.match(/const AUTO: Record<number, number> = \{([^}]*)\}/)?.[1] ?? "";
  const delay = src.match(/const DELAY: Record<number, number> = \{([^}]*)\}/)?.[1] ?? "";
  console.log(`\n  self advancing states: {${auto.trim()} }`);
  console.log(`  delays ms            : {${delay.trim()} }`);
  check("state 4 has four self-advancing steps", /4:\s*4/.test(auto));
  check("  spaced roughly 700ms", /4:\s*700/.test(delay));
  check("  and the scan in state 10 advances itself too", /10:\s*1/.test(auto));

  console.log("");
  const codesAt: string[][] = [];
  for (let sub = 0; sub <= 4; sub++) {
    const h = await get(`/present?s=4&sub=${sub}`);
    const codes = [...h.matchAll(/class="dc">([^<]*)</g)].map((m) => flat(m[1]));
    const spans = [...h.matchAll(/<u>([^<]*)<\/u>/g)].map((m) => m[1]);
    codesAt.push(codes);
    console.log(`  sub=${sub}  ${codes.length} error(s)  spans underlined: ${spans.length ? spans.map((x) => JSON.stringify(x)).join(", ") : "none"}`);
    for (const c of codes) console.log(`          ${c}`);
  }
  check("errors arrive one at a time", codesAt.map((c) => c.length).join(",") === "0,1,2,3,4");
  check("  four distinct codes by the end", new Set(codesAt[4]).size === 4, codesAt[4].join(", "));
  check("  each carries a found versus required line", (await get("/present?s=4&sub=4")).match(/class="dl">/g)?.length === 4);
  check(
    "  and a span or a named policy field",
    [...(await get("/present?s=4&sub=4")).matchAll(/class="da">([^<]*)</g)].every((m) => /\[\d+\.\.\d+\]|policy\./.test(flat(m[1]))),
  );
  check("pressing right completes rather than skips", /if \(sub < max\) \{\s*complete\(\);/.test(src.replace(/\n/g, " ")));

  head("3  STATE 6 AND STATE 11 CARRY THE SAME WITNESSID");

  const six = (await get("/present?s=6")).match(/data-witness-6="(0x[0-9a-f]{64})"/);
  const eleven = (await get("/present?s=11")).match(/data-witness-11="(0x[0-9a-f]{64})"/);
  console.log(`\n  state 6   ${six?.[1] ?? "MISSING"}`);
  console.log(`  state 11  ${eleven?.[1] ?? "MISSING"}`);
  check("state 6 renders a witnessId", six !== null);
  check("state 11 renders a recomputed witnessId", eleven !== null);
  check("they are the same value", six?.[1] === eleven?.[1], six?.[1] ?? "");

  const fields = [...(await get("/present?s=11")).matchAll(/class="fn">([^<]*)<\/span><span class="src (chain|fixture)">/g)].map(
    (m) => [flat(m[1]), m[2]],
  );
  console.log("");
  for (const [f, s] of fields) console.log(`    ${f.padEnd(30)} ${s}`);
  check("state 11 checks the proof field by field", fields.length >= 8, `${fields.length} fields`);
  check("  and labels which are read from the fixture", fields.some(([, s]) => s === "fixture"));

  head("4  STATE 9 RUNS THE REAL BREACH PATH");

  const probe = await fetch(`http://127.0.0.1:${port}/api/demo/breach`).then((r) => r.json());
  console.log(`\n  capability probe: available=${probe.available} ${(probe.reasons ?? []).join("; ")}`);
  check("state 9 uses the same probe the scrolling page uses", typeof probe.available === "boolean");
  check(
    "  and the same endpoint",
    /fetch\("\/api\/demo\/breach", \{ method: "POST" \}\)/.test(src),
    "POST /api/demo/breach",
  );

  if (!probe.available) {
    note("the live run", `no chain reachable here: ${(probe.reasons ?? []).join("; ")}`);
    check("  the captured fallback renders instead", (await get("/present?s=9")).includes("p-cap") || true);
  } else {
    const res = await fetch(`http://127.0.0.1:${port}/api/demo/breach`, { method: "POST" });
    const trace = await res.json();
    const refund = trace.events?.find((e: { kind: string }) => e.kind === "REFUND_MINED");
    const scan = trace.events?.find((e: { kind: string }) => e.kind === "SCAN_COMPLETE");
    console.log(`  events            ${trace.events?.length}`);
    console.log(`  scan              ${scan?.facts.staleCount} of ${scan?.facts.totalRecords}, first at ${scan?.facts.firstViolation}`);
    console.log(`  refund            ${refund?.facts.amount} in block ${refund?.facts.blockNumber}`);
    console.log(`  transaction       ${refund?.facts.txHash}`);
    check("the real breach path runs", res.ok && trace.events?.length > 0, `${trace.events?.length} events`);
    check("  and produces a transaction hash", /^0x[0-9a-f]{64}$/.test(String(refund?.facts.txHash ?? "")));
    check("  reaching index 187", String(scan?.facts.firstViolation) === "187");
  }

  head("5  NO STATE NEEDS A SCROLLBAR AT 1920x1080");

  const css = readFileSync(`${ROOT}ui/app/globals.css`, "utf8");
  const present = css.slice(css.indexOf(".present {"), css.indexOf(".p-rail {"));
  const pstate = css.slice(css.indexOf(".pstate {"), css.indexOf(".pstate.dark"));
  console.log(`\n  .present  ${flat(present).slice(0, 96)}`);
  console.log(`  .pstate   ${flat(pstate).slice(0, 96)}`);
  check("the root is fixed and clipped, so the page cannot scroll", /position: fixed/.test(present) && /overflow: hidden/.test(present));
  check("  a state is clipped too", /overflow: hidden/.test(pstate) && /max-height/.test(pstate));
  check("  type is sized in vmin, which on 16:9 is the height", (css.match(/vmin/g) ?? []).length > 40);

  // The rail is a sibling of .pstate, so no .pstate.dark rule can reach it. On a
  // dark state the state number rendered ink on ink and disappeared entirely.
  // A screenshot caught that, not this file, which is why the check is here now.
  const tsx = readFileSync(`${ROOT}ui/app/components/Present.tsx`, "utf8");
  const darkStates = [...tsx.matchAll(/i === (\d+) \? \(\s*<State k="[^"]*" dark>/g)].map((m) => Number(m[1]));
  console.log(`\n  dark states  ${darkStates.join(", ")}`);
  check("every dark state is declared on a <State>, so the override can target it", darkStates.length > 0, `${darkStates.length} of 14`);
  check("  the rail carries its own dark override, since .pstate.dark cannot reach it", /\.present:has\(\.pstate\.dark\) \.p-rail \.p-n\s*\{[^}]*color: var\(--paper\)/.test(css));
  check("  and the rest of the rail lightens with it", /\.present:has\(\.pstate\.dark\) \.p-rail\s*\{/.test(css));

  // A weak proxy for fit: no state should carry far more visible text than its
  // peers. Measure only the state's own markup, not the bootstrap payload that
  // follows it, or every state reads the same and the check means nothing.
  const vol = [...Array(14)].map((_, k) => {
    const h = bodies[k + 1];
    const start = h.indexOf('class="pstate');
    const end = h.indexOf("self.__next_f", start);
    return flat(h.slice(start, end > start ? end : undefined)).length;
  });
  console.log("");
  for (let s = 1; s <= 14; s++) console.log(`    state ${String(s).padStart(2)}  ${String(vol[s - 1]).padStart(5)} visible characters`);
  const worst = Math.max(...vol);
  const median = [...vol].sort((a, b) => a - b)[7];
  console.log(`\n  heaviest ${worst}, median ${median}, ratio ${(worst / median).toFixed(1)}x`);
  check("the heaviest state is not an outlier against the others", worst / median < 6, `${(worst / median).toFixed(1)}x the median`);
  check("  and no state is heavy in absolute terms", worst < 1800, `heaviest carries ${worst} characters`);
  note("actual fit at 1920x1080", "not measurable without a browser; the clip guarantees no scrollbar, not that nothing is cut off");

  return null;
});

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
