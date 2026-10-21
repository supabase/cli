import type { DbTarget, EntryCondition, OperationEntry } from "./model.ts";
import type { FlagCatalog, PermissionFlag } from "./permission-flags.ts";

const ABSENT = "\u0000absent";
const EMPTY = "\u0000empty";
const SET = "\u0000set";
const TARGET = "\u0000target";

const TARGET_FLAGS = ["db-url", "local", "linked"] as const satisfies ReadonlyArray<DbTarget>;

const isLiteral = (value: string) => ![ABSENT, EMPTY, SET].includes(value);

/** A literal value is a case of "given any value", so a set holding both keeps only `SET`. */
function withoutSubsumedLiterals(values: ReadonlySet<string>): ReadonlySet<string> {
  return values.has(SET) ? new Set([...values].filter((value) => !isLiteral(value))) : values;
}

function intersect(a: ReadonlySet<string>, b: ReadonlySet<string>): ReadonlySet<string> {
  const common = [...a].filter((value) => b.has(value) || (isLiteral(value) && b.has(SET)));
  const fromB = [...b].filter((value) => isLiteral(value) && a.has(SET));
  return new Set([...common, ...fromB]);
}

/**
 * What a run must look like for an entry to apply: each listed variable (a flag, or the database
 * target) takes one of the listed values, and unlisted variables are unrestricted.
 */
export type Term = ReadonlyMap<string, ReadonlySet<string>>;

/** The OR of terms. A single empty term means "always". */
export type Condition = ReadonlyArray<Term>;

export interface ConditionContext {
  readonly catalog: FlagCatalog;
  /** The target a run uses when no target flag is given; set with `withDbTarget`. */
  readonly targetDefault: "local" | "linked" | undefined;
  /** The values a variable can take; `undefined` for a variable the command does not have. */
  readonly domainOf: (variable: string) => ReadonlyArray<string> | undefined;
  /** The database targets a run can select. */
  readonly targets: ReadonlyArray<string>;
}

export function conditionContext(
  entries: ReadonlyArray<OperationEntry>,
  catalog: FlagCatalog,
  targetDefault: "local" | "linked" | undefined,
): ConditionContext {
  const conditions = entries.flatMap((entry) => entry.when ?? []);
  const targets = [
    ...TARGET_FLAGS.filter((flag) => catalog.has(flag)),
    ...(targetDefault !== undefined && !catalog.has(targetDefault) ? [targetDefault] : []),
  ];
  const domainOf = (variable: string): ReadonlyArray<string> | undefined => {
    if (variable === TARGET) return targets;
    const flag = catalog.get(variable);
    if (flag === undefined) return undefined;
    if (flag.kind === "boolean") return ["true", "false"];
    if (flag.kind === "choice") {
      const absenceIsTested = conditions.some(
        (condition) => condition.flag === variable && condition.present === false,
      );
      return flag.optional || absenceIsTested ? [...flag.choices, ABSENT] : flag.choices;
    }
    return [ABSENT, EMPTY, SET];
  };
  return { catalog, targetDefault, domainOf, targets };
}

type Constraint =
  | { readonly kind: "vacuous" }
  | { readonly kind: "unreachable" }
  | { readonly kind: "restrict"; readonly variable: string; readonly values: ReadonlySet<string> };

const VACUOUS: Constraint = { kind: "vacuous" };
const UNREACHABLE: Constraint = { kind: "unreachable" };

function restrict(
  context: ConditionContext,
  variable: string,
  values: ReadonlyArray<string>,
): Constraint {
  const unique = withoutSubsumedLiterals(new Set(values));
  if (unique.size === 0) return UNREACHABLE;
  const domain = context.domainOf(variable);
  if (domain !== undefined && domain.every((value) => unique.has(value))) return VACUOUS;
  return { kind: "restrict", variable, values: unique };
}

function targetConstraint(context: ConditionContext, targets: ReadonlyArray<DbTarget>): Constraint {
  if (context.targets.length === 0) return VACUOUS;
  return restrict(
    context,
    TARGET,
    targets.filter((target) => context.targets.includes(target)),
  );
}

function missingFlagConstraint(condition: EntryCondition): Constraint {
  if (condition.is !== undefined) return condition.is ? UNREACHABLE : VACUOUS;
  if (condition.oneOf !== undefined) return UNREACHABLE;
  return (condition.present ?? true) ? UNREACHABLE : VACUOUS;
}

function flagConstraint(
  context: ConditionContext,
  flag: PermissionFlag,
  condition: EntryCondition,
): Constraint {
  if (flag.hidden) return VACUOUS;
  const variable = flag.name;
  if (flag.kind === "boolean") {
    if (condition.is !== undefined) return restrict(context, variable, [String(condition.is)]);
    if (condition.oneOf !== undefined) return restrict(context, variable, condition.oneOf);
    return restrict(context, variable, [String(condition.present ?? true)]);
  }
  if (condition.oneOf !== undefined) {
    const values = condition.oneOf.map((value) =>
      value === "" && flag.kind === "text" ? EMPTY : value,
    );
    return restrict(context, variable, values);
  }
  if (condition.present !== undefined || condition.is === undefined) {
    const present = condition.present ?? true;
    if (flag.kind === "choice") {
      return restrict(context, variable, present ? flag.choices : [ABSENT]);
    }
    return restrict(context, variable, present ? [SET] : [ABSENT, EMPTY]);
  }
  return VACUOUS;
}

/** Whether the condition holds only when the flag is given or on. */
const requiresFlag = (condition: EntryCondition) =>
  condition.is === true ||
  condition.oneOf !== undefined ||
  (condition.is === undefined && condition.present !== false);

/**
 * Reduces an entry's `when` to one term against the command's flags, or `undefined` when no run can
 * satisfy it. A condition on a flag the command lacks is vacuous when it holds for an unset flag
 * (`is: false`, absence) and unreachable otherwise. A condition on a hidden flag is dropped; when
 * it said the entry applies only with that flag, `widened` reports it so the caller can hedge.
 */
export function termOf(
  conditions: ReadonlyArray<EntryCondition> | undefined,
  context: ConditionContext,
): { readonly term: Term; readonly widened: boolean } | undefined {
  const term = new Map<string, ReadonlySet<string>>();
  let widened = false;
  for (const condition of conditions ?? []) {
    const flag = condition.flag === undefined ? undefined : context.catalog.get(condition.flag);
    const constraint =
      condition.dbTarget !== undefined
        ? targetConstraint(context, condition.dbTarget)
        : flag === undefined
          ? missingFlagConstraint(condition)
          : flagConstraint(context, flag, condition);
    if (constraint.kind === "unreachable") return undefined;
    if (flag?.hidden === true && requiresFlag(condition)) widened = true;
    if (constraint.kind === "vacuous") continue;
    const existing = term.get(constraint.variable);
    const values =
      existing === undefined ? constraint.values : intersect(existing, constraint.values);
    if (values.size === 0) return undefined;
    term.set(constraint.variable, values);
  }
  return { term, widened };
}

/** Whether every run matching `strong` also matches `weak`. */
function implies(strong: Term, weak: Term): boolean {
  return [...weak].every(([variable, allowed]) => {
    const values = strong.get(variable);
    return (
      values !== undefined &&
      [...values].every((value) => allowed.has(value) || (isLiteral(value) && allowed.has(SET)))
    );
  });
}

const sameValues = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((value) => b.has(value));

function mergeTerms(a: Term, b: Term, context: ConditionContext): Term | undefined {
  if (a.size !== b.size) return undefined;
  let differing: string | undefined;
  for (const [variable, values] of a) {
    const other = b.get(variable);
    if (other === undefined) return undefined;
    if (sameValues(values, other)) continue;
    if (differing !== undefined) return undefined;
    differing = variable;
  }
  if (differing === undefined) return a;
  const union = withoutSubsumedLiterals(
    new Set([...(a.get(differing) ?? []), ...(b.get(differing) ?? [])]),
  );
  const merged = new Map(a);
  const domain = context.domainOf(differing);
  if (domain !== undefined && domain.every((value) => union.has(value))) merged.delete(differing);
  else merged.set(differing, union);
  return merged;
}

/**
 * Collapses an OR of terms: drops a term another term makes redundant and merges two terms that
 * differ in one variable into one that takes the union of its values, dropping a variable whose
 * values cover its whole domain.
 */
export function simplify(terms: Condition, context: ConditionContext): Condition {
  let current = terms;
  for (;;) {
    const kept = current.filter(
      (term, index) =>
        !current.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            implies(term, other) &&
            (!implies(other, term) || otherIndex < index),
        ),
    );
    const merge = kept.flatMap((a, i) =>
      kept.slice(i + 1).flatMap((b, offset) => {
        const merged = mergeTerms(a, b, context);
        return merged === undefined ? [] : [{ i, j: i + 1 + offset, merged }];
      }),
    )[0];
    if (merge === undefined) return kept;
    current = [...kept.filter((_, index) => index !== merge.i && index !== merge.j), merge.merged];
  }
}

/** Whether every run matching `strong` also matches `weak`, term by term. */
export function conditionImplies(strong: Condition, weak: Condition): boolean {
  return strong.every((term) => weak.some((other) => implies(term, other)));
}

export const TARGET_VARIABLE = TARGET;

export function withoutVariables(term: Term, variables: ReadonlyArray<string>): Term {
  return new Map([...term].filter(([variable]) => !variables.includes(variable)));
}

/** Whether every term restricts the target to the linked project alone. */
export function onlyLinked(terms: ReadonlyArray<Term>): boolean {
  return (
    terms.length > 0 &&
    terms.every((term) => {
      const values = term.get(TARGET);
      return values !== undefined && values.size === 1 && values.has("linked");
    })
  );
}

export const joinAnd = (items: ReadonlyArray<string>) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

export const joinOr = (items: ReadonlyArray<string>) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;

interface TermText {
  readonly positive: ReadonlyArray<string>;
  readonly negative: ReadonlyArray<string>;
  readonly remote: boolean;
}

function textOfVariable(
  variable: string,
  values: ReadonlySet<string>,
  context: ConditionContext,
): Partial<TermText> {
  if (variable === TARGET) {
    if (values.size === 1 && values.has("linked")) {
      return context.targetDefault === "linked" ? { remote: true } : { positive: ["--linked"] };
    }
    const named = context.targets.filter((target) => values.has(target));
    return { positive: [joinOr(named.map((target) => `--${target}`))] };
  }
  const flag = context.catalog.get(variable);
  const name = `--${variable}`;
  if (flag?.kind === "boolean") {
    return values.has("true") ? { positive: [name] } : { negative: [name] };
  }
  const literals =
    flag?.kind === "choice"
      ? flag.choices.filter((value) => values.has(value))
      : [...values].filter((value) => ![ABSENT, EMPTY, SET].includes(value)).sort();
  if (literals.length > 0) {
    return { positive: [`${name}=${literals.join("|")}${values.has(ABSENT) ? " or unset" : ""}`] };
  }
  if (values.has(ABSENT)) return values.has(SET) ? {} : { negative: [name] };
  return { positive: [name] };
}

function termText(term: Term, context: ConditionContext): TermText {
  const parts = [...term].map(([variable, values]) => textOfVariable(variable, values, context));
  return {
    positive: parts.flatMap((part) => part.positive ?? []),
    negative: parts.flatMap((part) => part.negative ?? []),
    remote: parts.some((part) => part.remote === true),
  };
}

const flagsPhrase = ({ positive, negative }: TermText) =>
  [
    ...(positive.length > 0 ? [`with ${joinAnd(positive)}`] : []),
    ...(negative.length > 0 ? [`without ${joinAnd(negative)}`] : []),
  ].join(", ");

/** The flag condition as help prints it, and whether it limits the command to the linked project. */
export function conditionText(
  condition: Condition,
  context: ConditionContext,
): { readonly flags: string; readonly remote: boolean } {
  const texts = condition.map((term) => termText(term, context));
  const [only] = texts;
  if (texts.length === 1 && only !== undefined) {
    return { flags: flagsPhrase(only), remote: only.remote };
  }
  if (texts.every((text) => text.negative.length === 0 && !text.remote)) {
    const common = texts[0]?.positive.filter((part) =>
      texts.every((t) => t.positive.includes(part)),
    );
    const rest = texts.map((text) => text.positive.filter((part) => !common?.includes(part)));
    if (common !== undefined && rest.every((parts) => parts.length === 1)) {
      const alternatives = joinOr(rest.flat());
      return {
        flags: `with ${joinAnd(common.length === 0 ? [alternatives] : [...common, `one of ${alternatives}`])}`,
        remote: false,
      };
    }
  }
  const phrases = texts.map((text) =>
    [flagsPhrase(text), ...(text.remote ? ["remote only"] : [])].filter(Boolean).join(", "),
  );
  const separator = phrases.some((phrase) => /,| and /.test(phrase)) ? "; or " : " or ";
  return { flags: phrases.join(separator), remote: false };
}

/**
 * The variables every term restricts the same way, split by how help words them: `positive` ones a
 * run must have (`--linked`), `negative` ones it must lack (`--local`).
 */
export function commonConditions(
  terms: ReadonlyArray<Term>,
  context: ConditionContext,
): {
  variables: ReadonlyArray<string>;
  positive: ReadonlyArray<string>;
  negative: ReadonlyArray<string>;
} {
  const [first] = terms;
  const shared = [...(first ?? [])].filter(([variable, values]) =>
    terms.every((term) => {
      const other = term.get(variable);
      return other !== undefined && sameValues(values, other);
    }),
  );
  const described = shared.map(([variable, values]) => ({
    variable,
    text: textOfVariable(variable, values, context),
  }));
  const usable = described.filter(
    ({ text }) => (text.positive?.length ?? 0) + (text.negative?.length ?? 0) > 0,
  );
  return {
    variables: usable.map(({ variable }) => variable),
    positive: usable.flatMap(({ text }) => text.positive ?? []),
    negative: usable.flatMap(({ text }) => text.negative ?? []),
  };
}
