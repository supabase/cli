import { Context, Option } from "effect";
import type { HelpDoc } from "effect/cli";

import { CommandPermissionsAnnotation } from "./command-permissions.annotation.ts";
import {
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
import type { Condition, ConditionContext, Term } from "./permission-conditions.ts";
import { flagCatalogFor } from "./permission-flags.ts";
import type { FlagCatalog } from "./permission-flags.ts";
import { permissionSchemes } from "./permission-schemes.ts";
import type { Alternatives, PermissionScheme } from "./permission-schemes.ts";
import type { CommandPermissions, OperationEntry } from "./model.ts";

type PermissionKind = OperationEntry["kind"];

/** One thing a heading lists: operations' permission alternatives, or why there are none. */
type PermissionRow = { readonly anyOf: Alternatives } | { readonly note: string };

interface PermissionGroup {
  /** The heading the text section prints, without its colon. */
  readonly heading: string;
  readonly kind: PermissionKind;
  /** Whether the group depends on a prerequisite that isn't a flag. */
  readonly situational: boolean;
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
      readonly note?: string;
      readonly schemes: ReadonlyArray<SchemeSection>;
    };

interface Bucket {
  readonly row: PermissionRow;
  readonly kind: PermissionKind;
  readonly situational: boolean;
  condition: Condition;
}

const rowKey = (row: PermissionRow) => ("anyOf" in row ? JSON.stringify(row.anyOf) : row.note);

const strength = (kind: PermissionKind) => (kind === "required" ? 1 : 0);

function rowFor(scheme: PermissionScheme, entry: OperationEntry): PermissionRow {
  const anyOf = scheme.requirement(entry.operationId, entry.request);
  return anyOf === undefined ? { note: scheme.missing(entry.kind, entry.operationId) } : { anyOf };
}

/** Whether `other` already shows this bucket's row under a condition at least as broad. */
function absorbedBy(bucket: Bucket, other: Bucket): boolean {
  return (
    other !== bucket &&
    rowKey(other.row) === rowKey(bucket.row) &&
    strength(other.kind) >= strength(bucket.kind) &&
    (bucket.kind === "best-effort" || !other.situational || bucket.situational) &&
    conditionImplies(bucket.condition, other.condition)
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

const rank = (group: { kind: PermissionKind; situational: boolean; unconditional: boolean }) =>
  (group.kind === "required" ? 0 : 3) + (group.situational ? 2 : group.unconditional ? 0 : 1);

function schemeSection(
  scheme: PermissionScheme,
  terms: ReadonlyArray<{ readonly entry: OperationEntry; readonly term: Term }>,
  context: ConditionContext,
): SchemeSection {
  const buckets = new Map<string, Bucket>();
  for (const { entry, term } of terms) {
    const row = rowFor(scheme, entry);
    const situational = entry.context !== undefined && entry.kind === "required";
    const key = `${entry.kind}\u0000${situational}\u0000${rowKey(row)}`;
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, { row, kind: entry.kind, situational, condition: [term] });
    } else {
      bucket.condition = [...bucket.condition, term];
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
      kind: PermissionKind;
      situational: boolean;
      unconditional: boolean;
      rows: Array<PermissionRow>;
    }
  >();
  for (const bucket of shown) {
    const { flags, remote } = conditionText(bucket.condition, context);
    const heading = headingFor(bucket.kind, bucket.situational, flags, remote);
    const group = groups.get(heading) ?? {
      kind: bucket.kind,
      situational: bucket.situational,
      unconditional: flags === "" && !remote,
      rows: [],
    };
    group.rows.push(bucket.row);
    groups.set(heading, group);
  }
  return {
    scheme: scheme.id,
    title: scheme.title,
    groups: [...groups]
      .sort(([, a], [, b]) => rank(a) - rank(b))
      .map(([heading, group]) => ({
        heading,
        kind: group.kind,
        situational: group.situational,
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
  const reachable = permissions.operations.flatMap((entry) => {
    const term = termOf(entry.when, context);
    return term === undefined ? [] : [{ entry, term }];
  });
  if (reachable.length === 0) return undefined;

  const { dbTargetDefault } = permissions;
  const liftTarget = dbTargetDefault === "linked" && onlyLinked(reachable.map(({ term }) => term));
  const withoutLifted = liftTarget
    ? reachable.map(({ entry, term }) => ({
        entry,
        term: withoutVariables(term, [TARGET_VARIABLE]),
      }))
    : reachable;
  const common = commonConditions(
    withoutLifted.map(({ term }) => term),
    context,
  );
  const terms = withoutLifted.map(({ entry, term }) => ({
    entry,
    term: withoutVariables(term, common.variables),
  }));
  const note = [
    ...(liftTarget ? [notNeededWithOtherTargets(catalog)] : []),
    ...(common.positive.length > 0 ? [`Only needed with ${joinAnd(common.positive)}.`] : []),
    ...(common.negative.length > 0 ? [`Not needed with ${joinOr(common.negative)}.`] : []),
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
  return {
    status: "mapped",
    ...(note === "" ? {} : { note }),
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
