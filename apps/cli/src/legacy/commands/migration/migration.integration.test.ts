import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../shared/legacy/global-flags.ts";
import { legacyMigrationCommand } from "./migration.command.ts";
import { legacyMigrationsCommand } from "../migrations/migrations.command.ts";

// `withGlobalFlags` must come AFTER `withSubcommands` — see
// `start.string-slice-flags.integration.test.ts`'s identical comment.
const legacyTestRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyMigrationCommand, legacyMigrationsCommand]),
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
);

describe("legacy migration and migrations commands", () => {
  it.live("keeps singular migration as the Go-parity group", () => {
    const run = Effect.gen(function* () {
      const exit = yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "migration",
        "squash",
        "--nope",
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeJson = JSON.stringify(exit.cause);
        expect(causeJson).toContain('"commandPath":["supabase","migration","squash"]');
      }
    }).pipe(Effect.provide(CliOutput.layer(textCliOutputFormatter())));

    return run as Effect.Effect<void>;
  });

  it.live("routes plural migrations to the schema-first group", () => {
    const run = Effect.gen(function* () {
      const exit = yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })([
        "migrations",
        "apply",
        "--nope",
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeJson = JSON.stringify(exit.cause);
        expect(causeJson).toContain('"commandPath":["supabase","migrations","apply"]');
        expect(causeJson).not.toContain('"commandPath":["supabase","migration","apply"]');
      }
    }).pipe(Effect.provide(CliOutput.layer(textCliOutputFormatter())));

    return run as Effect.Effect<void>;
  });
});
