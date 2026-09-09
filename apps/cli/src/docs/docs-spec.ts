import { Option } from "effect";
import { stringify } from "yaml";
import { GlobalFlag } from "effect/unstable/cli";
import type { Command, Param } from "effect/unstable/cli";
import {
  choiceKeysOf,
  commandInternals,
  flattenSubcommands,
  userGlobalFlagParams,
} from "./docs-introspection.ts";
import { unwrapParam } from "../command-internal/param-introspection.ts";
import {
  DOCS_ARG_OVERRIDES,
  DOCS_CHOICE_OVERRIDES,
  DOCS_DEFAULT_OVERRIDES,
  DOCS_EXCLUDED,
  DOCS_EXCLUDED_FLAGS,
  DOCS_EXPERIMENTAL,
  DOCS_EXPERIMENTAL_OPTIONAL,
  DOCS_EXTRA_FLAGS,
  DOCS_INFO_DESCRIPTION,
  DOCS_INFO_TAGS,
  DOCS_REQUIRED,
  DOCS_TAGS,
} from "./docs-spec.tables.ts";
import type { DocsInfoTag } from "./docs-spec.tables.ts";

/**
 * Builds the `clispec 001` document consumed by the supabase.com CLI
 * reference (`supabase/supabase` `apps/docs/spec/cli_v1_commands.yaml`) from
 * the legacy Effect command tree — replacing the retired Go generator's
 * cobra walk.
 *
 * The load-bearing contract, verified against the retired Go generator's
 * output while both coexisted: command `id` is `CommandPath` with spaces
 * replaced by dashes and is the public URL slug plus the join key into
 * `common-cli-sections.json`; `subcommands`, `flags`, `tags`, `links` are
 * always arrays; `default_value` is always present; flag `name` is a
 * preformatted display string (`-p, --password <string>`); enum flags carry
 * `accepted_values`; experimental leaves append the root `--experimental`
 * flag. All 135 Go command ids, titles, subcommand sets, defaults and
 * accepted values matched; flag sets matched once deprecated flags were
 * excluded (`DOCS_EXCLUDED_FLAGS`).
 *
 * Deliberately NOT reproduced from the Go output:
 * - go-yaml serialization quirks: trailing-newline padding of long strings
 *   and the reversed command order (consumers parse the YAML and join on
 *   `id`);
 * - cobra's `UseLine` rule of appending ` [flags]` only when a command
 *   declares its own local flags — every leaf here accepts flags, so the
 *   suffix is emitted on all leaf usage strings;
 * - cobra's flag ordering where persistent group flags trailed local ones —
 *   flags that were persistent in cobra are own config flags in the Effect
 *   tree and sort alphabetically with the rest;
 * - Go-only scalar display typing (`uint`/`duration`/`time`/`stringArray`) —
 *   flag types render as the Effect tree (and `--help`) declares them;
 * - argument labels in usage strings render the Effect tree's names, which
 *   can differ from Go's hand-written `Use` wording (`[name]` vs
 *   `[project name]`) and are sometimes more precise (`orgs create <name>`,
 *   `functions deploy [Function name] ...`);
 * - TS-only surfaces (commands, flags, examples) are additions by design.
 *
 * Every static-table key (`docs-spec.tables.ts`) and every content
 * input (description overlays, `examples.yaml` entries) is validated against
 * the walked tree at build time — a stale entry after a command or flag
 * rename fails the build with the offending keys listed instead of silently
 * degrading the published reference.
 */

export interface DocsExample {
  readonly id?: string;
  readonly name?: string;
  readonly code?: string;
  readonly response?: string;
}

interface DocsAcceptedValue {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface DocsFlag {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
  readonly default_value: string;
  readonly accepted_values?: ReadonlyArray<DocsAcceptedValue>;
}

export interface DocsCommand {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly description: string;
  readonly examples?: ReadonlyArray<DocsExample>;
  readonly tags: ReadonlyArray<string>;
  readonly links: ReadonlyArray<never>;
  readonly usage?: string;
  readonly subcommands: ReadonlyArray<string>;
  readonly flags: ReadonlyArray<DocsFlag>;
}

interface DocsInfo {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly language: string;
  readonly source: string;
  readonly bugs: string;
  readonly spec: string;
  readonly description: string;
  readonly tags: ReadonlyArray<DocsInfoTag>;
}

export interface DocsSpec {
  readonly clispec: string;
  readonly info: DocsInfo;
  readonly flags: ReadonlyArray<DocsFlag>;
  readonly commands: ReadonlyArray<DocsCommand>;
}

export interface DocsSpecInput {
  readonly root: Command.Command.Any;
  readonly version: string;
  /** Overlay markdown keyed by docs-relative POSIX path, e.g. `supabase/db/push.md`. */
  readonly overlays: ReadonlyMap<string, string>;
  /** Examples keyed by doc id, from `docs/templates/examples.yaml`. */
  readonly examples: Readonly<Record<string, ReadonlyArray<DocsExample>>>;
}

/**
 * Overlay file path for a command path — the layout contract of
 * `docs/supabase/`: one directory per word, except paths deeper than three
 * words flatten the tail into one dash-joined filename
 * (`supabase inspect db bloat` → `supabase/inspect/db-bloat.md`).
 */
export function docsOverlayPath(commandPath: ReadonlyArray<string>): string {
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
export function docsStripOverlayHeading(contents: string): string {
  if (!contents.startsWith("#")) return contents;
  const newline = contents.indexOf("\n");
  return newline === -1 ? "" : contents.slice(newline);
}

/** Locale-independent byte-wise ordering, so the emitted YAML is machine-independent. */
function docsCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const DOCS_ENUM_TYPE_MAX_JOINED_LENGTH = 40;

/**
 * Enum display type: `[ a | b ]` while the joined value list stays under 40
 * characters, otherwise plain `string` — rendered inside `<...>` in the flag
 * name and repeated on each accepted value.
 */
function docsEnumTypeString(choices: ReadonlyArray<string>): string {
  const joined = choices.join(" | ");
  return joined.length < DOCS_ENUM_TYPE_MAX_JOINED_LENGTH ? `[ ${joined} ]` : "string";
}

function docsPrimitiveVarname(
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

function docsTypeDefault(
  single: Param.Single<Param.ParamKind, unknown>,
  isVariadic: boolean,
): string {
  if (single.primitiveType._tag === "Boolean") return "false";
  if (isVariadic) return "[]";
  if (single.primitiveType._tag === "Integer" || single.primitiveType._tag === "Float") return "0";
  return "";
}

/**
 * Descriptions may embed tab-indented shell snippets (the completion
 * family); the published spec has always carried them as four spaces, and
 * tab indentation can stop rendering as a code block downstream.
 */
function docsNormalizeText(text: string): string {
  return text.replaceAll("\t", "    ");
}

/** Doc for a visible flag; `undefined` for hidden flags; throws on an unrecognizable param. */
function docsFlagDoc(
  commandPath: ReadonlyArray<string>,
  param: Param.AnyFlag,
): DocsFlag | undefined {
  const unwrapped = unwrapParam(param);
  if (unwrapped === undefined) {
    throw new Error(
      `docs-spec.ts: a flag on "${commandPath.join(" ")}" wraps an unrecognized Param variant — effect's Param union may have changed; the spec cannot be built without dropping it silently.`,
    );
  }
  const { single, isVariadic } = unwrapped;
  if (single.hidden) return undefined;

  const docId = commandPath.join("-");
  const overrideKey = `${docId} ${single.name}`;

  let acceptedValues: ReadonlyArray<DocsAcceptedValue> | undefined;
  let enumType: string | undefined;
  const choices = DOCS_CHOICE_OVERRIDES[overrideKey] ?? choiceKeysOf(single.primitiveType);
  if (choices !== undefined) {
    enumType = docsEnumTypeString(choices);
    const type = enumType;
    acceptedValues = choices.map((value) => ({ id: value, name: value, type }));
  }

  const varname = enumType ?? docsPrimitiveVarname(single, isVariadic);

  const shorthand = single.aliases.find((alias) => alias.length === 1);
  const name = `${shorthand === undefined ? "" : `-${shorthand}, `}--${single.name}${
    varname === undefined ? "" : ` <${varname}>`
  }`;

  const required = DOCS_REQUIRED.has(overrideKey);

  return {
    id: single.name,
    name,
    description: docsNormalizeText(Option.getOrElse(single.description, () => "")),
    ...(required ? { required: true } : {}),
    default_value: DOCS_DEFAULT_OVERRIDES[overrideKey] ?? docsTypeDefault(single, isVariadic),
    ...(acceptedValues === undefined ? {} : { accepted_values: acceptedValues }),
  };
}

function docsArgumentUsage(
  commandPath: ReadonlyArray<string>,
  param: Param.AnyArgument,
): string | undefined {
  const unwrapped = unwrapParam(param);
  if (unwrapped === undefined) {
    throw new Error(
      `docs-spec.ts: an argument on "${commandPath.join(" ")}" wraps an unrecognized Param variant — effect's Param union may have changed; the spec cannot be built without dropping it silently.`,
    );
  }
  const { single, isOptional, isVariadic, variadicMin } = unwrapped;
  if (single.hidden) return undefined;
  const optional = isOptional || (isVariadic && variadicMin === 0);
  const rendered = optional ? `[${single.name}]` : `<${single.name}>`;
  return isVariadic ? `${rendered} ...` : rendered;
}

function docsVisibleChildren(command: Command.Command.Any): ReadonlyArray<Command.Command.Any> {
  return flattenSubcommands(command)
    .filter((child) => !child.unlisted)
    .toSorted((a, b) => docsCompare(a.name, b.name));
}

/** First line of a command's long description, for the listing summary fallback. */
function docsSummary(command: Command.Command.Any): string {
  if (command.shortDescription !== undefined) return command.shortDescription;
  const description = command.description ?? "";
  const newline = description.indexOf("\n");
  return newline === -1 ? description : description.slice(0, newline);
}

/** The root `--experimental` flag doc injected into experimental leaves. */
function docsExperimentalFlag(rootFlags: ReadonlyArray<DocsFlag>): DocsFlag {
  const experimental = rootFlags.find((flag) => flag.id === "experimental");
  if (experimental === undefined) {
    throw new Error(
      "docs-spec.ts: the root command tree declares no --experimental global flag; the experimental-leaf injection cannot be built.",
    );
  }
  // `required` before `default_value`, matching every other required flag.
  return {
    id: experimental.id,
    name: experimental.name,
    description: experimental.description,
    required: true,
    default_value: experimental.default_value,
    ...(experimental.accepted_values === undefined
      ? {}
      : { accepted_values: experimental.accepted_values }),
  };
}

export function buildDocsSpec(input: DocsSpecInput): DocsSpec {
  const rootPath = ["supabase"];
  const rootFlagParams: ReadonlyArray<Param.AnyFlag> = [
    ...userGlobalFlagParams(input.root),
    GlobalFlag.Help.flag,
  ];
  const rootFlags = rootFlagParams
    .map((param) => docsFlagDoc(rootPath, param))
    .filter((flag) => flag !== undefined)
    .toSorted((a, b) => docsCompare(a.id, b.id));
  const experimentalFlag = docsExperimentalFlag(rootFlags);
  const { required: _experimentalRequired, ...experimentalOptionalFlag } = experimentalFlag;
  const rootFlagIds = new Set(rootFlags.map((flag) => flag.id));

  const commands: Array<DocsCommand> = [];
  const emittedIds = new Set<string>();
  const skippedExcludedIds = new Set<string>();
  const seenFlagKeys = new Set<string>(rootFlags.map((flag) => `supabase ${flag.id}`));
  const consumedExcludedFlagKeys = new Set<string>();
  const consumedArgOverrideIds = new Set<string>();
  const consumedExtraFlagIds = new Set<string>();
  const consumedExperimentalIds = new Set<string>();
  const consumedOverlayPaths = new Set<string>();
  const allowedOrphanOverlayPaths = new Set<string>();

  /**
   * Builds the visible flag docs for a command's params, dropping hidden
   * flags and `DOCS_EXCLUDED_FLAGS` entries (deprecated flags cobra
   * hid from the reference). Does NOT record `seenFlagKeys` — callers record
   * only the flags that actually reach the output, so table validation
   * reflects the published spec, not intermediate candidates.
   */
  const flagDocsFor = (
    commandPath: ReadonlyArray<string>,
    params: ReadonlyArray<Param.AnyFlag>,
  ): ReadonlyArray<DocsFlag> => {
    const docId = commandPath.join("-");
    return params
      .map((param) => docsFlagDoc(commandPath, param))
      .filter((flag) => flag !== undefined)
      .filter((flag) => {
        const key = `${docId} ${flag.id}`;
        if (DOCS_EXCLUDED_FLAGS.has(key)) {
          consumedExcludedFlagKeys.add(key);
          return false;
        }
        return true;
      })
      .toSorted((a, b) => docsCompare(a.id, b.id));
  };

  const visit = (
    command: Command.Command.Any,
    commandPath: ReadonlyArray<string>,
    inheritedParams: ReadonlyArray<Param.AnyFlag>,
  ): void => {
    const docId = commandPath.join("-");
    const children = docsVisibleChildren(command);
    const internals = commandInternals(command);
    const isLeaf = children.length === 0;
    emittedIds.add(docId);

    const overlayPath = docsOverlayPath(commandPath);
    const overlay = input.overlays.get(overlayPath);
    if (overlay !== undefined) consumedOverlayPaths.add(overlayPath);
    const description = docsNormalizeText(
      overlay === undefined ? (command.description ?? "") : docsStripOverlayHeading(overlay),
    );

    const flags: Array<DocsFlag> = [];
    if (isLeaf) {
      const declared = flagDocsFor(commandPath, internals.config.flags);
      const declaredIds = new Set(declared.map((flag) => flag.id));
      const extraFlags = DOCS_EXTRA_FLAGS[docId];
      if (extraFlags !== undefined) {
        consumedExtraFlagIds.add(docId);
        const shadowed = extraFlags.filter((flag) => declaredIds.has(flag.id));
        if (shadowed.length > 0) {
          throw new Error(
            `docs-spec.ts: DOCS_EXTRA_FLAGS entry "${docId}" is shadowed by declared flag(s) ${shadowed.map((flag) => `--${flag.id}`).join(", ")} — the command now declares the flag itself; remove the stale table entry.`,
          );
        }
      }
      const own = [...declared, ...(extraFlags ?? [])].toSorted((a, b) => docsCompare(a.id, b.id));
      own.forEach((flag) => seenFlagKeys.add(`${docId} ${flag.id}`));
      flags.push(...own);
      if (DOCS_EXPERIMENTAL.has(docId)) {
        consumedExperimentalIds.add(docId);
        flags.push(experimentalFlag);
      }
      if (DOCS_EXPERIMENTAL_OPTIONAL.has(docId)) {
        consumedExperimentalIds.add(docId);
        flags.push(experimentalOptionalFlag);
      }
      const ownIds = new Set(own.map((flag) => flag.id));
      const inherited = flagDocsFor(commandPath, inheritedParams).filter(
        (flag) => !ownIds.has(flag.id) && !rootFlagIds.has(flag.id),
      );
      inherited.forEach((flag) => seenFlagKeys.add(`${docId} ${flag.id}`));
      flags.push(...inherited);
    }

    let usage: string | undefined;
    if (isLeaf) {
      const argOverride = DOCS_ARG_OVERRIDES[docId];
      if (argOverride !== undefined) consumedArgOverrideIds.add(docId);
      const argUsages =
        argOverride !== undefined
          ? [argOverride]
          : internals.config.arguments
              .map((param) => docsArgumentUsage(commandPath, param))
              .filter((part) => part !== undefined);
      usage = [...commandPath, ...argUsages, "[flags]"].join(" ");
    }

    const tags = DOCS_TAGS[docId];
    if (tags === undefined && commandPath.length === 2) {
      throw new Error(
        `docs-spec.ts: top-level command "${docId}" has no DOCS_TAGS entry — add its docs-site section tag (or "other-commands") to docs-spec.tables.ts.`,
      );
    }

    const fromYaml = input.examples[docId];
    const commandExamples =
      fromYaml !== undefined && fromYaml.length > 0
        ? fromYaml
        : command.examples.length > 0
          ? command.examples.map((example, index) => ({
              id: `example-${index + 1}`,
              name: example.description ?? example.command,
              code: example.command,
            }))
          : undefined;

    commands.push({
      id: docId,
      title: commandPath.join(" "),
      summary: docsSummary(command),
      description,
      ...(commandExamples === undefined ? {} : { examples: commandExamples }),
      tags: tags ?? [],
      links: [],
      ...(usage === undefined ? {} : { usage }),
      subcommands: children
        .map((child) => [...commandPath, child.name].join("-"))
        .filter((childId) => !DOCS_EXCLUDED.has(childId)),
      flags,
    });

    // A non-root command's scoped global flags (`Command.withGlobalFlags`
    // below root, e.g. `seed`'s `--linked`/`--local`) behave like persistent
    // flags: the reference surfaces them on every leaf beneath the command,
    // alongside shared (`contextConfig`) flags.
    const childInherited = [
      ...inheritedParams,
      ...internals.contextConfig.flags,
      ...userGlobalFlagParams(command),
    ];
    for (const child of children) {
      const childPath = [...commandPath, child.name];
      const childId = childPath.join("-");
      if (DOCS_EXCLUDED.has(childId)) {
        skippedExcludedIds.add(childId);
        allowedOrphanOverlayPaths.add(docsOverlayPath(childPath));
        continue;
      }
      visit(child, childPath, childInherited);
    }
  };

  for (const child of docsVisibleChildren(input.root)) {
    const childPath = ["supabase", child.name];
    const childId = childPath.join("-");
    if (DOCS_EXCLUDED.has(childId)) {
      skippedExcludedIds.add(childId);
      allowedOrphanOverlayPaths.add(docsOverlayPath(childPath));
      continue;
    }
    visit(child, childPath, []);
  }

  validateDocsTables({
    emittedIds,
    skippedExcludedIds,
    seenFlagKeys,
    consumedExcludedFlagKeys,
    consumedArgOverrideIds,
    consumedExtraFlagIds,
    consumedExperimentalIds,
  });
  validateDocsContent(input, {
    emittedIds,
    skippedExcludedIds,
    consumedOverlayPaths,
    allowedOrphanOverlayPaths,
  });

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
      description: DOCS_INFO_DESCRIPTION,
      tags: DOCS_INFO_TAGS,
    },
    flags: rootFlags,
    commands,
  };
}

/**
 * Serializes the spec for publication. Emitted under YAML 1.1 quoting rules
 * so scalars like `yes`/`no` stay strings for downstream YAML 1.1 parsers
 * (PyYAML, Psych, go-yaml v2); the output remains equally valid YAML 1.2.
 * Anchors/aliases are disabled — the injected `--experimental` doc is the
 * same object on every experimental leaf, and the serializer would otherwise
 * emit `&a1`/`*a1` references the published file never carried.
 */
export function stringifyDocsSpec(spec: DocsSpec): string {
  return stringify(spec, {
    indent: 2,
    lineWidth: 0,
    version: "1.1",
    aliasDuplicateObjects: false,
  });
}

/**
 * Fails the build when any static-table key no longer resolves against the
 * walked tree — the guard that keeps the frozen tables honest after a
 * command or flag rename, since nothing else cross-checks them once the Go
 * generator is gone.
 */
function validateDocsTables(seen: {
  readonly emittedIds: ReadonlySet<string>;
  readonly skippedExcludedIds: ReadonlySet<string>;
  readonly seenFlagKeys: ReadonlySet<string>;
  readonly consumedExcludedFlagKeys: ReadonlySet<string>;
  readonly consumedArgOverrideIds: ReadonlySet<string>;
  readonly consumedExtraFlagIds: ReadonlySet<string>;
  readonly consumedExperimentalIds: ReadonlySet<string>;
}): void {
  const stale: Array<string> = [];
  for (const key of Object.keys(DOCS_DEFAULT_OVERRIDES)) {
    if (!seen.seenFlagKeys.has(key)) stale.push(`DOCS_DEFAULT_OVERRIDES: "${key}"`);
  }
  for (const id of Object.keys(DOCS_TAGS)) {
    if (!seen.emittedIds.has(id)) stale.push(`DOCS_TAGS: "${id}"`);
  }
  for (const id of DOCS_EXPERIMENTAL) {
    if (!seen.consumedExperimentalIds.has(id)) stale.push(`DOCS_EXPERIMENTAL: "${id}"`);
  }
  for (const id of DOCS_EXPERIMENTAL_OPTIONAL) {
    if (!seen.consumedExperimentalIds.has(id)) {
      stale.push(`DOCS_EXPERIMENTAL_OPTIONAL: "${id}"`);
    }
  }
  for (const key of Object.keys(DOCS_CHOICE_OVERRIDES)) {
    if (!seen.seenFlagKeys.has(key)) stale.push(`DOCS_CHOICE_OVERRIDES: "${key}"`);
  }
  for (const id of Object.keys(DOCS_EXTRA_FLAGS)) {
    if (!seen.consumedExtraFlagIds.has(id)) stale.push(`DOCS_EXTRA_FLAGS: "${id}"`);
  }
  for (const id of DOCS_EXCLUDED) {
    if (!seen.skippedExcludedIds.has(id)) stale.push(`DOCS_EXCLUDED: "${id}"`);
  }
  for (const key of DOCS_REQUIRED) {
    if (!seen.seenFlagKeys.has(key)) stale.push(`DOCS_REQUIRED: "${key}"`);
  }
  for (const key of DOCS_EXCLUDED_FLAGS) {
    if (!seen.consumedExcludedFlagKeys.has(key)) stale.push(`DOCS_EXCLUDED_FLAGS: "${key}"`);
  }
  for (const id of Object.keys(DOCS_ARG_OVERRIDES)) {
    if (!seen.consumedArgOverrideIds.has(id)) stale.push(`DOCS_ARG_OVERRIDES: "${id}"`);
  }
  if (stale.length > 0) {
    throw new Error(
      `docs-spec.ts: stale static-table entries no longer resolve against the command tree — fix or remove them:\n  ${stale.join("\n  ")}`,
    );
  }
}

/**
 * Extends the build-fails-on-drift guarantee to the content inputs: an
 * overlay whose path maps to no walked command, or an `examples.yaml` doc id
 * matching no emitted command, would otherwise vanish from the published
 * reference silently (the page falls back to the terse tree description).
 * Overlays belonging to `DOCS_EXCLUDED` commands are deliberate
 * orphans (deprecated pages keep their content until the follow-up cleanup)
 * and stay allowed.
 */
function validateDocsContent(
  input: DocsSpecInput,
  seen: {
    readonly emittedIds: ReadonlySet<string>;
    readonly skippedExcludedIds: ReadonlySet<string>;
    readonly consumedOverlayPaths: ReadonlySet<string>;
    readonly allowedOrphanOverlayPaths: ReadonlySet<string>;
  },
): void {
  const orphaned: Array<string> = [];
  for (const path of input.overlays.keys()) {
    if (!seen.consumedOverlayPaths.has(path) && !seen.allowedOrphanOverlayPaths.has(path)) {
      orphaned.push(`overlay: "${path}"`);
    }
  }
  for (const docId of Object.keys(input.examples)) {
    if (!seen.emittedIds.has(docId) && !seen.skippedExcludedIds.has(docId)) {
      orphaned.push(`examples.yaml: "${docId}"`);
    }
  }
  if (orphaned.length > 0) {
    throw new Error(
      `docs-spec.ts: content inputs match no command in the walked tree — a rename would silently drop them from the published reference:\n  ${orphaned.join("\n  ")}`,
    );
  }
}
