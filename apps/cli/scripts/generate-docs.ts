import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Schema } from "effect";
import process from "node:process";
import { PROJECT_CONFIG_SCHEMA_URL, toProjectConfigJsonSchema } from "@supabase/config";
import { nextRoot } from "../src/next/cli/root.ts";
import { collectCommands, getHelpDoc } from "../src/next/docs/command-docs.ts";
import { formatHelpDocAsMarkdown } from "../src/next/docs/markdown-formatter.ts";

const BINARY_NAME = "supabase";

const encodeJson = (value: unknown) =>
  Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }))(value);

const generateCommandDocs = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  contentDir: string,
) {
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
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, mdxContent);
    pages.push({ slug, title, description });

    yield* Effect.sync(() => process.stdout.write(`Generated: commands/${slug}.mdx\n`));
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

  yield* fs.writeFileString(path.join(contentDir, "index.mdx"), indexContent);
  yield* Effect.sync(() => process.stdout.write("Generated: commands/index.mdx\n"));

  const metaContent = {
    title: "Commands",
    pages: ["index", ...pages.map((page) => page.slug.split("/").pop())],
  };
  const encodedMeta = yield* encodeJson(metaContent);
  yield* fs.writeFileString(path.join(contentDir, "meta.json"), `${encodedMeta}\n`);

  yield* Effect.sync(() => process.stdout.write(`\nGenerated ${pages.length} command page(s)\n`));
});

const generateConfigSchemaAsset = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  defaultDocsPublicDir: string,
) {
  const schema = toProjectConfigJsonSchema();
  const schemaPathname = new URL(PROJECT_CONFIG_SCHEMA_URL).pathname.replace(/^\/docs/, "");
  const filePath = path.join(defaultDocsPublicDir, schemaPathname);

  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
  const encodedSchema = yield* encodeJson(schema);
  yield* fs.writeFileString(filePath, `${encodedSchema}\n`);

  yield* Effect.sync(() =>
    process.stdout.write(
      `Generated: ${path.relative(path.resolve(import.meta.dir, "../../.."), filePath)}\n`,
    ),
  );
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const defaultContentDir = path.resolve(
    import.meta.dir,
    "../../../apps/docs/content/docs/commands",
  );
  const defaultDocsPublicDir = path.resolve(import.meta.dir, "../../../apps/docs/public");
  const contentDir = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : defaultContentDir;
  yield* generateCommandDocs(fs, path, contentDir);
  yield* generateConfigSchemaAsset(fs, path, defaultDocsPublicDir);
});

if (import.meta.main) {
  await Effect.runPromise(main.pipe(Effect.provide(BunServices.layer)));
}
