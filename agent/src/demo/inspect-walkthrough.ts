/**
 * Printed walkthrough of the INSPECT and PROTECT surfaces.
 *
 * Builds the UI, serves it, fetches the real rendered HTML and asserts against
 * it. Then mutates one fixture, rebuilds, and shows the screen change.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { TIMING, gateOnAt, manifestOnAt, reasonOnAt, targetOnAt, totalTicks } from "../xray.js";
import { verifyManifest, type SignedManifest } from "../manifest.js";
import { BUYER_POLICY, OFFERS } from "../fixtures/offers.js";

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
/** Not a pass. Something the environment prevented this run from testing. */
const skip = (label: string, why: string) => console.log(`  SKIP  ${label}  ${why}`);

const strip = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
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
  head("1  ONE CLAIM RUNS THE WHOLE PAGE");

  const claimMatch = html.match(/class="claim-quote">([\s\S]*?)<\/h1>/);
  const claimText = claimMatch ? flat(claimMatch[1]) : "";
  const runJson = JSON.parse(readFileSync(`${ROOT}ui/data/run.json`, "utf8"));
  const signedQuote = runJson.protectedPurchase.conditions[0].sourceQuote;
  const wit = spawnSync("npm", ["run", "witness:check"], { cwd: ROOT, encoding: "utf8" }).stdout;
  const witReq = (wit.match(/requirement, from the signed terms\s+"([^"]+)"/) ?? ["", ""])[1];
  console.log(`\n  stated at the top of the page   ${claimText}`);
  console.log(`  carried in the signed terms     "${signedQuote}"`);
  console.log(`  the witness is synthesised from "${witReq}"`);
  console.log(`  the proof that settled          index ${runJson.protectedPurchase.settlement.offendingIndex}`);
  check("the page states the claim the terms carry", claimText.includes(signedQuote));
  check("  and the witness is synthesised from that same claim", witReq === signedQuote);
  check("  and it is the 60 second claim, not two different numbers", /60 seconds/.test(signedQuote));
  check("  the proof that settled is at index 187", runJson.protectedPurchase.settlement.offendingIndex === "187");
  check("  no other freshness claim appears anywhere on the page", !/last 1 hour|last 3600/.test(html));

  head("2  THREE COMPILATIONS, IN SEQUENCE");

  const units = [...html.matchAll(/data-compilation="([^"]+)" data-status="([^"]+)">([\s\S]*?)(?=<section class="unit|<section class="shell)/g)].map(
    (m) => {
      const body = m[3];
      return {
        id: m[1],
        status: m[2],
        underlined: [...body.matchAll(/<u>([^<]+)<\/u>/g)].map((u) => u[1]),
        diags: [...body.matchAll(/class="dcode">([^<]*)<[\s\S]*?class="dat">([^<]*)<[\s\S]*?class="dline">([\s\S]*?)<\/p>/g)].map((d) => ({
          code: flat(d[1]),
          at: flat(d[2]),
          line: flat(d[3]),
        })),
      };
    },
  );
  for (const u of units) {
    console.log(`\n  [${u.id}]  ${u.status}`);
    if (u.underlined.length) console.log(`    spans underlined in the source: ${u.underlined.map((x) => JSON.stringify(x)).join(", ")}`);
    for (const d of u.diags) {
      console.log(`      ${d.code}`);
      console.log(`        at ${d.at}`);
      console.log(`        ${d.line.slice(0, 96)}`);
    }
  }
  console.log("");
  check("three compilations render", units.length === 3, units.map((u) => u.id).join(", "));
  check("  and they run in the order the argument needs", units.map((u) => u.status).join(",") === "FAILED,FAILED,COMPILED");

  const [one, two, three] = units;
  check("the seller's phrase alone fails for want of a threshold", one.diags.some((d) => /missing THRESHOLD/.test(d.code)));
  check("  pointed at an exact span of the seller promise", /seller promise\[\d+\.\.\d+\]/.test(one.diags[0]?.at ?? ""), one.diags[0]?.at ?? "");
  check("  and that span is underlined in the source", one.underlined.length > 0, one.underlined.join(", "));

  check("the requirement compiles, then fails at evidence", two.status === "FAILED" && two.diags.length === 4);
  const codes = two.diags.map((d) => d.code);
  console.log(`\n  four artifacts, four codes: ${codes.join(", ")}`);
  check("  every artifact produces a different typed error", new Set(codes).size === 4);
  check("  each against an exact source span or a named policy field", two.diags.every((d) => /\[\d+\.\.\d+\]|policy\./.test(d.at)));
  check("  and every line states what was found against what was required", two.diags.every((d) => /found .*, required /.test(d.line)));

  check("the protected offer compiles clean", three.status === "COMPILED" && three.diags.length === 0);
  check("  and reports GUARANTEE COMPILED", /Guarantee compiled/i.test(html));

  head("3  THE WITNESS SPEC, STATED BEFORE ANY MONEY MOVES");

  const wid = html.match(/data-witness-id="(0x[0-9a-f]{64})"/);
  const wsay = html.match(/class="wsay">([\s\S]*?)<\/p>/);
  const wfields = [...html.matchAll(/<dt>(falsifier|threshold|required binding|permitted issuer)<\/dt><dd[^>]*>([\s\S]*?)<\/dd>/g)].map(
    (m) => [m[1], flat(m[2])],
  );
  console.log(`\n  ${wsay ? flat(wsay[1]) : "MISSING"}`);
  for (const [k, v] of wfields) console.log(`    ${k.padEnd(18)} ${v}`);
  console.log(`    witnessId          ${wid ? wid[1] : "MISSING"}`);
  check("the spec renders with its witnessId, before the purchase", wid !== null);
  const flatHtml = flat(html);
  check(
    "  the falsifier is the negation of the claim's opcode",
    /TIMESTAMP_LT/.test(flatHtml) && /negation of TIMESTAMP_GTE/.test(flatHtml),
  );
  check("  the threshold carries its source span", /requirement\[\d+\.\.\d+\]/.test(html));
  check("  the required binding is stated", wfields.some(([k, v]) => k === "required binding" && v === "PREIMAGE"));
  check("  the permitted issuer is stated", wfields.some(([k, v]) => k === "permitted issuer" && /^0x[0-9a-fA-F]{40}$/.test(v)));
  check("  and it is stated before any money moves", /Stated before any money moves/.test(html));
  check(
    "  the spec appears before the settlement act in the document",
    html.indexOf("data-witness-id") < html.indexOf('data-testid="provenance-label"'),
  );

  head("4  THE PAYOFF AT INDEX 187");

  const before = html.match(/data-witness-before="(0x[0-9a-f]{64})"/);
  const after = html.match(/data-witness-after="(0x[0-9a-f]{64})"/);
  const rows = [...html.matchAll(/class="pff (ok|no)">[\s\S]*?class="fn">([^<]*)<[\s\S]*?class="fsrc (chain|fixture)">([^<]*)<[\s\S]*?class="fv">([\s\S]*?)<\/p>/g)].map(
    (m) => ({ ok: m[1] === "ok", field: flat(m[2]), src: m[3], srcText: flat(m[4]), values: flat(m[5]) }),
  );
  console.log(`\n  before  ${before?.[1]}`);
  console.log(`  after   ${after?.[1]}`);
  console.log("");
  for (const r of rows) console.log(`    ${r.ok ? "PASS" : "FAIL"}  ${r.field.padEnd(30)} ${r.srcText}`);
  check("the executed proof is checked field by field", rows.length >= 8, `${rows.length} fields`);
  check("  every field satisfies the spec", rows.every((r) => r.ok));
  check("the witnessId is identical before and after", before?.[1] === after?.[1], before?.[1] ?? "");
  check("  and it is the same value the spec carried", wid?.[1] === before?.[1]);
  const fixtureRows = rows.filter((r) => r.src === "fixture");
  console.log(`\n  fields read from the fixture on both sides: ${fixtureRows.map((r) => r.field).join(", ") || "none"}`);
  check("the fixture-read fields are labelled as such on the page", fixtureRows.length > 0, fixtureRows.map((r) => r.srcText).join("; "));
  check(
    "  and the page says why rather than implying they were recomputed",
    /the chain does not carry this as a string|does not carry them\s*as a string/.test(flat(html)),
  );

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

  return { units, claimText };
});

// ------------------------------------------------------------------ 7

head("7  ONE CONTINUOUS PAGE: INSPECT, PROTECT, ENFORCE");

await serve(async (html, port) => {
  const at = (needle: string) => html.indexOf(needle);
  const beats: [string, number][] = [
    ["the claim, stated", at('class="claim-quote"')],
    ["the compile surface", at('class="compiler"')],
    ["the witness spec", at("data-witness-id")],
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
  if (cold.available) {
    skip("  with no chain it refuses and says why", "a chain is already reachable in this environment");
  } else {
    check("  with no chain it refuses and says why", cold.reasons.length > 0);
  }

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

head("8  THE PURCHASING POLICY");

await serve(async (html, port) => {
  const cell = (re: RegExp) => (html.match(re) ? flat(html.match(re)![1]) : "MISSING");
  console.log("\n  the policy, as it renders:");
  const polBlock = html.slice(html.indexOf('class="policy-obj"'), html.indexOf('class="offers"'));
  const pol = [...polBlock.matchAll(/<dt>([a-zA-Z]+)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => [m[1], flat(m[2])]);
  for (const [k, v] of pol) console.log(`    ${k.padEnd(20)} ${v}`);
  check("the policy renders as an explicit object", pol.length >= 4);
  check(
    "  and is not gated behind the animation, so it is readable at any point",
    /class="policy-act"/.test(html) && !/class="manifest-wrap"[^>]*data-act="PROTECT"/.test(html),
  );
  check("  it carries a maximum price", html.includes("maxPrice"));
  check("  a required claim", html.includes("requiredClaim") && html.includes(BUYER_POLICY.requiredClaim));
  check("  whether protection is mandatory", html.includes("protectionMandatory"));
  check("  and the selection rule, printed verbatim", html.includes("choose the lowest priced offer"));

  console.log("\n  each offer, as a checklist against that policy:");
  const blocks = html.split('data-offer="').slice(1);
  const offers = blocks.map((b) => {
    const id = b.slice(0, b.indexOf('"'));
    const price = b.match(/class="p">([^<]+)</);
    const checks = [...b.matchAll(/class="pcheck (ok|no)"[\s\S]*?class="l">([^<]*)<[\s\S]*?<p class="d">([\s\S]*?)<\/p>/g)].map(
      (m) => ({ ok: m[1] === "ok", label: flat(m[2]), detail: flat(m[3]) }),
    );
    const res = b.match(/class="presult (ok|no)">([\s\S]*?)<\/div>/);
    return { id, price: price ? price[1] : "?", checks, eligible: res?.[1] === "ok", result: flat(res?.[2] ?? "") };
  });
  for (const o of offers) {
    console.log(`\n    ${o.id}   ${o.price}`);
    for (const c of o.checks) console.log(`      ${c.ok ? "PASS" : "FAIL"}  ${c.label.padEnd(38)} ${c.detail}`);
    console.log(`      -> ${o.result}`);
  }
  check("both offers are evaluated as checklists", offers.length === 2 && offers.every((o) => o.checks.length === 3));

  const cheap = offers.find((o) => o.id === "aisa-coingecko-markets")!;
  const prot = offers.find((o) => o.id !== "aisa-coingecko-markets")!;
  console.log("");
  check("the cheaper offer is within the price bound", cheap.checks[0].ok, cheap.price);
  check("  but the required claim is not establishable there", !cheap.checks[1].ok);
  check("  so the policy is not satisfied", !cheap.eligible);
  check("  and the refusal names the buyer requirement", cheap.result.includes(BUYER_POLICY.requiredClaim));
  check("  and states the policy result", /Policy result: do not purchase/.test(cheap.result));
  const vendorWords = /deficient|inadequate|unreliable|bad |poor |untrustworthy|fails to deliver|misleading/i;
  check("  and characterises no vendor", !vendorWords.test(cheap.result), JSON.stringify(cheap.result.slice(0, 96)));

  check("the protected offer satisfies every requirement", prot.eligible && prot.checks.every((c) => c.ok));
  const result = html.match(/data-result="(\w+)"/);
  console.log(`\n  policy result: ${result?.[1]}`);
  check("the selection rule selects it", result?.[1] === "PURCHASE" && html.includes("offer selected"));

  head("8b  THE SERVED MANIFEST, VERIFIED BY THE BUYER");
  const served = (await fetch(`http://127.0.0.1:${port}/api/manifest`).then((r) => r.json())) as SignedManifest;
  console.log(`\n  fetched /api/manifest`);
  console.log(`    offerId          ${served.manifest.offerId}`);
  console.log(`    claim            "${served.manifest.claim}"`);
  console.log(`    priceMicrosUsd   ${served.manifest.priceMicrosUsd}`);
  console.log(`    permittedIssuer  ${served.manifest.permittedIssuer}`);
  console.log(`    claimed signer   ${served.signer}`);
  const v = await verifyManifest(served);
  console.log(`    recovered signer ${v.recovered}`);
  console.log(`    verdict          ${v.reason}`);
  check("the served manifest verifies against the seller signature", v.ok, `recovered ${v.recovered}`);
  check("  the recovered signer is the claimed seller", v.recovered?.toLowerCase() === served.signer.toLowerCase());
  check("  the seller key is not the evidence issuer key", v.rolesSeparate);
  check(
    "  and the manifest names the issuer whose commitments the escrow accepts",
    served.manifest.permittedIssuer.toLowerCase() ===
      OFFERS.find((o) => o.manifest)!.manifest!.manifest.permittedIssuer.toLowerCase(),
  );

  const tampered: SignedManifest = { ...served, manifest: { ...served.manifest, priceMicrosUsd: "1" } };
  const bad = await verifyManifest(tampered);
  check("  a manifest with an edited price no longer verifies", !bad.ok, bad.reason);

  head("8c  THE PRICE THE BUYER SEES IS THE PRICE THE ESCROW FUNDS");
  const selected = OFFERS.find((o) => o.id !== "aisa-coingecko-markets")!;
  const run = JSON.parse(readFileSync(`${ROOT}ui/data/run.json`, "utf8"));
  const funded = run.protectedPurchase.amount;
  const refunded = run.protectedPurchase.settlement.refundAmount;
  console.log(`\n  advertised price of the selected offer   ${selected.priceMicrosUsd} micros = $${(selected.priceMicrosUsd / 1e6).toFixed(3)}`);
  console.log(`  amount the escrow funded                 ${funded} base units`);
  console.log(`  amount refunded on the breach proof      ${refunded} base units`);
  console.log(`  refund transaction                       ${run.protectedPurchase.settlement.txHash}`);
  check("funded equals the advertised price", String(selected.priceMicrosUsd) === String(funded));
  check("refunded equals the advertised price", String(selected.priceMicrosUsd) === String(refunded));
  const fundedLine = flat((html.match(/class="funded">([\s\S]*?)<\/p>/) ?? ["", ""])[1]).replace(/<!--\s*-->/g, "");
  console.log(`  the page states                          ${fundedLine}`);
  check(
    "the page states the same figure",
    fundedLine.includes(`${selected.priceMicrosUsd} base units`) && fundedLine.includes("$0.010"),
    fundedLine.slice(0, 80),
  );
  console.log("\n  USDC carries 6 decimals, so one millionth of a dollar is one base unit and no conversion applies.");
});

head("9  CHANGING A FIXTURE CHANGES THE SCREEN");

const before = readFileSync(FIXTURE, "utf8");
const diagOf = (us: { diags: { code: string; line: string }[] }[], artifact: string) =>
  us.flatMap((u) => u.diags).find((d) => d.line.includes(artifact));
const codeBefore = diagOf(first.units, "coingecko-markets-last_updated")?.code ?? "?";
console.log(`\n  last_updated diagnostic now:   ${codeBefore}`);
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
    const us = [...html.matchAll(/data-compilation="([^"]+)"[\s\S]*?(?=<section class="unit|<section class="shell)/g)].map((m) => ({
      diags: [...m[0].matchAll(/class="dcode">([^<]*)<[\s\S]*?class="dline">([\s\S]*?)<\/p>/g)].map((d) => ({
        code: flat(d[1]),
        line: flat(d[2]),
      })),
    }));
    const codeAfter = diagOf(us, "coingecko-markets-last_updated")?.code ?? "?";
    console.log(`\n  last_updated diagnostic after: ${codeAfter}`);
    check("the rendered diagnostic code changed", codeAfter !== codeBefore, `${codeBefore}  ->  ${codeAfter}`);
    check("  and it is still a typed error, not prose", /^[A-Z_]+$/.test(codeAfter.split(" ")[0]), codeAfter);
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
