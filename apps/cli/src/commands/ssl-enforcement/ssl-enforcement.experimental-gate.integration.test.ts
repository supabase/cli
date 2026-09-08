import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { mockOutput, mockTelemetryRuntime } from "../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  isolatedHomeLayer,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { sslEnforcementCommand } from "./ssl-enforcement.command.ts";

// See postgres-config.experimental-gate.integration.test.ts for the full
// rationale: this proves `--experimental` is wired into the actual
// `.command.ts` handler pipeline AND runs before
// `managementApiRuntimeLayer`'s eager access-token resolution
// (the `IsExperimental` check precedes `IsManagementAPI` in
// `apps/cli-go/cmd/root.go:91-109`).

const tempRoot = useTempWorkdir("supabase-ssl-enforcement-experimental-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([sslEnforcementCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: {
      status: 200,
      body: { currentConfig: { database: true }, appliedSuccessfully: true },
    },
  });
  const runtime = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    // The "gate open" case builds the real `managementApiRuntimeLayer`
    // inline inside the command; its cliSettings/credentials layers read real
    // files under homeDir and ambient env — an ambient SUPABASE_ACCESS_TOKEN,
    // SUPABASE_EXPERIMENTAL, or OS keyring entry on the machine running the
    // test would make these assertions non-deterministic. Isolate both, keeping
    // only the keyring kill-switch set.
    runtimeInfo: isolatedHomeLayer(tempRoot.current, { SUPABASE_NO_KEYRING: "1" }),
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

describe("legacy ssl-enforcement experimental gate (Go PersistentPreRunE parity)", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "get", args: ["ssl-enforcement", "get"] },
    { name: "update", args: ["ssl-enforcement", "update", "--enable-db-ssl-enforcement"] },
  ];

  for (const { name, args } of leaves) {
    it.live(`${name} fails with ExperimentalRequiredError when --experimental is unset`, () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain("ExperimentalRequiredError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });

    it.live(`${name} does not fail with the gate error once --experimental is set`, () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Command.runWith(testRoot, { version: "0.0.0-test" })([...args, "--experimental"]),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = JSON.stringify(exit.cause);
          expect(causeText).not.toContain("ExperimentalRequiredError");
          expect(causeText).toContain("AccessTokenRequiredError");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });
  }
});
