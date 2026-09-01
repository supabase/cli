import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL } from "@supabase/config";
import { nextRoot } from "../src/next/cli/root.ts";
import { collectCommands, getHelpDoc } from "../src/next/docs/command-docs.ts";
import { formatHelpDocAsMarkdown } from "../src/next/docs/markdown-formatter.ts";

const BINARY_NAME = "supabase";
const defaultContentDir = path.resolve(import.meta.dir, "../../../apps/docs/content/docs/commands");
const defaultDocsPublicDir = path.resolve(import.meta.dir, "../../../apps/docs/public");
const configPackageDistDir = path.resolve(import.meta.dir, "../../../packages/config/dist");
const contentDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : defaultContentDir;

function generateCommandDocs() {
  const leaves = collectCommands(nextRoot, [BINARY_NAME]).filter(
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
 * Copies `@supabase/config`'s already post-processed (metadata + number-
 * union-collapsed) `dist/*.json` schema artifact straight to its docs-site
 * public path, rather than re-rendering `toCliConfigJsonSchema()`/
 * `toProjectConfigJsonSchema()` here (CLI-2234) — re-rendering would bypass
 * `json-schema-postprocess.ts` and produce a document whose `$id` doesn't
 * match what actually gets published. Requires `@supabase/config#build` to
 * have already run (wired via `turbo.json`).
 */
function copyConfigSchemaAsset(schemaUrl: string, distFileName: string) {
  const schemaPathname = new URL(schemaUrl).pathname.replace(/^\/docs/, "");
  const destPath = path.join(defaultDocsPublicDir, schemaPathname);
  const sourcePath = path.join(configPackageDistDir, distFileName);

  mkdirSync(path.dirname(destPath), { recursive: true });
  copyFileSync(sourcePath, destPath);

  console.log(`Generated: ${path.relative(path.resolve(import.meta.dir, "../../.."), destPath)}`);
}

generateCommandDocs();
copyConfigSchemaAsset(CLI_CONFIG_SCHEMA_URL, "schema.json");
copyConfigSchemaAsset(PROJECT_CONFIG_SCHEMA_URL, "project-schema.json");
