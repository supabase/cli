/**
 * Emits the `clispec 001` CLI reference document for the supabase.com docs site from the Effect
 * command tree plus the content under `apps/cli/docs/`. Run as
 * `bun scripts/generate-docs-spec.ts [version] > cli_v1_commands.yaml`; only the spec YAML goes
 * to stdout, diagnostics go to stderr.
 *
 * The version defaults to `latest` (a leading `v` is stripped); the workspace `package.json`
 * version is a semantic-release placeholder and is never used here.
 */
import path from "node:path";
import process from "node:process";
import { readDocsContent } from "../src/docs/docs-spec.content.ts";
import { buildDocsSpec, stringifyDocsSpec } from "../src/docs/docs-spec.ts";
import { rootCommand } from "../src/cli/root.ts";

function resolveVersion(): string {
  const argument = process.argv[2];
  if (argument === undefined || argument === "") return "latest";
  return argument.startsWith("v") ? argument.slice(1) : argument;
}

const content = readDocsContent(path.resolve(import.meta.dir, "../docs"));

const spec = buildDocsSpec({
  root: rootCommand,
  version: resolveVersion(),
  overlays: content.overlays,
  examples: content.examples,
});

process.stdout.write(stringifyDocsSpec(spec));
