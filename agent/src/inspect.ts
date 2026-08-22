/**
 * INSPECT and PROTECT.
 *
 * A classifier may say which semantic dimension a phrase belongs to. It may not
 * say what the value is. Every literal that reaches a Claim is derived by
 * slicing an exact span of the source text, so a value that does not appear in
 * the buyer requirement, the seller offer, or a named policy field cannot exist
 * in the output. When a dimension has no span, the claim abstains and the
 * missing dimension is named. Nothing is proposed for it.
 *
 * See CLAUDE.md invariants 9 and 10, and spec/EVIDENCE.md section 7.
 */
import {
  fromPolicy,
  fromSpan,
  inspect,
  verifySourced,
  type Artifact,
  type Claim,
  type Finding,
  type Frame,
  type Lane,
  type MatchContext,
  type Property,
  type Sourced,
  type Span,
  type Subject,
} from "./evidence.js";

export type Dimension = "SUBJECT" | "PROPERTY" | "THRESHOLD" | "FRAME" | "ISSUER" | "SOURCE";

export type Missing = {
  dimension: Dimension;
  why: string;
  /** Where in the source the failure points, when the source contains it. */
  span?: Span;
  source?: "REQUIREMENT" | "OFFER";
};

/**
 * What a classifier is allowed to emit. Labels and character spans, never
 * literals. A model can implement this; the extractor below is what makes doing
 * so safe, because it re-derives every value from the span.
 */
export type Classification = {
  ruleId: string;
  subject?: Subject;
  property?: Property;
  op?: "AT_OR_AFTER" | "GTE" | "EQ";
  frameKind?: "AGREEMENT_TIME" | "CHAIN_TIME" | "ARTIFACT_FIELD";
  spans: {
    quantifier?: Span;
    /** The phrase naming what the claim is about. */
    subject?: Span;
    /** The phrase naming the observable. */
    property?: Span;
    amount?: Span;
    unit?: Span;
    frameField?: Span;
  };
  /** Dimensions this classifier could not locate in the text. */
  unlocated?: Missing[];
};

export type Classifier = (requirement: string) => Classification[];

// ------------------------------------------------------------------ the default classifier
//
// Deterministic, offline, and it never returns a value. Every span below comes
// from a real RegExp match index.

const UNIT_SECONDS: Record<string, number> = { second: 1, minute: 60, hour: 3600 };

const groupSpan = (m: RegExpExecArray, group: number): Span | undefined => {
  const g = m[group];
  if (g === undefined) return undefined;
  // Locate the group inside the match, then offset by the match start.
  const rel = m[0].indexOf(g);
  if (rel < 0) return undefined;
  return [m.index + rel, m.index + rel + g.length] as Span;
};

const RULES: { id: string; re: RegExp; build: (m: RegExpExecArray) => Classification }[] = [
  {
    // Grouped so a diagnostic can point at the exact phrase that names each
    // dimension, rather than at the whole sentence.
    id: "record-freshness",
    re: /(every record)\s+(?:is\s+)?(generated)\s+within the last\s+(\d+)\s+(second|minute|hour)s?/i,
    build: (m) => ({
      ruleId: "record-freshness",
      subject: "RECORD",
      property: "GENERATION_TIME",
      op: "AT_OR_AFTER",
      frameKind: "AGREEMENT_TIME",
      spans: {
        quantifier: groupSpan(m, 0),
        subject: groupSpan(m, 1),
        property: groupSpan(m, 2),
        amount: groupSpan(m, 3),
        unit: groupSpan(m, 4),
      },
    }),
  },
  {
    // A vendor phrase that names freshness and carries no comparable value.
    // It locates the word so the failure has somewhere exact to point.
    id: "freshness-named-without-threshold",
    re: /\b(real[\s-]?time|live data|up[\s-]to[\s-]date|always current)\b/i,
    build: (m) => ({
      ruleId: "freshness-named-without-threshold",
      subject: "RECORD",
      property: "GENERATION_TIME",
      op: "AT_OR_AFTER",
      frameKind: "AGREEMENT_TIME",
      spans: { property: groupSpan(m, 1) },
      unlocated: [
        {
          dimension: "THRESHOLD",
          why: "the phrase names freshness but carries no comparable value, so it compiles to no executable proposition",
          span: groupSpan(m, 1),
          source: "REQUIREMENT",
        },
      ],
    }),
  },
  {
    id: "response-freshness",
    re: /the delivered file's records were generated within the last (\d+) (second|minute|hour)s?/i,
    build: (m) => ({
      ruleId: "response-freshness",
      subject: "RESPONSE",
      property: "GENERATION_TIME",
      op: "AT_OR_AFTER",
      frameKind: "AGREEMENT_TIME",
      spans: { amount: groupSpan(m, 1), unit: groupSpan(m, 2) },
    }),
  },
  {
    id: "freshness-against-delivery-clock",
    re: /every record (?:is )?generated within (\d+) (second|minute|hour)s? of ([a-z_][a-z0-9_]*)/i,
    build: (m) => ({
      ruleId: "freshness-against-delivery-clock",
      subject: "RECORD",
      property: "GENERATION_TIME",
      op: "AT_OR_AFTER",
      frameKind: "ARTIFACT_FIELD",
      spans: { amount: groupSpan(m, 1), unit: groupSpan(m, 2), frameField: groupSpan(m, 3) },
    }),
  },
  {
    id: "row-count-at-least",
    re: /at least (\d+) (?:rows|records)/i,
    build: (m) => ({
      ruleId: "row-count-at-least",
      subject: "RESPONSE",
      property: "CARDINALITY",
      op: "GTE",
      spans: { amount: groupSpan(m, 1) },
    }),
  },
  {
    id: "row-count-exactly",
    re: /exactly (\d+) (?:rows|records)/i,
    build: (m) => ({
      ruleId: "row-count-exactly",
      subject: "RESPONSE",
      property: "CARDINALITY",
      op: "EQ",
      spans: { amount: groupSpan(m, 1) },
    }),
  },
  {
    // Recognises the dimension without a numeral. This is the abstention path:
    // subject and property are located, the threshold is not, and none is invented.
    id: "record-freshness-no-threshold",
    re: /every record (?:is |must be )?(?:generated within the last (?!\d)|recent|fresh|up to date)/i,
    build: () => ({
      ruleId: "record-freshness-no-threshold",
      subject: "RECORD",
      property: "GENERATION_TIME",
      op: "AT_OR_AFTER",
      frameKind: "AGREEMENT_TIME",
      spans: {},
      unlocated: [
        { dimension: "THRESHOLD", why: "no numeral appears in the requirement, so no value can be sourced" },
      ],
    }),
  },
];

export const defaultClassifier: Classifier = (requirement) => {
  const out: Classification[] = [];
  for (const rule of RULES) {
    const m = new RegExp(rule.re.source, rule.re.flags.replace("g", "")).exec(requirement);
    if (m) out.push(rule.build(m));
  }
  // A complete classification beats a partial one for the same dimension pair.
  const complete = out.filter((c) => c.spans.amount !== undefined);
  return complete.length > 0 ? complete : out;
};

// ------------------------------------------------------------------ extraction

const parseUint = (s: string): number | null => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
const parseUnit = (s: string): number | null => UNIT_SECONDS[s.trim().toLowerCase().replace(/s$/, "")] ?? null;
const parseField = (s: string): string | null => (/^[a-z_][a-z0-9_]*$/i.test(s.trim()) ? s.trim() : null);
const parseAddressLike = (r: unknown): string | null => (typeof r === "string" && r.length > 0 ? r : null);

export type Extracted = {
  ruleId: string;
  claim: Claim;
  threshold: Sourced<number>;
  issuer: Sourced<string>;
  sourceId: Sourced<string>;
  unitSourced?: Sourced<number>;
};

export type Extraction =
  | { status: "EXTRACTED"; claims: Extracted[] }
  | { status: "ABSTAINED"; missing: Missing[] };

export type Policy = Readonly<Record<string, unknown>>;

export function extractClaims(
  requirement: string,
  offer: string,
  policy: Policy,
  classify: Classifier = defaultClassifier,
): Extraction {
  const classifications = classify(requirement);
  if (classifications.length === 0) {
    return {
      status: "ABSTAINED",
      missing: [
        { dimension: "SUBJECT", why: "no phrase in the requirement names a record, a response or a transaction" },
        { dimension: "PROPERTY", why: "no phrase in the requirement names an observable property" },
        { dimension: "THRESHOLD", why: "no comparable value appears in the requirement" },
      ],
    };
  }

  const claims: Extracted[] = [];
  const missing: Missing[] = [];

  for (const c of classifications) {
    if (c.unlocated) missing.push(...c.unlocated);
    if (!c.subject) {
      missing.push({ dimension: "SUBJECT", why: `rule ${c.ruleId} located no subject` });
      continue;
    }
    if (!c.property) {
      missing.push({ dimension: "PROPERTY", why: `rule ${c.ruleId} located no property` });
      continue;
    }

    // Threshold. Derived from the span, never supplied.
    if (!c.spans.amount) {
      if (!c.unlocated) {
        missing.push({ dimension: "THRESHOLD", why: `rule ${c.ruleId} located no numeral to source a value from` });
      }
      continue;
    }
    const amount = fromSpan("REQUIREMENT", requirement, c.spans.amount, parseUint);
    if (!amount) {
      missing.push({
        dimension: "THRESHOLD",
        why: `the span rule ${c.ruleId} pointed at does not contain a number, so no value can be sourced`,
      });
      continue;
    }
    if (!verifySourced(amount, { REQUIREMENT: requirement, OFFER: offer })) {
      missing.push({ dimension: "THRESHOLD", why: "the sourced span does not re-derive from the requirement" });
      continue;
    }

    // Issuer and semantic source come from explicit policy fields or not at all.
    const issuer = fromPolicy(policy, "permittedIssuer", parseAddressLike);
    if (!issuer) {
      missing.push({ dimension: "ISSUER", why: "no permittedIssuer in the requirement, the offer or the policy" });
      continue;
    }
    const sourceId = fromPolicy(policy, "expectedSourceId", parseAddressLike);
    if (!sourceId) {
      missing.push({ dimension: "SOURCE", why: "no expectedSourceId to compare a delivery's semantic origin against" });
      continue;
    }

    // Frame.
    let frame: Frame;
    if (c.frameKind === "ARTIFACT_FIELD") {
      if (!c.spans.frameField) {
        missing.push({ dimension: "FRAME", why: `rule ${c.ruleId} named a delivery clock but located no field` });
        continue;
      }
      const field = fromSpan("REQUIREMENT", requirement, c.spans.frameField, parseField);
      if (!field) {
        missing.push({ dimension: "FRAME", why: "the frame field span does not contain a field name" });
        continue;
      }
      frame = { kind: "ARTIFACT_FIELD", field: field.value };
    } else if (c.frameKind === "CHAIN_TIME") {
      frame = { kind: "CHAIN_TIME" };
    } else {
      frame = { kind: "AGREEMENT_TIME" };
    }

    // Test. Seconds are amount x unit, both sourced.
    let test: Claim["test"];
    let unitSourced: Sourced<number> | undefined;
    if (c.op === "AT_OR_AFTER") {
      if (!c.spans.unit) {
        missing.push({ dimension: "THRESHOLD", why: `rule ${c.ruleId} located a numeral but no unit` });
        continue;
      }
      const unit = fromSpan("REQUIREMENT", requirement, c.spans.unit, parseUnit);
      if (!unit) {
        missing.push({ dimension: "THRESHOLD", why: "the unit span does not name a recognised unit of time" });
        continue;
      }
      unitSourced = unit;
      test = { op: "AT_OR_AFTER", seconds: amount.value * unit.value, frame };
    } else if (c.op === "GTE" || c.op === "EQ") {
      test = { op: c.op, count: amount.value };
    } else {
      missing.push({ dimension: "PROPERTY", why: `rule ${c.ruleId} located no comparison operator` });
      continue;
    }

    const quoteSpan = c.spans.quantifier ?? c.spans.amount;
    claims.push({
      ruleId: c.ruleId,
      claim: {
        quote: requirement.slice(quoteSpan[0], quoteSpan[1]),
        subject: c.subject,
        property: c.property,
        test,
        permittedIssuer: issuer.value,
      },
      threshold: amount,
      issuer,
      sourceId,
      unitSourced,
    });
  }

  if (claims.length === 0) return { status: "ABSTAINED", missing: dedupe(missing) };
  return { status: "EXTRACTED", claims };
}

const dedupe = (m: Missing[]): Missing[] => {
  const seen = new Set<string>();
  return m.filter((x) => {
    const k = `${x.dimension}|${x.why}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// ------------------------------------------------------------------ PROTECT

export type ManifestClaim = {
  ruleId: string;
  claim: Claim;
  threshold: Sourced<number>;
  issuer: Sourced<string>;
  sourceId: Sourced<string>;
  lanes: Lane[];
  finding: Finding;
};

export type Manifest =
  | { status: "PROTECTED"; requirement: string; claims: ManifestClaim[] }
  | { status: "REFUSED"; requirement: string; missing: Missing[] };

export function protect(
  requirement: string,
  offer: string,
  policy: Policy,
  artifacts: readonly Artifact[],
  opts: { classify?: Classifier; ctx?: MatchContext } = {},
): Manifest {
  const extraction = extractClaims(requirement, offer, policy, opts.classify ?? defaultClassifier);
  if (extraction.status === "ABSTAINED") {
    return { status: "REFUSED", requirement, missing: extraction.missing };
  }

  const refusals: Missing[] = [];
  const out: ManifestClaim[] = [];

  for (const e of extraction.claims) {
    // A relative threshold must resolve against a clock the obligor does not
    // control. See spec/EVIDENCE.md 7.1 and CLAUDE.md invariant 11.
    if (e.claim.test.op === "AT_OR_AFTER" && e.claim.test.frame.kind === "ARTIFACT_FIELD") {
      refusals.push({
        dimension: "FRAME",
        why:
          `the threshold resolves against "${e.claim.test.frame.field}", a field the obligor supplies. ` +
          "Measured 2026-08-22: last_fetch_at drifted 10, 149, 101 and 102 seconds behind the request " +
          "across four calls, flipping the sign of a computed age on 93 records in one call and 22 in another",
      });
      continue;
    }
    const { lanes, finding } = inspect(e.claim, artifacts, opts.ctx ?? {});
    out.push({ ruleId: e.ruleId, claim: e.claim, threshold: e.threshold, issuer: e.issuer, sourceId: e.sourceId, lanes, finding });
  }

  if (out.length === 0) return { status: "REFUSED", requirement, missing: dedupe(refusals) };
  return { status: "PROTECTED", requirement, claims: out };
}
