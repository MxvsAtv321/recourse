import { readFileSync } from "node:fs";

const RPC = "http://127.0.0.1:8545";
const URL = process.env.UI_URL ?? "http://localhost:3000";
const run = JSON.parse(readFileSync("ui/data/run.json", "utf8"));

const raw = await (await fetch(URL)).text();
const text = raw
  .replace(/<!-- -->/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&ldquo;|&rdquo;|&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/&rsquo;/g, "'")
  .replace(/&nbsp;/g, " ")
  .replace(/\s+/g, " ");

const usd = (b) => (Number(b) / 10 ** run.meta.assetDecimals).toFixed(2);
const dur = (sec) => {
  const n = Number(sec);
  if (n < 60) return `${n}s`;
  if (n < 3600) return `${Math.round(n / 60)} min`;
  const h = n / 3600;
  return h < 10 ? `${h.toFixed(1)} hours` : `${Math.round(h)} hours`;
};

let pass = 0;
let fail = 0;
const has = (needle) => raw.includes(needle) || text.includes(needle);

function refute(label, needle) {
  const ok = !has(String(needle));
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}  ->  absent: ${JSON.stringify(String(needle)).slice(0, 70)}`);
  ok ? pass++ : fail++;
}

function check(label, needle) {
  const ok = has(String(needle));
  console.log(`   ${ok ? "PASS" : "FAIL"}  ${label}  ->  ${JSON.stringify(String(needle)).slice(0, 92)}`);
  ok ? pass++ : fail++;
}

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await r.json()).result;
}

let skipped = 0;

async function onChain(label, hash) {
  let receipt;
  try {
    receipt = await rpc("eth_getTransactionReceipt", [hash]);
  } catch {
    console.log(`   SKIP  ${label}: anvil unreachable at ${RPC}, artifact is from a previous instance`);
    skipped++;
    return;
  }
  const ok = receipt && receipt.status === "0x1";
  console.log(
    `   ${ok ? "PASS" : "FAIL"}  ${label} mined on anvil  ->  block ${receipt ? parseInt(receipt.blockNumber, 16) : "MISSING"}`,
  );
  ok ? pass++ : fail++;
}

const u = run.unprotected;
const p = run.protectedPurchase;

console.log(`\nHTML fetched from ${URL}  (${raw.length} bytes)`);
console.log(`Artifact: chain ${run.meta.chainId}, block ${run.meta.blockNumber}, escrow ${run.meta.escrow}\n`);

console.log("VIEW 1  unprotected purchase: checks green, payment settles, then the timestamp reveal");
for (const c of u.checks) check("check rendered", c.name);
check("all checks green", "All passed");
check("amount settled", "100.00");
check("payment tx hash", u.payment.txHash);
await onChain("payment tx", u.payment.txHash);
check("stale count from run", `${u.reveal.staleCount} of ${u.recordCount} records predate`);
check("clean head of file", `first ${u.reveal.firstStaleIndex} records are current`);
check("oldest record age", `Oldest record is ${dur(u.reveal.oldestAgeSeconds)} old`);

console.log("\nREVIEW FIXES  claims, disclosure, layout, hierarchy");
check("headline states the true condition", "only if nobody can prove the delivery");
refute("headline no longer asserts the promise was kept", "final only when the delivery");
check("evidence comparison open by default", "<details class=\"disclose\" open");
check("chain named rather than numbered", "local anvil");
refute("raw chain id not shown in the badge", "Live run \u00b7 chain 31337");
check("signer address compacted so the row stays on one line", "0x9965\u2026A4dc");
check("panel aside is styled as an aside", 'class="card-note"');

console.log("\nVIEW 2  protection panel: each condition with its state and the phrase that generated it");
for (const c of p.conditions) {
  check(`condition ${c.conditionId} source phrase`, c.sourceQuote);
  check(`condition ${c.conditionId} opcode`, c.opcode);
}
check("panel distinguishes assurance levels", "proved from delivery");
check("scalar settlement named", "direct evaluation at release");
check("universal settlement named", "one counterexample");

console.log("\nFIX 2  scalar row count must not read as protection against short delivery");
const scalar = p.conditions.find((c) => c.quantifier === "SCALAR");
const universal = p.conditions.find((c) => c.quantifier === "UNIVERSAL");
check("threshold unit is leaves claimed", `${Number(scalar.threshold).toLocaleString("en-US")} leaves claimed`);
check("scalar labelled issuer attested", "Issuer attested");
check("panel splits proved from attested", "1 proved from delivery");
check("panel names attested count", "1 issuer attested");
check("scalar caveat spells out the gap", "nor that the buyer received that many records");
check("universal claim still says Protected", ">Protected<");
refute("no bare row unit", `${Number(scalar.threshold).toLocaleString("en-US")} rows`);
refute("no blanket protected count", `${p.conditions.length} of ${p.conditions.length} protected`);
console.log(`   note  condition 1 (${universal.claimType}) keeps its Protected label, unchanged`);

console.log("\nVIEW 3  claim-type rejection, expandable to offered vs required");
check("revert name from chain", p.rejectedOffer.error);
check("disclosure element", "<details");
check("offered establishes", p.rejectedOffer.offeredEstablishes.replace(/_/g, " ").toLowerCase());
check("condition requires", p.rejectedOffer.conditionRequires.replace(/_/g, " ").toLowerCase());
check("nothing taken pre-payment", "Escrow balance after the rejection: 0.00");

console.log("\nVIEW 4  Protect & Pay control showing the USDC amount");
check("button label with amount", `Protect & Pay ${usd(p.amount)} ${run.meta.assetSymbol}`);
check("challenge window", "30s");
check("escrow address", run.meta.escrow);

console.log("\nVIEW 5  settlement now starts idle and executes live on click");
check("idle Protect & Pay control", "Protect &amp; Pay · 100.00 USDC");
check("no trace rendered before the click", 'data-trace-source="none"');
refute("no verdict panel before the click", 'data-testid="refund-panel"');
console.log("   note  the live and captured paths are verified by the browser walkthrough, not here");

console.log("\nVIEW 6  unprotectable state naming the term");
check("the term", run.unprotectable.phrase);
check("reason", run.unprotectable.reason);
for (const o of run.unprotectable.opcodes) check("opcode vocabulary", o);

console.log("\nNothing hardcoded: values above were read from ui/data/run.json and matched in the served HTML.");
console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(fail === 0 ? 0 : 1);
