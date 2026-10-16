import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL } from "@supabase/config";
import { Lock, LOCK_SCHEMA_URL } from "@supabase/stack/effect";
import { Schema } from "effect";
import { rootCommand } from "../src/cli/root.ts";
import { collectCommands, getHelpDoc } from "../src/shared/cli/command-docs.ts";
import { formatHelpDocAsMarkdown } from "../src/shared/cli/markdown-formatter.ts";

const BINARY_NAME = "supabase";
const defaultContentDir = path.resolve(import.meta.dir, "../../../apps/docs/content/docs/commands");
const defaultDocsPublicDir = path.resolve(import.meta.dir, "../../../apps/docs/public");
const configPackageDistDir = path.resolve(import.meta.dir, "../../../packages/config/dist");
const contentDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : defaultContentDir;

function generateCommandDocs() {
  const leaves = collectCommands(rootCommand, [BINARY_NAME]).filter(
    ({ command, commandPath }) => commandPath.length > 1 && command.subcommands.length === 0,
  );

  const pages: Array<{ slug: string; title: string; description: string }> = [];

  for (const { command, commandPath } of leaves) {
    const helpDoc = getHelpDoc(command, commandPath);
    const body = formatHelpDocAsMarkdown(helpDoc);

    const title = commandPath.slice(1).join(" ");
    const description =
      (command as any).shortDescription ?? helpDoc.description?.split("\n")[0] ?? "";

    const slug = commandPath.slice(1).join("/");
    const frontmatter = [
      "---",
      `title: "${BINARY_NAME} ${title}"`,
      `description: "${description.replace(/"/g, '\\"')}"`,
      "---",
    ].join("\n");

    const mdxContent = `${frontmatter}\n\n${body}`;

    const filePath = path.join(contentDir, `${slug}.mdx`);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, mdxContent);
    pages.push({ slug, title, description });

    console.log(`Generated: commands/${slug}.mdx`);
  }

  const indexFrontmatter = [
    "---",
    "title: Command reference",
    "description: Complete reference for all Supabase CLI commands",
    "---",
  ].join("\n");

  const rows = pages.map(
    (page) =>
      `| [\`${BINARY_NAME} ${page.title}\`](/docs/commands/${page.slug}) | ${page.description} |`,
  );
  const table = `| Command | Description |\n| --- | --- |\n${rows.join("\n")}`;
  const indexContent = `${indexFrontmatter}\n\n${table}\n`;

  writeFileSync(path.join(contentDir, "index.mdx"), indexContent);
  console.log("Generated: commands/index.mdx");

  const metaContent = {
    title: "Commands",
    pages: ["index", ...pages.map((page) => page.slug.split("/").pop())],
  };
  writeFileSync(path.join(contentDir, "meta.json"), JSON.stringify(metaContent, null, 2));

  console.log(`\nGenerated ${pages.length} command page(s)`);
}

/**
 * Copies `@supabase/config`'s post-processed `dist/*.json` schema artifact to its docs-site
 * public path rather than re-rendering it here, since re-rendering would bypass
 * `json-schema-postprocess.ts` and produce a mismatched `$id`. Requires
 * `@supabase/config#build` to have already run (wired via `turbo.json`).
 */
function copyConfigSchemaAsset(schemaUrl: string, distFileName: string) {
  const schemaPathname = new URL(schemaUrl).pathname.replace(/^\/docs/, "");
  const destPath = path.join(defaultDocsPublicDir, schemaPathname);
  const sourcePath = path.join(configPackageDistDir, distFileName);

  mkdirSync(path.dirname(destPath), { recursive: true });
  copyFileSync(sourcePath, destPath);

  console.log(`Generated: ${path.relative(path.resolve(import.meta.dir, "../../.."), destPath)}`);
}

/** Writes the `supabase.lock` v1 JSON Schema, generated from the stack's lock schema, to its docs-site public path. */
function writeLockSchemaAsset() {
  const { schema, definitions } = Schema.toJsonSchemaDocument(Lock);
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: LOCK_SCHEMA_URL,
    title: "supabase.lock",
    description: "The service versions that supabase start pins in supabase/supabase.lock.",
    ...schema,
    $defs: definitions,
  };
  const schemaPathname = new URL(LOCK_SCHEMA_URL).pathname.replace(/^\/docs/, "");
  const destPath = path.join(defaultDocsPublicDir, schemaPathname);

  mkdirSync(path.dirname(destPath), { recursive: true });
  writeFileSync(destPath, `${JSON.stringify(document, null, 2)}\n`);

  console.log(`Generated: ${path.relative(path.resolve(import.meta.dir, "../../.."), destPath)}`);
}

generateCommandDocs();
writeLockSchemaAsset();
copyConfigSchemaAsset(CLI_CONFIG_SCHEMA_URL, "schema.json");
copyConfigSchemaAsset(PROJECT_CONFIG_SCHEMA_URL, "project-schema.json");
