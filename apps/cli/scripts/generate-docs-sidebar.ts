/**
 * Emits the docs-site CLI sidebar (`common-cli-sections.json`) from the Effect command tree. Run as
 * `bun scripts/generate-docs-sidebar.ts > common-cli-sections.json`.
 */
import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect } from "effect";
import { rootCommand } from "../src/cli/root.ts";
import { buildDocsSidebar, stringifyDocsSidebar } from "../src/docs/docs-sidebar.ts";

BunRuntime.runMain(
  Effect.try(() => stringifyDocsSidebar(buildDocsSidebar(rootCommand))).pipe(
    Effect.flatMap(Console.log),
  ),
);
