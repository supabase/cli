import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../shared/legacy/global-flags.ts";
import { mockOutput, mockTelemetryRuntime } from "../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  legacyIsolatedHomeLayer,
  mockLegacyCliSettings,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyNetworkBansCommand } from "./network-bans.command.ts";

// See postgres-config.experimental-gate.integration.test.ts for the full
// rationale: this proves `--experimental` is wired into the actual
// `.command.ts` handler pipeline AND runs before
// `legacyManagementApiRuntimeLayer`'s eager access-token resolution
// (the `IsExperimental` check precedes `IsManagementAPI` in
// `apps/cli-go/cmd/root.go:91-109`).

const tempRoot = useLegacyTempWorkdir("supabase-network-bans-experimental-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyNetworkBansCommand]),
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockLegacyPlatformApi({
    response: { status: 200, body: { banned_ipv4_addresses: [] } },
  });
  const runtime = buildLegacyTestRuntime({
    out,
    api,
    cliSettings: mockLegacyCliSettings({ workdir: tempRoot.current }),
    // The "gate open" case builds the real `legacyManagementApiRuntimeLayer`
    // inline inside the command; its cliSettings/credentials layers read real
    // files under homeDir and ambient env — an ambient SUPABASE_ACCESS_TOKEN,
    // SUPABASE_EXPERIMENTAL, or OS keyring entry on the machine running the
    // test would make these assertions non-deterministic. Isolate both, keeping
    // only the keyring kill-switch set.
    runtimeInfo: legacyIsolatedHomeLayer(tempRoot.current, { SUPABASE_NO_KEYRING: "1" }),
  });
  const layer = Layer.mergeAll(
    runtime,
    CliOutput.layer(textCliOutputFormatter()),
    mockTelemetryRuntime({
      configDir: `${tempRoot.current}/.supabase`,
      tracesDir: `${tempRoot.current}/.supabase/traces`,
    }),
  );
  return { layer, api };
}

describe("legacy network-bans experimental gate (Go PersistentPreRunE parity)", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "get", args: ["network-bans", "get"] },
    { name: "remove", args: ["network-bans", "remove"] },
  ];

  for (const { name, args } of leaves) {
    it.live(
      `${name} fails with LegacyExperimentalRequiredError when --experimental is unset`,
      () => {
        const { layer, api } = setup();
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Command.runWith(testRoot, { version: "0.0.0-test" })(args),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyExperimentalRequiredError");
          }
          expect(api.requests).toHaveLength(0);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(`${name} does not fail with the gate error once --experimental is set`, () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Command.runWith(testRoot, { version: "0.0.0-test" })([...args, "--experimental"]),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = JSON.stringify(exit.cause);
          expect(causeText).not.toContain("LegacyExperimentalRequiredError");
          expect(causeText).toContain("LegacyPlatformAuthRequiredError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });
  }

  it.live(
    "remove: malformed --db-unban-ip CSV fails at parse time with pflag's exact diagnostic, before the gate",
    () => {
      // pflag's `readAsCSV` error aborts cobra's `ParseFlags` BEFORE
      // `PersistentPreRunE`'s experimental-gate check, so the parse error
      // must win even with `--experimental` unset. The rendered line — what
      // `runCli`'s `handledProgram` writes to stderr via `normalizeCause` —
      // matches pflag's own diagnostic (pflag v1.0.10 `errors.go:116`
      // wrapping `encoding/csv`; `"1.2.3.4` is 8 bytes → EOF at column 9).
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Command.runWith(testRoot, { version: "0.0.0-test" })([
            "network-bans",
            "remove",
            "--db-unban-ip",
            '"1.2.3.4',
          ]),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).not.toContain("LegacyExperimentalRequiredError");
          expect(normalizeCause(exit.cause).message).toBe(
            'invalid argument "\\"1.2.3.4" for "--db-unban-ip" flag: parse error on line 1, column 9: extraneous or missing " in quoted-field',
          );
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );
});
