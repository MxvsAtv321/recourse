import { keccak256, pad, toHex, type Address, type Hex } from "viem";
import { ClaimType, Opcode, Quantifier, type Condition } from "./types.js";

/**
 * The settlement model, made explicit:
 *   UNIVERSAL claims settle by counterexample against the committed leaves.
 *   SCALAR claims settle by direct evaluation against the signed commitment.
 *   Anything that fits neither is UNPROTECTABLE.
 *
 * A fixed table of supported term shapes. This is deliberately NOT a general
 * natural-language compiler. A listing phrase either matches one of these
 * patterns exactly enough to become a machine-checkable condition, or the
 * purchase is UNPROTECTABLE, which is a normal outcome and not an error.
 *
 * BLOB_EXISTENCE_TIME is deliberately absent: it fits neither settlement path,
 * because it is a property of the file rather than of the delivery's contents.
 */
type Rule = {
  id: string;
  pattern: RegExp;
  build: (m: RegExpMatchArray, ctx: CompileContext) => Omit<Condition, "conditionId" | "sourceQuote">;
};

export type CompileContext = {
  now: bigint;
  permittedIssuer: Address;
  expectedSourceId: Hex;
};

const RULES: Rule[] = [
  {
    // Scalar. Settles by direct evaluation against the signed leafCount.
    id: "row-count-at-least",
    pattern: /at least (\d+) (?:rows|records)/i,
    build: (m, ctx) => ({
      requires: ClaimType.ROW_COUNT,
      quantifier: Quantifier.SCALAR,
      opcode: Opcode.UINT_GTE,
      threshold: pad(toHex(BigInt(m[1])), { size: 32 }),
      permittedIssuer: ctx.permittedIssuer,
      expectedSourceId: ctx.expectedSourceId,
    }),
  },
  {
    id: "row-count-exactly",
    pattern: /exactly (\d+) (?:rows|records)/i,
    build: (m, ctx) => ({
      requires: ClaimType.ROW_COUNT,
      quantifier: Quantifier.SCALAR,
      opcode: Opcode.UINT_EQ,
      threshold: pad(toHex(BigInt(m[1])), { size: 32 }),
      permittedIssuer: ctx.permittedIssuer,
      expectedSourceId: ctx.expectedSourceId,
    }),
  },
  {
    id: "record-freshness-hours",
    pattern: /every record (?:is )?generated within the last (\d+) hours?/i,
    build: (m, ctx) => ({
      requires: ClaimType.RECORD_GENERATION_TIME,
      quantifier: Quantifier.UNIVERSAL,
      opcode: Opcode.TIMESTAMP_GTE,
      threshold: pad(toHex(ctx.now - BigInt(m[1]) * 3600n), { size: 32 }),
      permittedIssuer: ctx.permittedIssuer,
      expectedSourceId: ctx.expectedSourceId,
    }),
  },
  {
    id: "record-freshness-minutes",
    pattern: /every record (?:is )?generated within the last (\d+) minutes?/i,
    build: (m, ctx) => ({
      requires: ClaimType.RECORD_GENERATION_TIME,
      quantifier: Quantifier.UNIVERSAL,
      opcode: Opcode.TIMESTAMP_GTE,
      threshold: pad(toHex(ctx.now - BigInt(m[1]) * 60n), { size: 32 }),
      permittedIssuer: ctx.permittedIssuer,
      expectedSourceId: ctx.expectedSourceId,
    }),
  },
  {
    id: "record-schema",
    pattern: /every record matches schema "([^"]+)"/i,
    build: (m, ctx) => ({
      requires: ClaimType.SCHEMA_HASH,
      quantifier: Quantifier.UNIVERSAL,
      opcode: Opcode.BYTES32_EQ,
      threshold: keccak256(toHex(m[1])),
      permittedIssuer: ctx.permittedIssuer,
      expectedSourceId: ctx.expectedSourceId,
    }),
  },
];

export type CompiledTerm =
  | { protectable: true; ruleId: string; condition: Condition }
  | { protectable: false; phrase: string; reason: string };

export function compileListing(phrases: string[], ctx: CompileContext): CompiledTerm[] {
  return phrases.map((phrase, i) => {
    for (const rule of RULES) {
      const m = phrase.match(rule.pattern);
      if (m) {
        return {
          protectable: true,
          ruleId: rule.id,
          condition: { conditionId: i + 1, sourceQuote: phrase, ...rule.build(m, ctx) },
        };
      }
    }
    return {
      protectable: false,
      phrase,
      reason: "no supported condition expresses this term",
    };
  });
}

export const supportedRuleIds = () => RULES.map((r) => r.id);
