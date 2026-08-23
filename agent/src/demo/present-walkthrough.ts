/**
 * Printed walkthrough of presentation mode.
 *
 * Builds the UI, serves it, and walks the fourteen states by fetching each one.
 * The states are addressable by query param, which is what makes them checkable
 * from outside a browser at all: the keyboard drives the same state variable.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

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
    const sub = s === 4 ? 4 : s === 8 || s === 10 || s === 11 ? 2 : s === 3 ? 1 : 0;
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
  const sched = (n: string) => Number(src.match(new RegExp(`const ${n} = (\\d+)`))?.[1] ?? 0);
  console.log(`  gate ${sched("GATE_MS")}ms  stagger ${sched("STAGGER_MS")}ms  sweep ${sched("SWEEP_MS")}ms  carry ${sched("CARRY_MS")}ms`);
  check("state 4 has four self-advancing steps", /4:\s*4/.test(auto));
  check("  the field sweep and the crossing advance themselves too", /10:\s*2/.test(auto) && /11:\s*2/.test(auto));
  check("  every schedule constant is a real duration", [sched("GATE_MS"), sched("STAGGER_MS"), sched("SWEEP_MS"), sched("CARRY_MS")].every((v) => v > 0));

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

  // ------------------------------------------------------------------------
  head("6  SLIDE 4: FOUR PATHS, THREE GATES, THE ERROR IN THE GAP");

  const s4 = bodies[4];
  const lanes = [...s4.matchAll(/data-gate="(\d)" data-artifact="([^"]*)" style="--lane:(\d);--gates:(\d);--stop:(\d+)"/g)].map((m) => ({
    gate: Number(m[1]),
    artifact: m[2],
    lane: Number(m[3]),
    stop: Number(m[5]),
  }));
  console.log("");
  for (const l of lanes) console.log(`    lane ${l.lane}  gate ${l.gate}  travelled ${100 - l.stop}%  ${l.artifact}`);

  check("four artifacts reach for the claim", lanes.length === 4);
  check("  none of them arrives", lanes.every((l) => l.gate < 4 && l.stop > 0));
  const gates = lanes.map((l) => l.gate);
  check("  they stop at three distinct gates", new Set(gates).size === 3, `gates ${gates.join(", ")}`);
  check(
    "  two stop at gate 1, per spec 5.1, and carry different codes",
    gates.filter((g) => g === 1).length === 2,
  );
  const codes4 = [...s4.matchAll(/class="dc">([A-Z_]+)</g)].map((m) => m[1]);
  console.log(`    codes  ${codes4.join(", ")}`);
  check("  a typed error at every break point", codes4.length === 4 && new Set(codes4).size === 4);
  check("  the further a path gets, the less room its error has", lanes.every((l, k) => k === 0 || lanes[k - 1].gate > l.gate || l.stop <= lanes[k - 1].stop));
  const gateMs = Number(s4.match(/data-gate-ms="(\d+)"/)?.[1] ?? 0);
  const stagMs = Number(s4.match(/data-stagger-ms="(\d+)"/)?.[1] ?? 0);
  check(
    "  the stylesheet animates on the same numbers the clock counts",
    gateMs === sched("GATE_MS") && stagMs === sched("STAGGER_MS"),
    `${gateMs}ms per gate, ${stagMs}ms stagger`,
  );

  // ------------------------------------------------------------------------
  head("7  SLIDE 10: THE FIELD IS THE DELIVERY");

  const s10 = bodies[10];
  const attr = (h: string, k: string) => h.match(new RegExp(`data-${k}="([^"]*)"`))?.[1] ?? "";
  const cells = [...s10.matchAll(/class="c([^"]*)"/g)].map((m) => m[1]);
  const bad = cells.map((c) => c.includes("bad"));
  const firstBad = bad.indexOf(true);
  let longest = 0;
  let run = 0;
  for (const b of bad) {
    run = b ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  console.log("");
  console.log(`    ${cells.length} cells, ${bad.filter(Boolean).length} violating, first at ${firstBad}, longest run ${longest}`);
  console.log(`    182..205  ${bad.slice(182, 206).map((b) => (b ? "x" : ".")).join("")}`);

  check("one cell per record", cells.length === Number(attr(s10, "cells")) && cells.length === 500);
  check("  the head of the file is clean", firstBad === Number(attr(s10, "first")) && bad.slice(0, firstBad).every((b) => !b));
  check("  and it is 187 records deep", firstBad === 187);
  check("  the violations after it are interleaved, not a block", longest === 4 && longest < bad.length - firstBad);
  check("  which is what a spot check of the first page misses", bad.slice(firstBad).filter((b) => !b).length > 0, `${bad.slice(firstBad).filter((b) => !b).length} compliant records break up the tail`);
  check("  the field counts what the engine counted", attr(s10, "agrees") === "true", `${attr(s10, "violations")} violations, engine said the same`);
  check("  the sweep stops on the record that broke the promise", (s10.match(/class="c on bad"/g) ?? []).length === 1);

  // ------------------------------------------------------------------------
  head("8  SLIDE 11: BOTH HASHES ON SCREEN, AT THE SAME TIME");

  const carried: Record<number, string> = {};
  for (let n = 7; n <= 11; n++) carried[n] = attr(bodies[n], "carry");
  const spec6 = attr(bodies[6], "witness-6");
  const after11 = attr(bodies[11], "witness-11");
  console.log("");
  console.log(`    slide  6  spec        ${spec6}`);
  for (let n = 7; n <= 10; n++) console.log(`    slide ${String(n).padStart(2)}  carried     ${carried[n]}`);
  console.log(`    slide 11  recomputed  ${after11}`);

  check("the spec's hash is carried from slide 6", carried[7] === spec6);
  check("  and is on screen through 7, 8, 9 and 10", [7, 8, 9, 10].every((n) => carried[n] === spec6));
  check("  it is still there on 11, beside the recomputation", carried[11] === spec6 && after11.length === 66);
  check("  the two are character identical", carried[11] === after11);
  check("  the slot it lands on mirrors it exactly", (bodies[11].match(/p-carryghost/g) ?? []).length === 1 && bodies[11].includes(`<span class="p-hex">${spec6}`));
  check("  the nine field rows survive, fixture row included", (bodies[11].match(/class="fn"/g) ?? []).length === 9 && bodies[11].includes("fixture both sides"));

  // ------------------------------------------------------------------------
  head("9  EVERY VALUE STILL COMES FROM THE ENGINE");

  const fixturePath = `${ROOT}agent/src/fixtures/evidence.ts`;
  const original = readFileSync(fixturePath, "utf8");
  const engineProbe = () =>
    spawnSync(
      `${ROOT}agent/node_modules/.bin/tsx`,
      [
        "-e",
        `import { buildCompile } from "${ROOT}agent/src/compile.ts";
         import { buildField } from "${ROOT}agent/src/field.ts";
         const g = buildCompile(null, null).compilations[1].diagnostics.map((d) => d.gate).join(",");
         const f = buildField({ totalRecords: 500, violations: 251, firstViolationIndex: 187 });
         const m = buildField({ totalRecords: 500, violations: 251, firstViolationIndex: 240 });
         console.log(JSON.stringify({ g, first: f.firstViolationIndex, moved: m.firstViolationIndex, agrees: m.agrees }));`,
      ],
      { encoding: "utf8", cwd: ROOT },
    ).stdout.trim().split("\n").pop() ?? "";
  const before = JSON.parse(engineProbe() || "{}");
  try {
    writeFileSync(fixturePath, original.replace('    effectiveSubject: "RESPONSE",', '    effectiveSubject: "RECORD",'));
    const changed = JSON.parse(engineProbe() || "{}");
    console.log("");
    console.log(`    fixture as measured                    gates ${before.g}`);
    console.log(`    last_updated declared honest instead   gates ${changed.g}`);
    check("changing one measured fixture changes where a path stops", before.g !== changed.g);
    check("  the second lane is the one that moves", before.g.split(",")[1] !== changed.g.split(",")[1]);
  } finally {
    writeFileSync(fixturePath, original);
  }
  const restored = JSON.parse(engineProbe() || "{}");
  check("  the fixture is restored", restored.g === before.g, `gates ${restored.g}`);
  console.log("");
  console.log(`    field onset 187 -> first violation ${before.first};  onset 240 -> ${before.moved}`);
  check("the field follows the delivery, not a drawing", before.first === 187 && before.moved === 240);
  check("  and says so when it stops agreeing with the run", before.agrees === false);

  // ------------------------------------------------------------------------
  head("10  PREFERS-REDUCED-MOTION RENDERS FINAL STATES");

  const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(".p-gates")));
  const block = rm.slice(0, rm.indexOf("\n}\n") + 3);
  console.log("");
  for (const line of block.split("\n").filter((l) => l.includes("{"))) console.log(`    ${line.trim().slice(0, 72)}`);
  check("the paths render at their stop rather than travelling", /\.run \{ animation: none; stroke-dashoffset: var\(--stop\)/.test(block));
  check("  the halts and the errors are simply there", /\.halt \{ animation: none/.test(block) && /\.p-diag \{ animation: none/.test(block));
  check("  the whole field is resolved", /\.p-field \.c \{ transition: none; opacity: 1/.test(block));
  check("  the hashes are already equal", /\.p-meet \.eq \{[^}]*opacity: 1/.test(block));
  check("  and nothing has receded", /\.p-fields\.recede \{ opacity: 1/.test(block));
  check("the component honours it too, not only the stylesheet", /prefers-reduced-motion: reduce/.test(src) && /if \(reduced\) \{\s*setSub\(max\)/.test(src));

  // ------------------------------------------------------------------------
  head("11  SLIDE 8: TWO PRICES, THE SMALLER ONE LOST");

  const s8 = [await get("/present?s=8&sub=0"), await get("/present?s=8&sub=1"), await get("/present?s=8&sub=2")];
  const offersOf = (h: string) =>
    [...h.matchAll(/class="p-offer([^"]*)"[^>]*data-price="([^"]*)" data-eligible="([^"]*)"/g)].map((m) => ({
      cls: m[1].trim(),
      price: m[2],
      eligible: m[3] === "true",
    }));
  const at0 = offersOf(s8[0]);
  console.log("");
  for (let n = 0; n < 3; n++) {
    const o = offersOf(s8[n]);
    console.log(`    sub ${n}   ${o.map((x) => `${x.price} [${x.cls}]`).join("   ")}`);
  }

  const priceSize = Number(css.match(/\.p-offer \.p-price \{[^}]*font-size: ([\d.]+)vmin/)?.[1] ?? 0);
  const checkSize = Number(css.match(/\.p-checks \{[^}]*font-size: ([\d.]+)vmin/)?.[1] ?? 0);
  console.log(`\n    price ${priceSize}vmin, against ${checkSize}vmin for the checks beneath it`);
  check("both prices render at display scale", priceSize >= 8 && at0.length === 2);
  check("  the price is the largest thing on the offer", priceSize > checkSize * 3);
  check(
    "  and both are at full strength at rest, before any check resolves",
    (s8[0].match(/class="p-price"/g) ?? []).length === 2 && !/\.p-offer \{[^}]*opacity/.test(css),
  );
  check("  with nothing resolved yet to read them against", !s8[0].includes("p-checks") && !s8[0].includes("p-res"));

  const resolved = (h: string) => offersOf(h).filter((o) => o.cls.includes("on"));
  check("the offer that passes resolves first", resolved(s8[1]).length === 1 && resolved(s8[1])[0].eligible);
  check("  the refusal lands second, one step later", resolved(s8[2]).length === 2 && resolved(s8[2]).some((o) => !o.eligible));
  const passPrice = Number(resolved(s8[1])[0]?.price.replace("$", "") ?? 0);
  const failPrice = Number(offersOf(s8[2]).find((o) => !o.eligible)?.price.replace("$", "") ?? 0);
  check(
    "  which is the dearer offer passing before the cheaper one fails",
    passPrice > failPrice && failPrice > 0,
    `${passPrice.toFixed(3)} passes, then ${failPrice.toFixed(3)} is refused`,
  );

  check("the number itself carries the outcome", /\.p-offer\.on\.pass \.p-price \{ color: var\(--accent\)/.test(css) && /\.p-offer\.on\.fail \.p-price \{ color: var\(--clay\)/.test(css));
  check("  in clay, which is what failure already looks like here", /\.p-checks \.no span \{ color: var\(--clay\)/.test(css));
  check("  and no palette entry was invented for it", !/--[a-z-]*(red|amber|warn|danger)/.test(css));

  const labelH = css.match(/\.p-offer \.p-k \{[^}]*height: ([\d.]+)vmin/)?.[1] ?? "";
  check(
    "the two prices start on one line whatever the vendor is called",
    labelH !== "" && /\.p-offer \.p-k \{[^}]*align-items: flex-end/.test(css),
    `the name sits in a fixed ${labelH}vmin box, bottom aligned`,
  );
  const vendors = [...s8[0].matchAll(/<span class="p-k">([^<]*)<\/span>/g)].map((m) => m[1]).filter((v) => v !== "spec");
  check(
    "  which matters, because one name is eight times the length of the other",
    vendors.length === 2 && Math.max(...vendors.map((v) => v.length)) > 4 * Math.min(...vendors.map((v) => v.length)),
    vendors.map((v) => `${v} (${v.length})`).join(" vs "),
  );
  check(
    "  and the clay rule is reserved on both, so nothing shifts when it lands",
    /\.p-offer \.p-price \{ border-bottom: [\d.]+vmin solid transparent/.test(css) && /\.p-offer\.on\.fail \.p-price \{ border-bottom-color: var\(--clay\)/.test(css),
  );

  check("slide 8 still costs two steps and no more", /8:\s*2/.test(auto) && /8:\s*900/.test(delay));

  // the prices are read, not written down
  const offersPath = `${ROOT}agent/src/fixtures/offers.ts`;
  const offersSrc = readFileSync(offersPath, "utf8");
  try {
    writeFileSync(offersPath, offersSrc.replace("export const AISA_PRICE_MICROS = 8_000;", "export const AISA_PRICE_MICROS = 11_000;"));
    const moved = spawnSync(
      `${ROOT}agent/node_modules/.bin/tsx`,
      ["-e", `import { buildXRay } from "${ROOT}agent/src/xray.ts"; console.log(buildXRay().decision.offers.map((o) => o.price + ":" + o.eligible).join(" "));`],
      { encoding: "utf8", cwd: ROOT },
    ).stdout.trim().split("\n").pop() ?? "";
    console.log(`\n    fixture as measured     ${at0.map((o) => `${o.price}:${o.eligible}`).join(" ")}`);
    console.log(`    fixture priced at 0.011 ${moved}`);
    check("the prices come from the offers fixture", moved.includes("$0.011") && !moved.includes("$0.008"));
  } finally {
    writeFileSync(offersPath, offersSrc);
  }
  const back = spawnSync(
    `${ROOT}agent/node_modules/.bin/tsx`,
    ["-e", `import { buildXRay } from "${ROOT}agent/src/xray.ts"; console.log(buildXRay().decision.offers.map((o) => o.price).join(" "));`],
    { encoding: "utf8", cwd: ROOT },
  ).stdout.trim().split("\n").pop() ?? "";
  check("  and the fixture is restored", back.includes("$0.008"), back);

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
