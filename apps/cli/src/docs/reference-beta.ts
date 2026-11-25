import { stringify } from "yaml";
import { DOCS_CATEGORIES } from "./command-docs.ts";
import type { DocsBundle, DocsCommand, DocsExample, DocsFlag } from "./docs-spec.ts";

/**
 * Converts the CLI reference bundle into reference-beta definitions: one Markdown file per
 * published command, YAML frontmatter matching `docs/reference-beta/definition.schema.json`, the
 * page prose as the body. See `docs/README.md#reference-beta-definitions`.
 */

interface ReferenceParameter {
  readonly name: string;
  readonly location: "positional" | "flag";
  readonly type?: string;
  readonly required?: boolean;
  readonly description?: string;
  readonly default?: string | boolean;
  readonly allowed_values?: ReadonlyArray<string>;
  readonly short?: string;
  readonly variadic?: boolean;
}

interface ReferenceExample {
  readonly id: string;
  readonly title: string;
  readonly lang: string;
  readonly code: string;
  readonly response?: string;
}

interface ReferenceDefinition {
  readonly id: string;
  readonly kind: "command";
  readonly category: string;
  readonly subcategory?: string;
  readonly title: string;
  readonly symbol: string;
  readonly summary: string;
  readonly usage?: string;
  readonly stability: "stable" | "experimental";
  readonly deprecated: false;
  readonly inherits_flags: string;
  readonly parameters: ReadonlyArray<ReferenceParameter>;
  readonly examples: ReadonlyArray<ReferenceExample>;
}

export interface ReferenceFile {
  readonly id: string;
  readonly contents: string;
}

/** The flag group every command inherits: the root command's global flags. */
const REFERENCE_GLOBAL_FLAG_GROUP = "global";

/** Matches the flag names `docsFlagFrom` renders: `-s, --name <type>`, `--name[=hint]` or `--name`. */
const FLAG_NAME = /^(?:-(\w), )?--([\w-]+)(?:\[=([^\]]+)\]| <(.+)>)?$/;

function flagParameter(flag: DocsFlag): ReferenceParameter {
  const match = FLAG_NAME.exec(flag.name);
  if (match === null) {
    throw new Error(`reference-beta.ts: unrecognised flag name "${flag.name}".`);
  }
  const [, short, , optionalValue, value] = match;
  const isBoolean = value === undefined;
  const type = isBoolean ? "boolean" : value;
  const variadic = flag.default_value === "[]" || value === "strings";
  const defaultValue = isBoolean ? flag.default_value === "true" : flag.default_value;
  return {
    name: `--${flag.id}`,
    location: "flag",
    type:
      optionalValue === undefined ? type : `boolean | ${optionalValue.replace(/^<(.*)>$/, "$1")}`,
    ...(flag.required === true ? { required: true } : {}),
    ...(flag.description === "" ? {} : { description: flag.description }),
    ...(defaultValue === "" || defaultValue === "[]" ? {} : { default: defaultValue }),
    ...(flag.accepted_values === undefined
      ? {}
      : { allowed_values: flag.accepted_values.map((accepted) => accepted.id) }),
    ...(short === undefined ? {} : { short: `-${short}` }),
    ...(variadic ? { variadic: true } : {}),
  };
}

/** Positionals as `docsArgumentUsage` renders them in the usage line: `<a>`, `[a]`, then `...` when variadic. */
function positionalParameters(usage: string): ReadonlyArray<ReferenceParameter> {
  return [...usage.matchAll(/([<[])([^<>[\]]+)[>\]]( \.\.\.)?/g)]
    .filter(([, , name]) => name !== "flags" && name !== "subcommand")
    .map(([, open, name, ellipsis]) => ({
      name: name ?? "",
      location: "positional",
      required: open === "<",
      ...(ellipsis === undefined ? {} : { variadic: true }),
    }));
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function example(entry: DocsExample, index: number): ReferenceExample {
  const code = entry.code ?? "";
  const title = entry.name ?? code;
  return {
    id: entry.id ?? (slug(title) || `example-${index + 1}`),
    title,
    lang: "sh",
    code,
    ...(entry.response === undefined ? {} : { response: entry.response }),
  };
}

/** Command id to `DOCS_CATEGORIES` title, read from the sidebar sections the bundle groups commands by. */
function categoryIndex(bundle: DocsBundle): ReadonlyMap<string, string> {
  const titles = new Set<string>(Object.values(DOCS_CATEGORIES).map(({ title }) => title));
  const index = new Map<string, string>();
  for (const section of bundle.sections) {
    if (section.type !== "category") continue;
    if (!titles.has(section.title)) continue;
    for (const item of section.items) index.set(item.id, section.title);
  }
  return index;
}

function definitionOf(
  command: DocsCommand,
  category: string,
  groupFamilies: boolean,
): ReferenceDefinition {
  const path = command.title.split(" ");
  const experimental = command.flags.some(
    (flag) => flag.id === "experimental" && flag.required === true,
  );
  return {
    id: command.id.replace(/^supabase-/, ""),
    kind: "command",
    category,
    ...(groupFamilies &&
    path[1] !== undefined &&
    (path.length > 2 || command.subcommands.length > 0)
      ? { subcategory: path[1] }
      : {}),
    title: path.slice(1).join(" "),
    symbol: command.title,
    summary: command.summary,
    ...(command.usage === undefined ? {} : { usage: command.usage }),
    stability: experimental ? "experimental" : "stable",
    deprecated: false,
    inherits_flags: REFERENCE_GLOBAL_FLAG_GROUP,
    parameters: [
      ...(command.usage === undefined ? [] : positionalParameters(command.usage)),
      ...command.flags.map(flagParameter),
    ],
    examples: (command.examples ?? []).map(example),
  };
}

/** One definition file per command in the bundle, sorted by id. */
export function buildReferenceFiles(bundle: DocsBundle): ReadonlyArray<ReferenceFile> {
  const categories = categoryIndex(bundle);
  // A category holding one command family (`backups`) needs no sub-group repeating its name.
  const families = new Map<string, Set<string>>();
  for (const command of bundle.spec.commands) {
    const category = categories.get(command.id);
    if (category === undefined) continue;
    families.set(
      category,
      (families.get(category) ?? new Set()).add(command.title.split(" ")[1] ?? ""),
    );
  }
  const files = bundle.spec.commands.map((command) => {
    const category = categories.get(command.id);
    if (category === undefined) {
      throw new Error(`reference-beta.ts: "${command.id}" is in no sidebar category.`);
    }
    const definition = definitionOf(command, category, (families.get(category)?.size ?? 0) > 1);
    const frontmatter = stringify(definition, { lineWidth: 0, blockQuote: "literal" });
    const body = command.description.trim();
    return {
      id: definition.id,
      contents: `---\n${frontmatter}---\n${body === "" ? "" : `\n${body}\n`}`,
    };
  });
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.id)) throw new Error(`reference-beta.ts: duplicate id "${file.id}".`);
    seen.add(file.id);
  }
  return files.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
