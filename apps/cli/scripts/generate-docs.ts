import { BunFileSystem, BunPath } from "@effect/platform-bun";
import process from "node:process";
import { CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL } from "@supabase/config";
import { Lock, LOCK_SCHEMA_URL } from "@supabase/stack/effect";
import { Console, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { rootCommand } from "../src/cli/root.ts";
import { collectCommands, getHelpDoc } from "../src/shared/cli/command-docs.ts";
import { formatHelpDocAsMarkdown } from "../src/shared/cli/markdown-formatter.ts";

const BINARY_NAME = "supabase";
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown, { space: 2 }));

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const defaultContentDir = path.resolve(
    import.meta.dir,
    "../../../apps/docs/content/docs/commands",
  );
  const defaultDocsPublicDir = path.resolve(import.meta.dir, "../../../apps/docs/public");
  const configPackageDistDir = path.resolve(import.meta.dir, "../../../packages/config/dist");
  const contentDir = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : defaultContentDir;

  const generateCommandDocs = Effect.fnUntraced(function* () {
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
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, mdxContent);
      pages.push({ slug, title, description });

      yield* Console.log(`Generated: commands/${slug}.mdx`);
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
    yield* Console.log("Generated: commands/index.mdx");

    const metaContent = {
      title: "Commands",
      pages: ["index", ...pages.map((page) => page.slug.split("/").pop())],
    };
    yield* fs.writeFileString(path.join(contentDir, "meta.json"), yield* encodeJson(metaContent));

    yield* Console.log(`\nGenerated ${pages.length} command page(s)`);
  });

  /**
   * Copies `@supabase/config`'s post-processed `dist/*.json` schema artifact to its docs-site
   * public path rather than re-rendering it here, since re-rendering would bypass
   * `json-schema-postprocess.ts` and produce a mismatched `$id`. Requires
   * `@supabase/config#build` to have already run (wired via `turbo.json`).
   */
  const copyConfigSchemaAsset = Effect.fnUntraced(function* (
    schemaUrl: string,
    distFileName: string,
  ) {
    const schemaPathname = new URL(schemaUrl).pathname.replace(/^\/docs/, "");
    const destPath = path.join(defaultDocsPublicDir, schemaPathname);
    const sourcePath = path.join(configPackageDistDir, distFileName);

    yield* fs.makeDirectory(path.dirname(destPath), { recursive: true });
    yield* fs.copyFile(sourcePath, destPath);

    yield* Console.log(
      `Generated: ${path.relative(path.resolve(import.meta.dir, "../../.."), destPath)}`,
    );
  });

  /** Writes the `supabase.lock` v1 JSON Schema, generated from the stack's lock schema, to its docs-site public path. */
  const writeLockSchemaAsset = Effect.fnUntraced(function* () {
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

    yield* fs.makeDirectory(path.dirname(destPath), { recursive: true });
    yield* fs.writeFileString(destPath, `${yield* encodeJson(document)}\n`);

    yield* Console.log(
      `Generated: ${path.relative(path.resolve(import.meta.dir, "../../.."), destPath)}`,
    );
  });

  yield* generateCommandDocs();
  yield* writeLockSchemaAsset();
  yield* copyConfigSchemaAsset(CLI_CONFIG_SCHEMA_URL, "schema.json");
  yield* copyConfigSchemaAsset(PROJECT_CONFIG_SCHEMA_URL, "project-schema.json");
});

function thrownValue(error: { readonly message: string; readonly cause?: unknown }): unknown {
  return error.cause !== undefined ? error.cause : new Error(error.message);
}

await Effect.runPromise(
  main.pipe(
    Effect.catch((error) => Effect.die(thrownValue(error))),
    Effect.provide(Layer.mergeAll(BunFileSystem.layer, BunPath.layer)),
  ),
);
