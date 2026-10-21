import { Context, Option } from "effect";
import type { HelpDoc } from "effect/cli";

import { CommandPermissionsAnnotation } from "./command-permissions.annotation.ts";
import {
  alternativesOf,
  conditionContext,
  commonConditions,
  conditionImplies,
  conditionText,
  joinAnd,
  joinOr,
  onlyLinked,
  simplify,
  TARGET_VARIABLE,
  termOf,
  withoutVariables,
} from "./permission-conditions.ts";
import type {
  Alternative,
  Condition,
  ConditionContext,
  ConditionData,
  Term,
} from "./permission-conditions.ts";
import { CommandFlagsAnnotation, flagCatalogFor } from "./permission-flags.ts";
import type { FlagCatalog } from "./permission-flags.ts";
import { permissionSchemes } from "./permission-schemes.ts";
import type { Alternatives, PermissionScheme, Requirement } from "./permission-schemes.ts";
import type { CommandPermissions, OperationEntry } from "./model.ts";

type PermissionKind = OperationEntry["kind"];

/** One thing a heading lists: what an operation needs, or why a scheme lists nothing. */
type PermissionRow = Requirement | { readonly note: string };

interface PermissionGroup {
  /** The heading the text section prints, without its colon. */
  readonly heading: string;
  /**
   * `required` fails or loses the command's result without it; `maybe` is needed only in
   * circumstances the heading does not spell out; `optional` leaves the command working without it.
   */
  readonly need: "required" | "maybe" | "optional";
  /** The ways the group applies, any one of which suffices; absent when it always applies. */
  readonly when?: ReadonlyArray<Alternative>;
  readonly rows: ReadonlyArray<PermissionRow>;
}

interface SchemeSection {
  readonly scheme: string;
  readonly title: string;
  readonly groups: ReadonlyArray<PermissionGroup>;
}

/** What help shows about a command's token permissions. */
export type PermissionSection =
  | { readonly status: "unmapped" }
  | {
      readonly status: "mapped";
      /** What the whole section depends on, in words. */
      readonly note?: string;
      /** The conditions behind `note`, all of which must hold for any group to apply. */
      readonly when?: ReadonlyArray<ConditionData>;
      readonly schemes: ReadonlyArray<SchemeSection>;
    };

interface Bucket {
  readonly row: PermissionRow;
  readonly kind: PermissionKind;
  readonly situational: boolean;
  condition: Condition;
}

const rowKey = (row: PermissionRow) => JSON.stringify(row);

/** An entry the command can reach; `hedged` when a prerequisite or a hidden flag qualifies it. */
interface ReachableEntry {
  readonly entry: OperationEntry;
  readonly term: Term;
  readonly hedged: boolean;
}

const strength = (kind: PermissionKind) => (kind === "required" ? 1 : 0);

interface RowPart {
  readonly row: PermissionRow;
  readonly hedged: boolean;
}

function rowPartsFor(scheme: PermissionScheme, entry: OperationEntry): ReadonlyArray<RowPart> {
  const parts = scheme.requirement(entry.operationId, entry.request);
  return parts === undefined
    ? [{ row: { note: scheme.missing(entry.kind, entry.operationId) }, hedged: false }]
    : parts.map(({ requirement, hedged }) => ({ row: requirement, hedged }));
}

const sameOrBroader = (bucket: Bucket, other: Bucket) =>
  strength(other.kind) >= strength(bucket.kind) &&
  (bucket.kind === "best-effort" || !other.situational || bucket.situational) &&
  conditionImplies(bucket.condition, other.condition);

/**
 * Whether `other` already shows this bucket's row: under a condition at least as broad or, for an
 * optional row, as required under any condition, so no heading says the command still runs
 * without a permission that another heading requires.
 */
function absorbedBy(bucket: Bucket, other: Bucket): boolean {
  if (other === bucket || rowKey(other.row) !== rowKey(bucket.row)) return false;
  return (
    (bucket.kind === "best-effort" && other.kind === "required") || sameOrBroader(bucket, other)
  );
}

function headingFor(
  kind: PermissionKind,
  situational: boolean,
  flags: string,
  remote: boolean,
): string {
  const inner = [flags, ...(remote ? ["remote only"] : [])].filter(Boolean).join(", ");
  if (kind === "required" && !situational) {
    return `Required${flags === "" ? "" : ` ${flags}`}${remote ? " (remote only)" : ""}`;
  }
  if (kind === "required") return `May be required${inner === "" ? "" : ` (${inner})`}`;
  return `Optional${inner === "" ? "" : `, ${inner}`} (command still runs without these)`;
}

const needOf = (group: { kind: PermissionKind; situational: boolean }) =>
  group.kind === "best-effort" ? "optional" : group.situational ? "maybe" : "required";

const rank = (group: { kind: PermissionKind; situational: boolean; unconditional: boolean }) =>
  (group.kind === "required" ? 0 : 3) + (group.situational ? 2 : group.unconditional ? 0 : 1);

function schemeSection(
  scheme: PermissionScheme,
  terms: ReadonlyArray<ReachableEntry>,
  context: ConditionContext,
): SchemeSection {
  const buckets = new Map<string, Bucket>();
  for (const { entry, term, hedged } of terms) {
    for (const part of rowPartsFor(scheme, entry)) {
      const { row } = part;
      const situational = (hedged || part.hedged) && entry.kind === "required";
      const key = `${entry.kind}\u0000${situational}\u0000${rowKey(row)}`;
      const bucket = buckets.get(key);
      if (bucket === undefined) {
        buckets.set(key, { row, kind: entry.kind, situational, condition: [term] });
      } else {
        bucket.condition = [...bucket.condition, term];
      }
    }
  }
  const simplified = [...buckets.values()].map((bucket) => ({
    ...bucket,
    condition: simplify(bucket.condition, context),
  }));
  const shown = simplified.filter(
    (bucket) => !simplified.some((other) => absorbedBy(bucket, other)),
  );

  const groups = new Map<
    string,
    {
      heading: string;
      kind: PermissionKind;
      situational: boolean;
      unconditional: boolean;
      when: ReadonlyArray<Alternative> | undefined;
      rows: Array<PermissionRow>;
    }
  >();
  for (const bucket of shown) {
    const { flags, remote } = conditionText(bucket.condition, context);
    const heading = headingFor(bucket.kind, bucket.situational, flags, remote);
    const when = alternativesOf(bucket.condition, context);
    // A group holds only rows whose conditions are identical, so one row's condition never
    // stands for another's even when their headings read alike.
    const key = `${heading}\u0000${JSON.stringify(when)}`;
    const group = groups.get(key) ?? {
      heading,
      kind: bucket.kind,
      situational: bucket.situational,
      unconditional: flags === "" && !remote,
      when,
      rows: [],
    };
    group.rows.push(bucket.row);
    groups.set(key, group);
  }
  return {
    scheme: scheme.id,
    title: scheme.title,
    groups: [...groups.values()]
      .sort((a, b) => rank(a) - rank(b))
      .map((group) => ({
        heading: group.heading,
        need: needOf(group),
        ...(group.when === undefined ? {} : { when: group.when }),
        rows: group.rows,
      })),
  };
}

function notNeededWithOtherTargets(catalog: FlagCatalog): string {
  const flags = ["local", "db-url"].filter((name) => catalog.get(name)?.hidden === false);
  return flags.length === 0 ? "" : `Not needed with ${joinOr(flags.map((flag) => `--${flag}`))}.`;
}

/**
 * What help shows for a command's declared permissions, or `undefined` when the command calls no
 * API operation. Each registered scheme is resolved on its own.
 */
export function resolvePermissionSection(
  permissions: CommandPermissions,
  catalog: FlagCatalog,
  schemes: ReadonlyArray<PermissionScheme> = permissionSchemes,
): PermissionSection | undefined {
  if (permissions.status === "unmapped") return { status: "unmapped" };
  const context = conditionContext(permissions.operations, catalog, permissions.dbTargetDefault);
  const reachable = permissions.operations.flatMap((entry): ReadonlyArray<ReachableEntry> => {
    const reduced = termOf(entry.when, context);
    return reduced === undefined
      ? []
      : [{ entry, term: reduced.term, hedged: entry.context !== undefined || reduced.widened }];
  });
  if (reachable.length === 0) return undefined;

  const { dbTargetDefault } = permissions;
  const liftTarget = dbTargetDefault === "linked" && onlyLinked(reachable.map(({ term }) => term));
  const withoutLifted = liftTarget
    ? reachable.map((item) => ({ ...item, term: withoutVariables(item.term, [TARGET_VARIABLE]) }))
    : reachable;
  const common = commonConditions(
    withoutLifted.map(({ term }) => term),
    context,
  );
  const terms = withoutLifted.map((item) => ({
    ...item,
    term: withoutVariables(item.term, common.variables),
  }));
  const note = [
    ...(liftTarget ? [notNeededWithOtherTargets(catalog)] : []),
    ...(common.positive.length > 0 ? [`Only needed with ${joinAnd(common.positive)}.`] : []),
    ...(common.negative.length > 0 ? [`Not needed with ${joinOr(common.negative)}.`] : []),
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
  const when: ReadonlyArray<ConditionData> = [
    ...(liftTarget ? [{ target: ["linked"] }] : []),
    ...common.conditions,
  ];
  return {
    status: "mapped",
    ...(note === "" ? {} : { note }),
    ...(when.length === 0 ? {} : { when }),
    schemes: schemes.map((scheme) => schemeSection(scheme, terms, context)),
  };
}

const WRAP_AT = 56;

const altText = (alternative: ReadonlyArray<string>) => alternative.join(" + ");

const wraps = (anyOf: Alternatives) =>
  anyOf.some((alternative) => altText(alternative).length > WRAP_AT) ||
  (anyOf.length > 1 && anyOf.map(altText).join(" or ").length > WRAP_AT);

function renderRow(row: PermissionRow): Array<string> {
  if ("note" in row) return [`      ${row.note}`];
  if ("cases" in row) {
    return row.cases.map(
      ({ for: target, allOf }, index) =>
        `      ${index === 0 ? "" : "  or "}${altText(allOf)} for ${target}`,
    );
  }
  if (!wraps(row.anyOf)) return [`      ${row.anyOf.map(altText).join(" or ")}`];
  return row.anyOf.flatMap((alternative, index) => {
    const [head, ...more] =
      altText(alternative).length > WRAP_AT ? alternative : [altText(alternative)];
    return [
      index === 0 ? `      ${head}` : `        or ${head}`,
      ...more.map((permission) => `        ${index === 0 ? "" : "   "}+ ${permission}`),
    ];
  });
}

/** The PERMISSIONS help section as text. */
export function renderPermissionsSection(section: PermissionSection): string {
  if (section.status === "unmapped") {
    return "PERMISSIONS\n  Token permissions for this command are not documented yet.";
  }
  const lines = ["PERMISSIONS"];
  if (section.note !== undefined) lines.push(`  ${section.note}`);
  for (const scheme of section.schemes) {
    lines.push(`  ${scheme.title}:`);
    for (const group of scheme.groups) {
      lines.push(`    ${group.heading}:`);
      for (const row of group.rows) lines.push(...renderRow(row));
    }
  }
  return lines.join("\n");
}

/** The section for the command a help document describes, when it declares permissions. */
export function permissionSectionForHelp(doc: HelpDoc.HelpDoc): PermissionSection | undefined {
  return Option.flatMap(
    Context.getOption(doc.annotations, CommandPermissionsAnnotation),
    (declared) => Option.fromNullishOr(resolvePermissionSection(declared, flagCatalogFor(doc))),
  ).pipe(Option.getOrUndefined);
}

/** The help document without the annotations that hold a command's raw permission declaration. */
export function withoutPermissionAnnotations(doc: HelpDoc.HelpDoc): HelpDoc.HelpDoc {
  return {
    ...doc,
    annotations: Context.omit(
      CommandPermissionsAnnotation,
      CommandFlagsAnnotation,
    )(doc.annotations),
  };
}
