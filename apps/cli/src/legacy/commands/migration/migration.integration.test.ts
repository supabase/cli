import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../shared/legacy/global-flags.ts";
import { legacyMigrationCommand } from "./migration.command.ts";

// `withGlobalFlags` must come AFTER `withSubcommands` — see
// `start.string-slice-flags.integration.test.ts`'s identical comment.
const legacyTestRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyMigrationCommand]),
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
);

describe("legacy migration command integration", () => {
  it.live("accepts the Go-compatible plural migrations alias", () => {
    // After CLI-1969, `squash` is native and no `migration` subcommand is proxied
    // any more — so the plural alias is now proven at the PARSER instead: a
    // `migrations squash --nope` must fail with squash's own unknown-flag error,
    // which never builds the command's `Command.provide` runtime layer.
    const run = Effect.gen(function* () {
      const exit = yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "migrations",
        "squash",
        "--nope",
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeJson = JSON.stringify(exit.cause);
        // The alias resolved: the parse error is scoped to the squash LEAF, not the root.
        expect(causeJson).toContain('"commandPath":["supabase","migration","squash"]');
        expect(causeJson).not.toContain('"subcommand":"migrations"');
      }
    }).pipe(Effect.provide(CliOutput.layer(textCliOutputFormatter())));

    // Command.runWith's Environment type is retained even though this path only needs CliOutput
    // at runtime.
    return run as Effect.Effect<void>;
  });
});
