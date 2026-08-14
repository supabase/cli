/**
 * Emits the `clispec 001` CLI reference document for the supabase.com docs
 * site (`supabase/supabase` `apps/docs/spec/cli_v1_commands.yaml`) from the
 * legacy Effect command tree plus the content under `apps/cli/docs/`
 * (`supabase/` description overlays, `templates/examples.yaml`).
 *
 * Contract (documented in `docs/README.md`): the spec YAML is the ONLY thing
 * written to stdout, so `bun scripts/generate-docs-spec.ts > cli_v1_commands.yaml`
 * yields a clean parseable file; diagnostics go to stderr. The spec version
 * defaults to `latest` and can be overridden with an argument (a leading
 * `v` is stripped) — the workspace package.json version is a semantic-release
 * placeholder, so it is never used.
 */
import path from "node:path";
import process from "node:process";
import { legacyReadDocsContent } from "../src/legacy/docs/legacy-docs-spec.content.ts";
import {
  legacyBuildDocsSpec,
  legacyStringifyDocsSpec,
} from "../src/legacy/docs/legacy-docs-spec.ts";
import { legacyRoot } from "../src/legacy/cli/root.ts";

function resolveVersion(): string {
  const argument = process.argv[2];
  if (argument === undefined || argument === "") return "latest";
  return argument.startsWith("v") ? argument.slice(1) : argument;
}

const content = legacyReadDocsContent(path.resolve(import.meta.dir, "../docs"));

const spec = legacyBuildDocsSpec({
  root: legacyRoot,
  version: resolveVersion(),
  overlays: content.overlays,
  examples: content.examples,
});

process.stdout.write(legacyStringifyDocsSpec(spec));
