/**
 * Spike: emits a `configspec 001` YAML document (the shape of supabase.com's
 * `apps/docs/spec/cli_v1_config.yaml`) by walking the `CliConfigSchema` AST from
 * `@supabase/config`, and optionally diffs it against the hand-written file. Run as
 * `bun scripts/generate-config-spec.ts [version] [--diff <handwritten.yaml>]`.
 * The generated YAML (or, with `--diff`, the Markdown diff report) goes to stdout.
 *
 * It reads only annotations already present on the schema (`description`, `default`, `tags`,
 * `links`) and never modifies the schema. Everything is derived structurally from the AST, so
 * the walker treats nodes as loose records rather than depending on Effect's AST classes.
 */
import { CliConfigSchema } from "@supabase/config";
import { Effect, FileSystem } from "effect";
import { BunServices } from "@effect/platform-bun";
import process from "node:process";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";

interface AstNode {
  readonly _tag: string;
  readonly annotations?: Readonly<Record<string, unknown>>;
  readonly context?: { readonly isOptional?: boolean };
  readonly encoding?: ReadonlyArray<{ readonly to?: AstNode }>;
  readonly checks?: ReadonlyArray<{ readonly annotations?: Readonly<Record<string, unknown>> }>;
  readonly propertySignatures?: ReadonlyArray<{
    readonly name: PropertyKey;
    readonly type: AstNode;
  }>;
  readonly indexSignatures?: ReadonlyArray<{ readonly type: AstNode }>;
  readonly elements?: ReadonlyArray<AstNode>;
  readonly rest?: ReadonlyArray<AstNode>;
  readonly types?: ReadonlyArray<AstNode>;
  readonly literal?: unknown;
  readonly thunk?: () => AstNode;
}

interface Link {
  readonly name: string;
  readonly link: string;
}

interface Entry {
  /** Dotted path; map keys are written `<key>` (see {@link wildcard}). */
  readonly path: string;
  readonly tags: ReadonlyArray<string>;
  readonly required: boolean;
  readonly kind: string;
  readonly description?: string;
  readonly default?: string;
  readonly links?: ReadonlyArray<Link>;
}

interface DocEntry {
  readonly id: string;
  readonly title: string;
  readonly default?: unknown;
  readonly description?: string;
  readonly links?: ReadonlyArray<Link>;
  readonly usage?: string;
  readonly type?: string;
  readonly tags?: ReadonlyArray<string>;
  readonly required?: boolean;
}

const WILDCARD = "<key>";
/** `remotes.<key>` repeats the whole document; the spike documents it as a single entry. */
const SKIPPED_SUBTREES = new Set(["remotes"]);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value : undefined;

const stripNullish = (types: ReadonlyArray<AstNode>) =>
  types.filter((member) => member._tag !== "Undefined" && member._tag !== "Null");

/** Doc-style default: scalars as plain strings, arrays as `["a", "b"]`. */
function formatDefault(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return typeof value === "string" ? value : JSON.stringify(value);
}

function leafKind(node: AstNode): string {
  switch (node._tag) {
    case "String":
      return "string";
    case "Number":
      return "number";
    case "Boolean":
      return "bool";
    case "Arrays":
      return "array";
    case "Literal":
      return "enum";
    case "Union": {
      const members = stripNullish(node.types ?? []);
      return members.every((member) => member._tag === "Literal") ? "enum" : "union";
    }
    default:
      return node._tag.toLowerCase();
  }
}

/** Unwraps `T | undefined`-style unions and suspended schemas down to the structural node. */
function structural(node: AstNode): AstNode {
  if (node._tag === "Suspend" && node.thunk !== undefined) return structural(node.thunk());
  if (node._tag === "Union") {
    const members = stripNullish(node.types ?? []);
    const only = members[0];
    if (members.length === 1 && only !== undefined) return structural(only);
  }
  return node;
}

function collectLinks(value: unknown): ReadonlyArray<Link> | undefined {
  if (!Array.isArray(value)) return undefined;
  const links = value.flatMap((item) => {
    const record = item as Partial<Link> | null;
    return typeof record?.name === "string" && typeof record.link === "string"
      ? [{ name: record.name, link: record.link }]
      : [];
  });
  return links.length > 0 ? links : undefined;
}

/** `Schema.Finite.annotate(...)` stores its annotations on the trailing check, not the node. */
function withCheckAnnotations(node: AstNode): Readonly<Record<string, unknown>> {
  const fromChecks = Object.assign(
    {},
    ...(node.checks ?? []).map((check) => check.annotations ?? {}),
  );
  return { ...fromChecks, ...node.annotations };
}

/**
 * Annotations of a leaf. An array's `description`/`tags`/`links` may live on its element schema
 * instead of the array, so fall back to the first element's.
 */
function leafAnnotations(own: Record<string, unknown>, element: AstNode | undefined) {
  const inner = element === undefined ? {} : withCheckAnnotations(element);
  const pick = (key: string) => own[key] ?? inner[key];
  return {
    description: str(pick("description")),
    default: formatDefault(own["default"] ?? inner["default"]),
    tags: Array.isArray(pick("tags")) ? (pick("tags") as ReadonlyArray<string>) : undefined,
    links: collectLinks(pick("links")),
  };
}

function collectEntries(root: AstNode): ReadonlyArray<Entry> {
  const entries: Array<Entry> = [];

  const visit = (
    raw: AstNode,
    path: ReadonlyArray<string>,
    required: boolean,
    inheritedTags: ReadonlyArray<string>,
  ) => {
    const node = structural(raw);
    const joined = path.join(".");
    const annotations = { ...withCheckAnnotations(raw), ...withCheckAnnotations(node) };
    const ownTags = Array.isArray(annotations["tags"])
      ? (annotations["tags"] as ReadonlyArray<string>)
      : undefined;
    const tags = ownTags ?? inheritedTags;
    const sectionTag = path.length === 1 ? [path[0] as string] : undefined;

    if (node._tag === "Objects") {
      const props = node.propertySignatures ?? [];
      const indexes = node.indexSignatures ?? [];
      const description = str(annotations["description"]);
      if (path.length > 0 && (description !== undefined || props.length === 0)) {
        entries.push({
          path: joined,
          tags: tags.length > 0 ? tags : (sectionTag ?? []),
          required,
          kind: props.length === 0 ? "map" : "table",
          description,
          default: formatDefault(annotations["default"]),
          links: collectLinks(annotations["links"]),
        });
      }
      if (SKIPPED_SUBTREES.has(joined)) return;
      const childTags = tags.length > 0 ? tags : (sectionTag ?? []);
      for (const prop of props) {
        const child = structural(prop.type);
        // A decoding default makes the decoded key required, so omission is read from the encoded side.
        const encoded = prop.type.encoding?.at(-1)?.to;
        const optional =
          prop.type.context?.isOptional === true || encoded?.context?.isOptional === true;
        visit(
          prop.type,
          [...path, String(prop.name)],
          !optional && child._tag !== "Undefined",
          childTags,
        );
      }
      for (const index of indexes) visit(index.type, [...path, WILDCARD], false, childTags);
      return;
    }

    const element = node._tag === "Arrays" ? (node.rest?.[0] ?? node.elements?.[0]) : undefined;
    const leaf = leafAnnotations(annotations, element);
    const effectiveTags = leaf.tags ?? tags;
    entries.push({
      path: joined,
      tags: effectiveTags.length > 0 ? effectiveTags : (sectionTag ?? []),
      required,
      kind: leafKind(node),
      description: leaf.description,
      default: leaf.default,
      links: leaf.links,
    });
  };

  visit(root, [], true, []);
  return entries;
}

const TAG_ORDER = [
  ["general", "General", "General settings."],
  ["auth", "Auth", "Auth settings."],
  ["api", "API", "API settings."],
  ["database", "Database", "Database settings."],
  ["dashboard", "Dashboard", "Dashboard settings."],
  ["realtime", "Realtime", "Realtime settings."],
  ["storage", "Storage", "Storage settings."],
  ["edge-functions", "Edge-Functions", "Edge-Functions settings."],
  ["analytics", "Analytics", "Analytics settings."],
  [
    "experimental",
    "Experimental",
    "Settings in alpha testing, subject to changes or removal at any time.",
  ],
  ["local", "Local Development", "Local Development settings."],
  ["branching", "Branching", "Branching configurations settings."],
] as const;

function toConfigSpec(entries: ReadonlyArray<Entry>, version: string) {
  return {
    configspec: "001",
    info: {
      id: "cli",
      version,
      title: "CLI",
      source: "https://github.com/supabase/cli",
      bugs: "https://github.com/supabase/cli/issues",
      spec: "https://github.com/supabase/supabase/blob/master/apps/docs/spec/cli_v1_config.yaml",
      // No source in code: hand-written prose.
      description: "",
      tags: TAG_ORDER.map(([id, title, description]) => ({ id, title, description })),
    },
    parameters: entries
      .filter((entry) => entry.path !== "")
      .map((entry) => ({
        id: entry.path.replaceAll(`<key>`, "key"),
        title: entry.path,
        tags: entry.tags,
        required: entry.required,
        ...(entry.default !== undefined ? { default: entry.default } : {}),
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.links !== undefined ? { links: entry.links } : {}),
      })),
  };
}

/** Comparison key: `<anything>` segments collapse so `auth.hook.<hook_name>` matches `auth.hook.<key>`. */
const wildcard = (path: string) => path.replaceAll(/<[^>]*>/g, WILDCARD);
const normalizeText = (text: string | undefined) => (text ?? "").replaceAll(/\s+/g, " ").trim();

function renderDiff(generated: ReadonlyArray<Entry>, docs: ReadonlyArray<DocEntry>): string {
  const code = new Map(generated.filter((e) => e.path !== "").map((e) => [wildcard(e.path), e]));
  // Hand-written ids drop the placeholder (`auth.sms.provider.enabled`), titles keep it.
  const written = new Map(docs.map((d) => [wildcard(d.title), d]));

  const undocumented = [...code.keys()].filter((key) => !written.has(key));
  const stale = [...written.keys()].filter((key) => !code.has(key));
  const both = [...code.keys()].filter((key) => written.has(key));
  const defaultDiffs = both.filter((key) => {
    const a = code.get(key)?.default;
    const b = written.get(key)?.default;
    return a !== undefined && b !== undefined && formatDefault(a) !== formatDefault(b);
  });
  const missingDefaultInCode = both.filter(
    (key) => code.get(key)?.default === undefined && written.get(key)?.default !== undefined,
  );
  const descDiffs = both.filter((key) => {
    const a = code.get(key)?.description;
    const b = written.get(key)?.description;
    return a !== undefined && b !== undefined && normalizeText(a) !== normalizeText(b);
  });
  const noDescription = [...code.values()].filter(
    (entry) => entry.path !== "" && entry.description === undefined && entry.kind !== "table",
  );
  const linksOnlyInDocs = both.filter(
    (key) => (written.get(key)?.links?.length ?? 0) > 0 && code.get(key)?.links === undefined,
  );
  const linksDiffer = both.filter((key) => {
    const a = JSON.stringify(code.get(key)?.links ?? []);
    const b = JSON.stringify(written.get(key)?.links ?? []);
    return a !== "[]" && b !== "[]" && a !== b;
  });
  const usageOnlyInDocs = docs.filter((d) => d.usage !== undefined);
  const tagsDiffer = both.filter(
    (key) =>
      JSON.stringify(code.get(key)?.tags ?? []) !== JSON.stringify(written.get(key)?.tags ?? []),
  );
  const requiredDiffer = both.filter(
    (key) => code.get(key)?.required !== written.get(key)?.required,
  );

  const list = (items: ReadonlyArray<string>, limit = 200) =>
    items.length === 0
      ? "_none_\n"
      : `${items
          .slice(0, limit)
          .map((item) => `- \`${item}\``)
          .join("\n")}${items.length > limit ? `\n- ... ${items.length - limit} more` : ""}\n`;

  const out: Array<string> = [];
  out.push("## Counts\n");
  out.push("| Bucket | Count |\n| --- | ---: |");
  const rows: ReadonlyArray<readonly [string, number]> = [
    ["Keys in code (leaf + map entries)", code.size],
    ["Entries in hand-written spec", written.size],
    ["Matched", both.length],
    ["In code, undocumented", undocumented.length],
    ["Documented, missing from code (stale)", stale.length],
    ["Default differs", defaultDiffs.length],
    ["Hand-written has default, code has none", missingDefaultInCode.length],
    ["Description differs (whitespace-normalized)", descDiffs.length],
    ["In code with no description annotation", noDescription.length],
    ["Tags differ", tagsDiffer.length],
    ["Required differs", requiredDiffer.length],
    ["Hand-written links with no code links", linksOnlyInDocs.length],
    ["Links differ (both present)", linksDiffer.length],
    ["Hand-written `usage` blocks (no code source)", usageOnlyInDocs.length],
  ];
  for (const [label, count] of rows) out.push(`| ${label} | ${count} |`);
  out.push("");
  out.push(`## In code, undocumented (${undocumented.length})\n\n${list(undocumented)}`);
  out.push(`## Documented, missing from code (${stale.length})\n\n${list(stale)}`);
  out.push(
    `## Default differs (${defaultDiffs.length})\n\n${
      defaultDiffs.length === 0
        ? "_none_\n"
        : defaultDiffs
            .map(
              (key) =>
                `- \`${key}\`: docs \`${String(written.get(key)?.default)}\` vs code \`${code.get(key)?.default}\``,
            )
            .join("\n") + "\n"
    }`,
  );
  out.push(
    `## Hand-written default, none in code (${missingDefaultInCode.length})\n\n${list(missingDefaultInCode)}`,
  );
  out.push(`## Description differs (${descDiffs.length})\n\n${list(descDiffs, 40)}`);
  out.push(
    `## In code with no description (${noDescription.length})\n\n${list(noDescription.map((e) => e.path))}`,
  );
  out.push(`## Tags differ (${tagsDiffer.length})\n\n${list(tagsDiffer, 40)}`);
  out.push(`## Required differs (${requiredDiffer.length})\n\n${list(requiredDiffer, 40)}`);
  out.push(
    `## Hand-written links with no code links (${linksOnlyInDocs.length})\n\n${list(linksOnlyInDocs, 40)}`,
  );
  out.push(`## Links differ (${linksDiffer.length})\n\n${list(linksDiffer, 40)}`);
  out.push(
    `## Hand-written usage blocks (${usageOnlyInDocs.length})\n\n${list(
      usageOnlyInDocs.map((d) => d.title),
      40,
    )}`,
  );
  return out.join("\n");
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { diff: { type: "string" } },
});

const version = (positionals[0] ?? "latest").replace(/^v/, "");

await Effect.runPromise(
  Effect.gen(function* () {
    const entries = collectEntries(CliConfigSchema.ast as unknown as AstNode);
    if (values.diff === undefined) {
      process.stdout.write(
        stringify(toConfigSpec(entries, version), { lineWidth: 0, aliasDuplicateObjects: false }),
      );
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const document = parse(yield* fs.readFileString(values.diff)) as {
      readonly parameters: ReadonlyArray<DocEntry>;
    };
    process.stdout.write(renderDiff(entries, document.parameters));
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError((error) => error.cause ?? error),
  ),
);
