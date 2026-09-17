import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Predicate } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import {
  buildTestRuntime,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockTelemetryRuntime } from "../../../tests/helpers/mocks.ts";
import { migrationCommand } from "./migration.command.ts";

// `withGlobalFlags` must come after `withSubcommands` — see
// `start.string-slice-flags.integration.test.ts`'s identical comment.
const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([migrationCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

const tmp = useTempWorkdir("supabase-migration-alias-int-");

describe("migration command integration", () => {
  it.live("accepts the Go-compatible plural migrations alias", () => {
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out: mockOutput({ format: "text" }),
        api: mockCommandPlatformApi(),
        cliSettings: mockCommandSettings({ workdir: tmp.current }),
      }),
      CliOutput.layer(textCliOutputFormatter()),
      mockTelemetryRuntime({
        configDir: `${tmp.current}/.supabase`,
        tracesDir: `${tmp.current}/.supabase/traces`,
      }),
    );
    // No subcommand is proxied, so the plural alias is proven at the parser:
    // `migrations squash --nope` must fail with squash's own unknown-flag error,
    // before the command's runtime layer ever builds.
    return Effect.gen(function* () {
      const exit = yield* Command.runWith(testRoot, { version: "0.0.0-test" })([
        "migrations",
        "squash",
        "--nope",
      ]).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failures = exit.cause.reasons
          .filter(Cause.isFailReason)
          .map((reason) => reason.error);
        const showHelp = failures.filter((error) => Predicate.isTagged(error, "ShowHelp"));
        // The alias resolved: the parse error is scoped to the squash subcommand, not the root.
        expect(showHelp.map((error) => [...error.commandPath])).toEqual([
          ["supabase", "migration", "squash"],
        ]);
        const reported = [...failures, ...showHelp.flatMap((error) => [...error.errors])];
        expect(reported.filter((error) => Predicate.isTagged(error, "UnknownSubcommand"))).toEqual(
          [],
        );
      }
    }).pipe(Effect.provide(layer));
  });
});
