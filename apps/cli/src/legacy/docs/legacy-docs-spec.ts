import { Option } from "effect";
import { stringify } from "yaml";
import { GlobalFlag } from "effect/unstable/cli";
import type { Command, Param } from "effect/unstable/cli";
import {
  legacyChoiceKeysOf,
  legacyCommandInternals,
  legacyFlattenSubcommands,
  legacyUserGlobalFlagParams,
} from "./legacy-docs-introspection.ts";
import { legacyUnwrapParam } from "../shared/legacy-param-introspection.ts";
import {
  LEGACY_DOCS_DEFAULT_OVERRIDES,
  LEGACY_DOCS_CHOICE_OVERRIDES,
  LEGACY_DOCS_EXCLUDED,
  LEGACY_DOCS_EXPERIMENTAL,
  LEGACY_DOCS_EXTRA_FLAGS,
  LEGACY_DOCS_EXPERIMENTAL_OPTIONAL,
  LEGACY_DOCS_INFO_DESCRIPTION,
  LEGACY_DOCS_INFO_TAGS,
  LEGACY_DOCS_REQUIRED,
  LEGACY_DOCS_TAGS,
} from "./legacy-docs-spec.tables.ts";
import type { LegacyDocsInfoTag } from "./legacy-docs-spec.tables.ts";

/**
 * Builds the `clispec 001` document consumed by the supabase.com CLI
 * reference (`supabase/supabase` `apps/docs/spec/cli_v1_commands.yaml`) from
 * the legacy Effect command tree — replacing the retired Go generator's
 * cobra walk.
 *
 * The semantic contract this preserves (verified against the retired Go
 * generator's output when the pipeline was re-pointed — all 135 command ids,
 * titles, subcommand sets, flag sets, defaults and accepted values matched):
 * command `id` is `CommandPath` with spaces replaced by dashes and is the
 * public URL slug plus the join key into `common-cli-sections.json`;
 * `subcommands`, `flags`, `tags`, `links` are always arrays; `default_value`
 * is always present; flag `name` is a preformatted display string
 * (`-p, --password <string>`); enum flags carry `accepted_values`;
 * experimental leaves append the root `--experimental` flag with
 * `required: true`. Go-yaml serialization quirks (trailing-newline padding of
 * long strings, reversed command order) are deliberately not reproduced —
 * every downstream consumer parses the YAML and joins on `id`.
 *
 * Every static-table key (`legacy-docs-spec.tables.ts`) is validated
 * against the walked tree at build
 * time — a stale entry (after a command or flag rename) fails the build with
 * the offending keys listed instead of silently degrading the published
 * reference.
 */

export interface LegacyDocsExample {
  readonly id?: string;
  readonly name?: string;
  readonly code?: string;
  readonly response?: string;
}

export interface LegacyDocsAcceptedValue {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface LegacyDocsFlag {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly default_value: string;
  readonly accepted_values?: ReadonlyArray<LegacyDocsAcceptedValue>;
}

export interface LegacyDocsCommand {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly examples?: ReadonlyArray<LegacyDocsExample>;
  readonly tags: ReadonlyArray<string>;
  readonly links: ReadonlyArray<never>;
  readonly usage?: string;
  readonly subcommands: ReadonlyArray<string>;
  readonly flags: ReadonlyArray<LegacyDocsFlag>;
}

export interface LegacyDocsInfo {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly language: string;
  readonly source: string;
  readonly bugs: string;
  readonly spec: string;
  readonly description: string;
  readonly tags: ReadonlyArray<LegacyDocsInfoTag>;
}

export interface LegacyDocsSpec {
  readonly clispec: string;
  readonly info: LegacyDocsInfo;
  readonly flags: ReadonlyArray<LegacyDocsFlag>;
  readonly commands: ReadonlyArray<LegacyDocsCommand>;
}

export interface LegacyDocsSpecInput {
  readonly root: Command.Command.Any;
  readonly version: string;
  /** Overlay markdown keyed by docs-relative POSIX path, e.g. `supabase/db/push.md`. */
  readonly overlays: ReadonlyMap<string, string>;
  /** Examples keyed by doc id, from `docs/templates/examples.yaml`. */
  readonly examples: Readonly<Record<string, ReadonlyArray<LegacyDocsExample>>>;
}

/**
 * Overlay file path for a command path — the layout contract of
 * `docs/supabase/`: one directory per word, except paths deeper than three
 * words flatten the tail into one dash-joined filename
 * (`supabase inspect db bloat` → `supabase/inspect/db-bloat.md`).
 */
export function legacyDocsOverlayPath(commandPath: ReadonlyArray<string>): string {
  const names =
    commandPath.length > 3
      ? [...commandPath.slice(0, 2), commandPath.slice(2).join("-")]
      : [...commandPath];
  return `${names.join("/")}.md`;
}

/**
 * Every current overlay file's first line is a human heading
 * (`## supabase-...`) that must not reach the published description; it is
 * dropped (keeping its trailing newline). A file without a leading heading
 * keeps its full content rather than silently losing its first line.
 */
export function legacyDocsStripOverlayHeading(contents: string): string {
  if (!contents.startsWith("#")) return contents;
  const newline = contents.indexOf("\n");
  return newline === -1 ? "" : contents.slice(newline);
}

/** Locale-independent byte-wise ordering, so the emitted YAML is machine-independent. */
function legacyDocsCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const LEGACY_DOCS_ENUM_TYPE_MAX_JOINED_LENGTH = 40;

/**
 * Enum display type: `[ a | b ]` while the joined value list stays under 40
 * characters, otherwise plain `string` — rendered inside `<...>` in the flag
 * name and repeated on each accepted value.
 */
function legacyDocsEnumTypeString(choices: ReadonlyArray<string>): string {
  const joined = choices.join(" | ");
  return joined.length < LEGACY_DOCS_ENUM_TYPE_MAX_JOINED_LENGTH ? `[ ${joined} ]` : "string";
}

function legacyDocsPrimitiveVarname(
  single: Param.Single<Param.ParamKind, unknown>,
  isVariadic: boolean,
): string | undefined {
  if (single.typeName !== undefined) return single.typeName;
  switch (single.primitiveType._tag) {
    case "Boolean":
      return undefined;
    case "Integer":
      return "int";
    case "Float":
      return "float";
    case "Date":
      return "time";
    default:
      return isVariadic ? "strings" : "string";
  }
}

function legacyDocsTypeDefault(
  single: Param.Single<Param.ParamKind, unknown>,
  isVariadic: boolean,
): string {
  if (single.primitiveType._tag === "Boolean") return "false";
  if (isVariadic) return "[]";
  if (single.primitiveType._tag === "Integer" || single.primitiveType._tag === "Float") return "0";
  return "";
}

function legacyDocsFlagDoc(
  commandPath: ReadonlyArray<string>,
  param: Param.AnyFlag,
): LegacyDocsFlag | undefined {
  const unwrapped = legacyUnwrapParam(param);
  if (unwrapped === undefined) return undefined;
  const { single, isVariadic } = unwrapped;
  if (single.hidden) return undefined;

  const docId = commandPath.join("-");
  const overrideKey = `${docId} ${single.name}`;

  let acceptedValues: ReadonlyArray<LegacyDocsAcceptedValue> | undefined;
  let enumType: string | undefined;
  const choices =
    LEGACY_DOCS_CHOICE_OVERRIDES[overrideKey] ?? legacyChoiceKeysOf(single.primitiveType);
  if (choices !== undefined) {
    enumType = legacyDocsEnumTypeString(choices);
    const type = enumType;
    acceptedValues = choices.map((value) => ({ id: value, name: value, type }));
  }

  const varname = enumType ?? legacyDocsPrimitiveVarname(single, isVariadic);

  const shorthand = single.aliases.find((alias) => alias.length === 1);
  const name = `${shorthand === undefined ? "" : `-${shorthand}, `}--${single.name}${
    varname === undefined ? "" : ` <${varname}>`
  }`;

  const required = LEGACY_DOCS_REQUIRED.has(overrideKey);

  return {
    id: single.name,
    name,
    description: Option.getOrElse(single.description, () => ""),
    ...(required ? { required: true } : {}),
    default_value:
      LEGACY_DOCS_DEFAULT_OVERRIDES[overrideKey] ?? legacyDocsTypeDefault(single, isVariadic),
    ...(acceptedValues === undefined ? {} : { accepted_values: acceptedValues }),
  };
}

function legacyDocsArgumentUsage(param: Param.AnyArgument): string | undefined {
  const unwrapped = legacyUnwrapParam(param);
  if (unwrapped === undefined) return undefined;
  const { single, isOptional, isVariadic, variadicMin } = unwrapped;
  if (single.hidden) return undefined;
  const optional = isOptional || (isVariadic && variadicMin === 0);
  const rendered = optional ? `[${single.name}]` : `<${single.name}>`;
  return isVariadic ? `${rendered} ...` : rendered;
}

function legacyDocsVisibleChildren(
  command: Command.Command.Any,
): ReadonlyArray<Command.Command.Any> {
  return legacyFlattenSubcommands(command)
    .filter((child) => !child.hidden)
    .toSorted((a, b) => legacyDocsCompare(a.name, b.name));
}

function legacyDocsExamplesFor(
  docId: string,
  command: Command.Command.Any,
  examples: Readonly<Record<string, ReadonlyArray<LegacyDocsExample>>>,
): ReadonlyArray<LegacyDocsExample> | undefined {
  const fromYaml = examples[docId];
  if (fromYaml !== undefined && fromYaml.length > 0) return fromYaml;
  if (command.examples.length === 0) return undefined;
  return command.examples.map((example, index) => ({
    id: `example-${index + 1}`,
    name: example.description ?? example.command,
    code: example.command,
  }));
}

/** First line of a command's long description, for the listing summary fallback. */
function legacyDocsSummary(command: Command.Command.Any): string {
  if (command.shortDescription !== undefined) return command.shortDescription;
  const description = command.description ?? "";
  const newline = description.indexOf("\n");
  return newline === -1 ? description : description.slice(0, newline);
}

/** The root `--experimental` flag doc injected into experimental leaves. */
function legacyDocsExperimentalFlag(rootFlags: ReadonlyArray<LegacyDocsFlag>): LegacyDocsFlag {
  const experimental = rootFlags.find((flag) => flag.id === "experimental");
  if (experimental === undefined) {
    throw new Error(
      "legacy-docs-spec.ts: the root command tree declares no --experimental global flag; the experimental-leaf injection cannot be built.",
    );
  }
  return { ...experimental, required: true };
}

export function legacyBuildDocsSpec(input: LegacyDocsSpecInput): LegacyDocsSpec {
  const rootPath = ["supabase"];
  const rootFlagParams: ReadonlyArray<Param.AnyFlag> = [
    ...legacyUserGlobalFlagParams(input.root),
    GlobalFlag.Help.flag,
  ];
  const rootFlags = rootFlagParams
    .map((param) => legacyDocsFlagDoc(rootPath, param))
    .filter((flag) => flag !== undefined)
    .toSorted((a, b) => legacyDocsCompare(a.id, b.id));
  const experimentalFlag = legacyDocsExperimentalFlag(rootFlags);
  const { required: _experimentalRequired, ...experimentalOptionalFlag } = experimentalFlag;
  const rootFlagIds = new Set(rootFlags.map((flag) => flag.id));

  const commands: Array<LegacyDocsCommand> = [];
  const emittedIds = new Set<string>();
  const skippedExcludedIds = new Set<string>();
  const seenFlagKeys = new Set<string>(rootFlags.map((flag) => `supabase ${flag.id}`));

  const flagDocsFor = (
    commandPath: ReadonlyArray<string>,
    params: ReadonlyArray<Param.AnyFlag>,
  ): ReadonlyArray<LegacyDocsFlag> => {
    const docId = commandPath.join("-");
    return params
      .map((param) => legacyDocsFlagDoc(commandPath, param))
      .filter((flag) => flag !== undefined)
      .map((flag) => {
        seenFlagKeys.add(`${docId} ${flag.id}`);
        return flag;
      })
      .toSorted((a, b) => legacyDocsCompare(a.id, b.id));
  };

  const visit = (
    command: Command.Command.Any,
    commandPath: ReadonlyArray<string>,
    inheritedParams: ReadonlyArray<Param.AnyFlag>,
  ): void => {
    const docId = commandPath.join("-");
    const children = legacyDocsVisibleChildren(command);
    const internals = legacyCommandInternals(command);
    const isLeaf = children.length === 0;
    emittedIds.add(docId);

    const overlay = input.overlays.get(legacyDocsOverlayPath(commandPath));
    const description =
      overlay === undefined ? (command.description ?? "") : legacyDocsStripOverlayHeading(overlay);

    const flags: Array<LegacyDocsFlag> = [];
    if (isLeaf) {
      const own = [
        ...flagDocsFor(commandPath, internals.config.flags),
        ...(LEGACY_DOCS_EXTRA_FLAGS[docId] ?? []),
      ].toSorted((a, b) => legacyDocsCompare(a.id, b.id));
      own.forEach((flag) => seenFlagKeys.add(`${docId} ${flag.id}`));
      flags.push(...own);
      if (LEGACY_DOCS_EXPERIMENTAL.has(docId)) flags.push(experimentalFlag);
      if (LEGACY_DOCS_EXPERIMENTAL_OPTIONAL.has(docId)) flags.push(experimentalOptionalFlag);
      const ownIds = new Set(own.map((flag) => flag.id));
      const inherited = flagDocsFor(commandPath, inheritedParams).filter(
        (flag) => !ownIds.has(flag.id) && !rootFlagIds.has(flag.id),
      );
      flags.push(...inherited);
    }

    let usage: string | undefined;
    if (isLeaf) {
      const argUsages = internals.config.arguments
        .map(legacyDocsArgumentUsage)
        .filter((part) => part !== undefined);
      usage = [...commandPath, ...argUsages, "[flags]"].join(" ");
    }

    const tags = LEGACY_DOCS_TAGS[docId];
    if (tags === undefined && commandPath.length === 2) {
      throw new Error(
        `legacy-docs-spec.ts: top-level command "${docId}" has no LEGACY_DOCS_TAGS entry — add its docs-site section tag (or "other-commands") to legacy-docs-spec.tables.ts.`,
      );
    }

    const commandExamples = legacyDocsExamplesFor(docId, command, input.examples);

    commands.push({
      id: docId,
      title: commandPath.join(" "),
      summary: legacyDocsSummary(command),
      description,
      ...(commandExamples === undefined ? {} : { examples: commandExamples }),
      tags: tags ?? [],
      links: [],
      ...(usage === undefined ? {} : { usage }),
      subcommands: children
        .map((child) => [...commandPath, child.name].join("-"))
        .filter((childId) => !LEGACY_DOCS_EXCLUDED.has(childId)),
      flags,
    });

    // A non-root command's scoped global flags (`Command.withGlobalFlags`
    // below root, e.g. `seed`'s `--linked`/`--local`) behave like persistent
    // flags: the reference surfaces them on every leaf beneath the command,
    // alongside shared (`contextConfig`) flags.
    const childInherited = [
      ...inheritedParams,
      ...internals.contextConfig.flags,
      ...legacyUserGlobalFlagParams(command),
    ];
    for (const child of children) {
      const childPath = [...commandPath, child.name];
      const childId = childPath.join("-");
      if (LEGACY_DOCS_EXCLUDED.has(childId)) {
        skippedExcludedIds.add(childId);
        continue;
      }
      visit(child, childPath, childInherited);
    }
  };

  for (const child of legacyDocsVisibleChildren(input.root)) {
    const childPath = ["supabase", child.name];
    const childId = childPath.join("-");
    if (LEGACY_DOCS_EXCLUDED.has(childId)) {
      skippedExcludedIds.add(childId);
      continue;
    }
    visit(child, childPath, []);
  }

  legacyValidateDocsTables({ emittedIds, skippedExcludedIds, seenFlagKeys });

  return {
    clispec: "001",
    info: {
      id: "cli",
      version: input.version,
      title: "Supabase CLI",
      language: "sh",
      source: "https://github.com/supabase/cli",
      bugs: "https://github.com/supabase/cli/issues",
      spec: "https://github.com/supabase/spec/cli_v1_commands.yaml",
      description: LEGACY_DOCS_INFO_DESCRIPTION,
      tags: LEGACY_DOCS_INFO_TAGS,
    },
    flags: rootFlags,
    commands,
  };
}

/**
 * Serializes the spec for publication. Emitted under YAML 1.1 quoting rules
 * so scalars like `yes`/`no` stay strings for downstream YAML 1.1 parsers
 * (PyYAML, Psych, go-yaml v2); the output remains equally valid YAML 1.2.
 */
export function legacyStringifyDocsSpec(spec: LegacyDocsSpec): string {
  return stringify(spec, { indent: 2, lineWidth: 0, version: "1.1" });
}

/**
 * Fails the build when any static-table key no longer resolves against the
 * walked tree — the guard that keeps the frozen tables honest after a
 * command or flag rename, since nothing else cross-checks them once the Go
 * generator is gone.
 */
function legacyValidateDocsTables(seen: {
  readonly emittedIds: ReadonlySet<string>;
  readonly skippedExcludedIds: ReadonlySet<string>;
  readonly seenFlagKeys: ReadonlySet<string>;
}): void {
  const stale: Array<string> = [];
  for (const key of Object.keys(LEGACY_DOCS_DEFAULT_OVERRIDES)) {
    if (!seen.seenFlagKeys.has(key)) stale.push(`LEGACY_DOCS_DEFAULT_OVERRIDES: "${key}"`);
  }
  for (const id of Object.keys(LEGACY_DOCS_TAGS)) {
    if (!seen.emittedIds.has(id)) stale.push(`LEGACY_DOCS_TAGS: "${id}"`);
  }
  for (const id of LEGACY_DOCS_EXPERIMENTAL) {
    if (!seen.emittedIds.has(id)) stale.push(`LEGACY_DOCS_EXPERIMENTAL: "${id}"`);
  }
  for (const id of LEGACY_DOCS_EXPERIMENTAL_OPTIONAL) {
    if (!seen.emittedIds.has(id)) stale.push(`LEGACY_DOCS_EXPERIMENTAL_OPTIONAL: "${id}"`);
  }
  for (const key of Object.keys(LEGACY_DOCS_CHOICE_OVERRIDES)) {
    if (!seen.seenFlagKeys.has(key)) stale.push(`LEGACY_DOCS_CHOICE_OVERRIDES: "${key}"`);
  }
  for (const id of Object.keys(LEGACY_DOCS_EXTRA_FLAGS)) {
    if (!seen.emittedIds.has(id)) stale.push(`LEGACY_DOCS_EXTRA_FLAGS: "${id}"`);
  }
  for (const id of LEGACY_DOCS_EXCLUDED) {
    if (!seen.skippedExcludedIds.has(id)) stale.push(`LEGACY_DOCS_EXCLUDED: "${id}"`);
  }
  for (const key of LEGACY_DOCS_REQUIRED) {
    if (!seen.seenFlagKeys.has(key)) stale.push(`LEGACY_DOCS_REQUIRED: "${key}"`);
  }
  if (stale.length > 0) {
    throw new Error(
      `legacy-docs-spec.ts: stale static-table entries no longer resolve against the command tree — fix or remove them:\n  ${stale.join("\n  ")}`,
    );
  }
}
