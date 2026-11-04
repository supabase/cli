import { Option } from "effect";
import { stringify } from "yaml";
import { Command, Completions, GlobalFlag, Param } from "effect/cli";
import { DOCS_CATEGORIES, readCommandDocs } from "./command-docs.ts";
import type { CommandDocs, DocsCategory } from "./command-docs.ts";
import type { BreakingChange } from "./breaking-changes/define.ts";
import { commandIdOf, docsBreakingChangesFor, migrationGuideMdx } from "./breaking-changes/emit.ts";
import type { DocsBreakingChange } from "./breaking-changes/emit.ts";
import { paramDocsOf, registeredParams } from "../shared/cli/cli-params.ts";
import type { ParamDocs } from "../shared/cli/cli-params.ts";
import {
  DOCS_CATEGORY,
  DOCS_CHOICE_OVERRIDES,
  DOCS_EXCLUDED,
  DOCS_EXCLUDED_FLAGS,
  DOCS_EXPERIMENTAL,
  DOCS_EXPERIMENTAL_OPTIONAL,
  DOCS_EXTRA_FLAGS,
  DOCS_INFO_DESCRIPTION,
  DOCS_INFO_TAGS,
  DOCS_TAGS,
} from "./docs-spec.tables.ts";
import type { DocsInfoTag } from "./docs-spec.tables.ts";

/**
 * Builds the `clispec 002` document consumed by the supabase.com CLI reference
 * (`apps/docs/spec/cli_<major>_commands.yaml`) and its sidebar sections from the Effect command
 * tree. A command's `id` is its `CommandPath` joined by dashes — the public URL slug and the
 * sections join key.
 *
 * Command metadata comes from `withDocs` first and the static tables second. Flags and arguments
 * take their structure from `Completions.fromCommand` and everything else from the `ParamDocs`
 * their `cli-params.ts` constructor recorded, joined by name through the command's registered
 * params.
 * Every static-table key and content input is validated against the walked tree at build time,
 * failing the build on stale entries instead of silently degrading the reference.
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
  readonly breaking_changes?: ReadonlyArray<DocsBreakingChange>;
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
  readonly prerelease?: boolean;
  readonly info: DocsInfo;
  readonly flags: ReadonlyArray<DocsFlag>;
  readonly commands: ReadonlyArray<DocsCommand>;
}

interface DocsMarkdownSection {
  readonly title: string;
  readonly id: string;
  readonly slug: string;
  readonly isFunc: false;
  readonly type: "markdown";
}

interface DocsCommandSection {
  readonly id: string;
  readonly title: string;
  readonly slug: string;
  readonly type: "cli-command";
}

interface DocsCategorySection {
  readonly type: "category";
  readonly title: string;
  readonly items: ReadonlyArray<DocsCommandSection>;
}

/** One entry of the docs-site sidebar file (`common-cli-sections.json` and its per-major siblings). */
export type DocsSection = DocsMarkdownSection | DocsCategorySection;

export interface DocsBundle {
  readonly spec: DocsSpec;
  readonly sections: ReadonlyArray<DocsSection>;
  /** The generated `migrating-from-v<major - 1>` page; present only when the spec is for a major that has one. */
  readonly migrationGuide?: string;
}

export interface DocsSpecInput {
  readonly root: Command.Command.Any;
  readonly version: string;
  /** Marks the spec as a prerelease major (`next`). */
  readonly prerelease?: boolean;
  /** The CLI major the spec documents; defaults to 2. */
  readonly major?: number;
  /** Registry of breaking changes to report per command; defaults to none. */
  readonly breakingChanges?: ReadonlyArray<BreakingChange>;
  /** Overlay markdown keyed by docs-relative POSIX path, e.g. `supabase/db/push.md`. */
  readonly overlays: ReadonlyMap<string, string>;
  /** Examples keyed by doc id, from `docs/templates/examples.yaml`. */
  readonly examples: Readonly<Record<string, ReadonlyArray<DocsExample>>>;
}

/** Hand-written pages the docs site serves ahead of the command categories. */
const DOCS_INTRO_SECTIONS: ReadonlyArray<DocsMarkdownSection> = [
  {
    title: "Introduction",
    id: "introduction",
    slug: "introduction",
    isFunc: false,
    type: "markdown",
  },
  {
    title: "Global flags",
    id: "global-flags",
    slug: "global-flags",
    isFunc: false,
    type: "markdown",
  },
];

const migrationSection = (major: number): DocsMarkdownSection => ({
  title: `Migrating from v${major - 1}`,
  id: `migrating-from-v${major - 1}`,
  slug: `migrating-from-v${major - 1}`,
  isFunc: false,
  type: "markdown",
});

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

function docsVarname(
  type: Completions.FlagType,
  typeName: string | undefined,
  isVariadic: boolean,
): string | undefined {
  if (typeName !== undefined) return typeName;
  switch (type._tag) {
    case "Boolean":
      return undefined;
    case "Int":
      return "int";
    case "Finite":
      return "float";
    case "Date":
      return "time";
    default:
      return isVariadic ? "strings" : "string";
  }
}

function docsTypeDefault(type: Completions.FlagType, isVariadic: boolean): string {
  if (type._tag === "Boolean") return "false";
  if (isVariadic) return "[]";
  if (type._tag === "Int" || type._tag === "Finite") return "0";
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

/**
 * `--help` shows defaults through a trailing `(default …)` token in the description; the reference
 * carries the default as its own field, so the token is dropped when one is recorded.
 */
function docsStripDefaultToken(description: string, recordedDefault: string | undefined): string {
  return recordedDefault === undefined
    ? description
    : description.replace(/\s*\(default [^)]*\)\.?$/, "");
}

/** `--help` is built into the parser, so its docs are declared here rather than recorded. */
const BUILT_IN_FLAG_DOCS: ReadonlyMap<Param.Any, ParamDocs> = new Map([
  [GlobalFlag.Help.flag, { kind: Param.flagKind, name: "help", required: false, hidden: false }],
]);

function docsOfParam(commandPath: ReadonlyArray<string>, param: Param.Any): ParamDocs {
  const docs = paramDocsOf(param) ?? BUILT_IN_FLAG_DOCS.get(param);
  if (docs === undefined) {
    throw new Error(
      `docs-spec.ts: a param on "${commandPath.join(" ")}" was not built with cliFlag/cliArgument (shared/cli/cli-params.ts), so it has no docs metadata.`,
    );
  }
  return docs;
}

/** The docs of `params` keyed by name, for joining with completion descriptors. */
function docsByName(
  commandPath: ReadonlyArray<string>,
  params: ReadonlyArray<Param.Any>,
  kind: Param.ParamKind,
): ReadonlyMap<string, ParamDocs> {
  return new Map(
    params
      .map((param) => docsOfParam(commandPath, param))
      .filter((docs) => docs.kind === kind)
      .map((docs) => [docs.name, docs]),
  );
}

function lookupDocs(
  commandPath: ReadonlyArray<string>,
  index: ReadonlyMap<string, ParamDocs>,
  name: string,
): ParamDocs {
  const docs = index.get(name);
  if (docs === undefined) {
    throw new Error(
      `docs-spec.ts: "${commandPath.join(" ")}" completion descriptor lists "${name}", which matches none of the command's registered params.`,
    );
  }
  return docs;
}

/**
 * Completion descriptors for flags `Completions.fromCommand` does not reach on its own (global
 * flags), read through the same public walk by wrapping them in a throwaway command.
 */
function describeFlags(
  params: ReadonlyArray<Param.AnyFlag>,
): ReadonlyArray<Completions.FlagDescriptor> {
  const config = Object.fromEntries(params.map((param, index) => [`flag${index}`, param]));
  return Completions.fromCommand(Command.make("flags", config)).flags;
}

/** Doc for one visible flag: structure from its completion descriptor, the rest from its docs. */
function docsFlagFrom(
  commandPath: ReadonlyArray<string>,
  descriptor: Completions.FlagDescriptor,
  docs: ParamDocs,
): DocsFlag {
  const isVariadic = docs.variadicMin !== undefined;
  const overrideKey = `${commandPath.join("-")} ${descriptor.name}`;

  let acceptedValues: ReadonlyArray<DocsAcceptedValue> | undefined;
  let enumType: string | undefined;
  const choices =
    DOCS_CHOICE_OVERRIDES[overrideKey] ??
    (descriptor.type._tag === "Choice" ? descriptor.type.values : undefined);
  if (choices !== undefined) {
    enumType = docsEnumTypeString(choices);
    const type = enumType;
    acceptedValues = choices.map((value) => ({ id: value, name: value, type }));
  }

  const varname = enumType ?? docsVarname(descriptor.type, docs.metavar, isVariadic);

  const shorthand = descriptor.aliases.find((alias) => alias.length === 1);
  // A boolean flag with a value hint takes an optional `=value`, as `--remote` does.
  const longName =
    descriptor.type._tag === "Boolean" && docs.metavar !== undefined
      ? `${descriptor.name}[=${docs.metavar}]`
      : `${descriptor.name}${varname === undefined ? "" : ` <${varname}>`}`;
  const name = `${shorthand === undefined ? "" : `-${shorthand}, `}--${longName}`;

  return {
    id: descriptor.name,
    name,
    description: docsNormalizeText(
      docsStripDefaultToken(descriptor.description ?? "", docs.default),
    ),
    ...(docs.required ? { required: true } : {}),
    default_value: docs.default ?? docsTypeDefault(descriptor.type, isVariadic),
    ...(acceptedValues === undefined ? {} : { accepted_values: acceptedValues }),
  };
}

/** Docs for the visible flags among `params`, in declaration order; hidden flags are dropped. */
function docsFlagsOf(
  commandPath: ReadonlyArray<string>,
  params: ReadonlyArray<Param.AnyFlag>,
): ReadonlyArray<DocsFlag> {
  const index = docsByName(commandPath, params, Param.flagKind);
  return describeFlags(params).map((descriptor) =>
    docsFlagFrom(commandPath, descriptor, lookupDocs(commandPath, index, descriptor.name)),
  );
}

/** Doc for one flag param on `commandPath`; `undefined` when the flag is hidden. */
export function docsFlagDoc(
  commandPath: ReadonlyArray<string>,
  param: Param.AnyFlag,
): DocsFlag | undefined {
  return docsFlagsOf(commandPath, [param])[0];
}

function docsArgumentUsage(
  descriptor: Completions.ArgumentDescriptor,
  docs: ParamDocs,
): string | undefined {
  if (docs.hidden) return undefined;
  const rendered = docs.required ? `<${descriptor.name}>` : `[${descriptor.name}]`;
  return docs.variadicMin === undefined ? rendered : `${rendered} ...`;
}

function docsVisibleChildren(command: Command.Command.Any): ReadonlyArray<Command.Command.Any> {
  return command.subcommands
    .flatMap((group) => group.commands)
    .filter((child) => !child.unlisted)
    .toSorted((a, b) => docsCompare(a.name, b.name));
}

function docsChildDescriptor(
  descriptor: Completions.CommandDescriptor,
  childPath: ReadonlyArray<string>,
): Completions.CommandDescriptor {
  const name = childPath.at(-1);
  const child = descriptor.subcommands.find((candidate) => candidate.name === name);
  if (child === undefined) {
    throw new Error(
      `docs-spec.ts: Completions.fromCommand has no descriptor for listed command "${childPath.join(" ")}".`,
    );
  }
  return child;
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

function docsOf(command: Command.Command.Any): CommandDocs | undefined {
  return Option.getOrUndefined(readCommandDocs(command));
}

/** Fails when a `withDocs` field and its legacy table or content source both describe `docId`. */
function assertSingleSource(docId: string, field: string, legacy: string, both: boolean): void {
  if (both) {
    throw new Error(
      `docs-spec.ts: "${docId}" sets withDocs ${field} and still has a ${legacy} entry; remove the ${legacy} entry.`,
    );
  }
}

/** Builds the spec alone; see {@link buildDocsBundle}. */
export function buildDocsSpec(input: DocsSpecInput): DocsSpec {
  return buildDocsBundle(input).spec;
}

/** Builds the `clispec 002` spec and the sidebar sections that index it. */
export function buildDocsBundle(input: DocsSpecInput): DocsBundle {
  const major = input.major ?? 2;
  const registry = input.breakingChanges ?? [];
  const rootPath = ["supabase"];
  const rootFlags = docsFlagsOf(rootPath, [
    ...registeredParams(input.root).global,
    GlobalFlag.Help.flag,
  ]).toSorted((a, b) => docsCompare(a.id, b.id));
  const experimentalFlag = docsExperimentalFlag(rootFlags);
  const { required: _experimentalRequired, ...experimentalOptionalFlag } = experimentalFlag;
  const rootFlagIds = new Set(rootFlags.map((flag) => flag.id));

  const commands: Array<DocsCommand> = [];
  const categories = new Map<string, DocsCategory>();
  const emittedIds = new Set<string>();
  const skippedExcludedIds = new Set<string>();
  const seenFlagKeys = new Set<string>(rootFlags.map((flag) => `supabase ${flag.id}`));
  const consumedExcludedFlagKeys = new Set<string>();
  const consumedExtraFlagIds = new Set<string>();
  const consumedExperimentalIds = new Set<string>();
  const consumedCategoryIds = new Set<string>();
  const consumedOverlayPaths = new Set<string>();
  const allowedOrphanOverlayPaths = new Set<string>();

  /** Drops `DOCS_EXCLUDED_FLAGS` entries and sorts by id. */
  const publishedFlags = (docId: string, flags: ReadonlyArray<DocsFlag>): ReadonlyArray<DocsFlag> =>
    flags
      .filter((flag) => {
        const key = `${docId} ${flag.id}`;
        if (DOCS_EXCLUDED_FLAGS.has(key)) {
          consumedExcludedFlagKeys.add(key);
          return false;
        }
        return true;
      })
      .toSorted((a, b) => docsCompare(a.id, b.id));

  /** Deprecated children are kept out of the reference and their parent's subcommand list. */
  const isExcluded = (child: Command.Command.Any, childPath: ReadonlyArray<string>): boolean => {
    const childId = childPath.join("-");
    const fromTable = DOCS_EXCLUDED.has(childId);
    const fromDocs = docsOf(child)?.deprecated !== undefined;
    assertSingleSource(childId, "deprecated", "DOCS_EXCLUDED", fromTable && fromDocs);
    if (fromTable) skippedExcludedIds.add(childId);
    if (fromTable || fromDocs) allowedOrphanOverlayPaths.add(docsOverlayPath(childPath));
    return fromTable || fromDocs;
  };

  interface Inherited {
    /** Ancestors' `withSharedFlags` params, which the descriptor already lists after local flags. */
    readonly shared: ReadonlyArray<Param.AnyFlag>;
    /** Non-root ancestors' own global flags (e.g. `seed`'s `--remote`), absent from descriptors. */
    readonly global: ReadonlyArray<Param.AnyFlag>;
    readonly category: DocsCategory | undefined;
  }

  const visit = (
    command: Command.Command.Any,
    descriptor: Completions.CommandDescriptor,
    commandPath: ReadonlyArray<string>,
    inherited: Inherited,
  ): void => {
    const docId = commandPath.join("-");
    const docs = docsOf(command);
    const children = docsVisibleChildren(command);
    const registered = registeredParams(command);
    const isLeaf = children.length === 0;
    emittedIds.add(docId);

    const tableCategory = DOCS_CATEGORY[docId];
    if (tableCategory !== undefined) consumedCategoryIds.add(docId);
    assertSingleSource(
      docId,
      "category",
      "DOCS_CATEGORY",
      docs !== undefined && tableCategory !== undefined,
    );
    const category = docs?.category ?? tableCategory ?? inherited.category;
    if (category === undefined) {
      throw new Error(
        `docs-spec.ts: command "${docId}" has no docs category — add withDocs({ category }) to it or a DOCS_CATEGORY entry for its top-level command.`,
      );
    }
    categories.set(docId, category);

    const overlayPath = docsOverlayPath(commandPath);
    const overlay = input.overlays.get(overlayPath);
    if (overlay !== undefined) consumedOverlayPaths.add(overlayPath);
    assertSingleSource(
      docId,
      "body",
      "docs/supabase overlay",
      docs?.body !== undefined && overlay !== undefined,
    );
    const description = docsNormalizeText(
      docs?.body ??
        (overlay === undefined ? (command.description ?? "") : docsStripOverlayHeading(overlay)),
    );

    const flags: Array<DocsFlag> = [];
    if (isLeaf) {
      const localIndex = docsByName(commandPath, registered.own, Param.flagKind);
      const sharedIndex = docsByName(commandPath, inherited.shared, Param.flagKind);
      const declared = publishedFlags(
        docId,
        descriptor.flags
          .filter((flag) => localIndex.has(flag.name))
          .map((flag) =>
            docsFlagFrom(commandPath, flag, lookupDocs(commandPath, localIndex, flag.name)),
          ),
      );
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

      const experimentalInTable = DOCS_EXPERIMENTAL.has(docId);
      assertSingleSource(
        docId,
        "experimental",
        "DOCS_EXPERIMENTAL",
        docs?.experimental !== undefined && experimentalInTable,
      );
      if (experimentalInTable) consumedExperimentalIds.add(docId);
      if (docs?.experimental ?? experimentalInTable) flags.push(experimentalFlag);
      if (DOCS_EXPERIMENTAL_OPTIONAL.has(docId)) {
        consumedExperimentalIds.add(docId);
        flags.push(experimentalOptionalFlag);
      }

      const ownIds = new Set(own.map((flag) => flag.id));
      const inheritedFlags = publishedFlags(docId, [
        ...descriptor.flags
          .filter((flag) => !localIndex.has(flag.name))
          .map((flag) =>
            docsFlagFrom(commandPath, flag, lookupDocs(commandPath, sharedIndex, flag.name)),
          ),
        ...docsFlagsOf(commandPath, inherited.global),
      ]).filter((flag) => !ownIds.has(flag.id) && !rootFlagIds.has(flag.id));
      inheritedFlags.forEach((flag) => seenFlagKeys.add(`${docId} ${flag.id}`));
      flags.push(...inheritedFlags);
    }

    let usage: string | undefined;
    if (isLeaf) {
      const argIndex = docsByName(commandPath, registered.own, Param.argumentKind);
      const argUsages = descriptor.arguments
        .map((argument) =>
          docsArgumentUsage(argument, lookupDocs(commandPath, argIndex, argument.name)),
        )
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
    assertSingleSource(
      docId,
      "examples",
      "examples.yaml",
      docs?.examples !== undefined && fromYaml !== undefined,
    );
    const commandExamples =
      docs?.examples !== undefined
        ? docs.examples.map((example) => ({
            id: example.id,
            name: example.name ?? example.code,
            code: example.code,
            ...(example.response === undefined ? {} : { response: example.response }),
          }))
        : fromYaml !== undefined && fromYaml.length > 0
          ? fromYaml
          : command.examples.length > 0
            ? command.examples.map((example, index) => ({
                id: `example-${index + 1}`,
                name: example.description ?? example.command,
                code: example.command,
              }))
            : undefined;

    const visibleChildren = children.filter(
      (child) => !isExcluded(child, [...commandPath, child.name]),
    );
    const breakingChanges = docsBreakingChangesFor(registry, docId, major);
    commands.push({
      id: docId,
      title: commandPath.join(" "),
      summary: docsSummary(command),
      description,
      ...(commandExamples === undefined ? {} : { examples: commandExamples }),
      tags: tags ?? [],
      links: [],
      ...(usage === undefined ? {} : { usage }),
      subcommands: visibleChildren.map((child) => [...commandPath, child.name].join("-")),
      flags,
      ...(breakingChanges.length === 0 ? {} : { breaking_changes: breakingChanges }),
    });

    const childInherited: Inherited = {
      shared: [...inherited.shared, ...registered.shared],
      global: [...inherited.global, ...registered.global],
      category,
    };
    for (const child of visibleChildren) {
      const childPath = [...commandPath, child.name];
      visit(child, docsChildDescriptor(descriptor, childPath), childPath, childInherited);
    }
  };

  const rootDescriptor = Completions.fromCommand(input.root);
  for (const child of docsVisibleChildren(input.root)) {
    const childPath = ["supabase", child.name];
    if (isExcluded(child, childPath)) continue;
    visit(child, docsChildDescriptor(rootDescriptor, childPath), childPath, {
      shared: [],
      global: [],
      category: undefined,
    });
  }

  validateDocsTables({
    emittedIds,
    skippedExcludedIds,
    seenFlagKeys,
    consumedExcludedFlagKeys,
    consumedExtraFlagIds,
    consumedExperimentalIds,
    consumedCategoryIds,
  });
  for (const change of registry) {
    for (const command of change.commands) {
      if (!emittedIds.has(commandIdOf(command))) {
        throw new Error(
          `docs-spec.ts: breaking change "${change.id}" lists "${command}", which is not a published command.`,
        );
      }
    }
  }
  validateDocsContent(input, {
    emittedIds,
    skippedExcludedIds,
    consumedOverlayPaths,
    allowedOrphanOverlayPaths,
  });

  const spec: DocsSpec = {
    clispec: "002",
    ...(input.prerelease === true ? { prerelease: true } : {}),
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
  const guideChanges = registry.filter((change) => change.major === major);
  const hasGuide = guideChanges.length > 0;
  return {
    spec,
    sections: buildDocsSections(commands, categories, hasGuide ? major : undefined),
    ...(hasGuide ? { migrationGuide: migrationGuideMdx(major, guideChanges) } : {}),
  };
}

/** Intro pages, then one category per `DOCS_CATEGORIES` entry in order, listing its commands in tree order. */
function buildDocsSections(
  commands: ReadonlyArray<DocsCommand>,
  categories: ReadonlyMap<string, DocsCategory>,
  guideMajor: number | undefined,
): ReadonlyArray<DocsSection> {
  const categorySections = Object.entries(DOCS_CATEGORIES)
    .toSorted(([, a], [, b]) => a.order - b.order)
    .flatMap(([category, { title }]): ReadonlyArray<DocsCategorySection> => {
      const items = commands
        .filter((command) => categories.get(command.id) === category)
        .map((command) => ({
          id: command.id,
          title: command.title,
          slug: command.id,
          type: "cli-command" as const,
        }));
      return items.length === 0 ? [] : [{ type: "category", title, items }];
    });
  return [
    ...DOCS_INTRO_SECTIONS,
    ...(guideMajor === undefined ? [] : [migrationSection(guideMajor)]),
    ...categorySections,
  ];
}

/** Serializes the sidebar sections as the docs repo stores them. */
export function stringifyDocsSections(sections: ReadonlyArray<DocsSection>): string {
  return `${JSON.stringify(sections, null, 2)}\n`;
}

/**
 * Serializes the spec for publication. Uses YAML 1.1 quoting so scalars like `yes`/`no` stay
 * strings for downstream YAML 1.1 parsers (PyYAML, Psych); the output remains
 * valid YAML 1.2. Anchors/aliases are disabled since the injected `--experimental` doc is the
 * same object on every experimental leaf, and the serializer would otherwise emit `&a1`/`*a1`
 * references the published file never carried.
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
 * Fails the build when any static-table key no longer resolves against the walked tree — the
 * guard that keeps the frozen tables honest after a command or flag rename.
 */
function validateDocsTables(seen: {
  readonly emittedIds: ReadonlySet<string>;
  readonly skippedExcludedIds: ReadonlySet<string>;
  readonly seenFlagKeys: ReadonlySet<string>;
  readonly consumedExcludedFlagKeys: ReadonlySet<string>;
  readonly consumedExtraFlagIds: ReadonlySet<string>;
  readonly consumedExperimentalIds: ReadonlySet<string>;
  readonly consumedCategoryIds: ReadonlySet<string>;
}): void {
  const stale: Array<string> = [];
  for (const id of Object.keys(DOCS_TAGS)) {
    if (!seen.emittedIds.has(id)) stale.push(`DOCS_TAGS: "${id}"`);
  }
  for (const id of Object.keys(DOCS_CATEGORY)) {
    if (!seen.consumedCategoryIds.has(id)) stale.push(`DOCS_CATEGORY: "${id}"`);
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
  for (const key of DOCS_EXCLUDED_FLAGS) {
    if (!seen.consumedExcludedFlagKeys.has(key)) stale.push(`DOCS_EXCLUDED_FLAGS: "${key}"`);
  }
  if (stale.length > 0) {
    throw new Error(
      `docs-spec.ts: stale static-table entries no longer resolve against the command tree — fix or remove them:\n  ${stale.join("\n  ")}`,
    );
  }
}

/**
 * Extends the build-fails-on-drift guarantee to content inputs: an overlay or `examples.yaml`
 * doc id matching no emitted command would otherwise vanish from the published reference
 * silently. Overlays belonging to `DOCS_EXCLUDED` commands stay allowed as orphans until their
 * pages are removed.
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
