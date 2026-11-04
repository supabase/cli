/**
 * Builds the CLI reference bundle (the `clispec 002` spec and its sidebar sections) from the
 * command tree and the content under `apps/cli/docs/`. Shared by `generate-docs-spec.ts` and
 * `publish-docs-spec.ts --local`.
 */
import { Effect, Path } from "effect";
import { rootCommand } from "../src/cli/root.ts";
import { readDocsContent } from "../src/docs/docs-spec.content.ts";
import { BREAKING_CHANGES } from "../src/docs/breaking-changes/registry.ts";
import { buildDocsBundle } from "../src/docs/docs-spec.ts";

export const loadDocsBundle = Effect.fn("docs.loadBundle")(function* (options: {
  readonly version: string;
  readonly prerelease: boolean;
  readonly major: number;
}) {
  const path = yield* Path.Path;
  const content = yield* readDocsContent(path.resolve(import.meta.dirname, "../docs"));
  return buildDocsBundle({
    root: rootCommand,
    version: options.version,
    prerelease: options.prerelease,
    major: options.major,
    breakingChanges: BREAKING_CHANGES,
    overlays: content.overlays,
    examples: content.examples,
  });
});
