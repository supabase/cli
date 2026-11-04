/**
 * Emits the `clispec 002` CLI reference document for the supabase.com docs site from the Effect
 * command tree plus the content under `apps/cli/docs/`. Run as
 * `bun scripts/generate-docs-spec.ts [version] [--prerelease] [--sections <file>] > cli_v2_commands.yaml`;
 * only the spec YAML goes to stdout, diagnostics go to stderr. `--major <n>` (default 2) picks
 * the CLI major the spec documents. `--sections` also writes the sidebar sections JSON to `<file>`.
 *
 * The version defaults to `latest` (a leading `v` is stripped); the workspace `package.json`
 * version is a semantic-release placeholder and is never used here.
 */
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";
import process from "node:process";
import { parseArgs } from "node:util";
import { stringifyDocsSections, stringifyDocsSpec } from "../src/docs/docs-spec.ts";
import { loadDocsBundle } from "./docs-bundle.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    prerelease: { type: "boolean", default: false },
    sections: { type: "string" },
    major: { type: "string", default: "2" },
  },
});

function resolveVersion(): string {
  const argument = positionals[0];
  if (argument === undefined || argument === "") return "latest";
  return argument.startsWith("v") ? argument.slice(1) : argument;
}

await Effect.runPromise(
  Effect.gen(function* () {
    const bundle = yield* loadDocsBundle({
      version: resolveVersion(),
      prerelease: values.prerelease,
      major: Number(values.major),
    });
    if (values.sections !== undefined) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(values.sections, stringifyDocsSections(bundle.sections));
    }
    process.stdout.write(stringifyDocsSpec(bundle.spec));
  }).pipe(
    Effect.provide(BunServices.layer),
    Effect.mapError((error) => error.cause ?? error),
  ),
);
