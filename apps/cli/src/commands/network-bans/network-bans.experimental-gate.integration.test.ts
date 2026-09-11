import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { normalizeCause } from "../../shared/output/normalize-error.ts";
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
import { networkBansCommand } from "./network-bans.command.ts";

// See postgres-config.experimental-gate.integration.test.ts for the rationale: proves the
// --experimental gate runs in the command pipeline before managementApiRuntimeLayer's eager
// access-token resolution.

const tempRoot = useTempWorkdir("supabase-network-bans-experimental-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([networkBansCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: { status: 200, body: { banned_ipv4_addresses: [] } },
  });
  const runtime = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    // The gate-open case builds the real managementApiRuntimeLayer inline, whose
    // cliSettings/credentials layers read real files under homeDir and ambient env — an
    // ambient access token, SUPABASE_EXPERIMENTAL, or keyring entry would make these
    // assertions non-deterministic.
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

describe("network-bans experimental gate (Go PersistentPreRunE parity)", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "get", args: ["network-bans", "get"] },
    { name: "remove", args: ["network-bans", "remove"] },
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

  it.live(
    "remove: malformed --db-unban-ip CSV fails at parse time with pflag's exact diagnostic, before the gate",
    () => {
      // `"1.2.3.4` is 8 bytes, so pflag's CSV reader hits EOF at column 9.
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
          expect(JSON.stringify(exit.cause)).not.toContain("ExperimentalRequiredError");
          expect(normalizeCause(exit.cause).message).toBe(
            'invalid argument "\\"1.2.3.4" for "--db-unban-ip" flag: parse error on line 1, column 9: extraneous or missing " in quoted-field',
          );
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );
});
