import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { root } from "../src/cli/root.ts";
import { collectCommands, getHelpDoc } from "../src/docs/command-docs.ts";
import { getGuide } from "../src/docs/guide-registry.ts";
import { injectSections } from "../src/docs/guide-injector.ts";
import { formatHelpDocAsMarkdown } from "../src/docs/markdown-formatter.ts";

const BINARY_NAME = "supabase";
const defaultContentDir = path.resolve(import.meta.dir, "../../../apps/docs/content/docs/commands");
const contentDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : defaultContentDir;

/** Strip HTML comment markers left by the guide injector. */
function stripMarkers(content: string): string {
  return content.replace(/<!--\s*\w+:(START|END)\s*-->\n*/g, "");
}

function generateCommandDocs() {
  const leaves = collectCommands(root, [BINARY_NAME]).filter(
    ({ command, commandPath }) => commandPath.length > 1 && command.subcommands.length === 0,
  );

  const pages: Array<{ slug: string; title: string; description: string }> = [];

  for (const { command, commandPath } of leaves) {
    const helpDoc = getHelpDoc(command, commandPath);
    const guide = getGuide(commandPath.slice(1));

    const body = guide
      ? stripMarkers(injectSections(guide.template, helpDoc))
      : formatHelpDocAsMarkdown(helpDoc);

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

generateCommandDocs();
