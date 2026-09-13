import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { normalizeCause } from "../../shared/output/normalize-error.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../shared/telemetry/identity.ts";
import { mockOutput, mockRuntimeInfo, processEnvLayer } from "../../../tests/helpers/mocks.ts";
import {
  buildTestRuntime,
  mockCommandSettings,
  mockCommandPlatformApi,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { networkRestrictionsCommand } from "./network-restrictions.command.ts";

// See postgres-config.experimental-gate.integration.test.ts for the rationale: proves the
// --experimental gate runs in the command pipeline before managementApiRuntimeLayer's eager
// access-token resolution.

const tempRoot = useTempWorkdir("supabase-network-restrictions-experimental-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([networkRestrictionsCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: { status: 200, body: { config: { dbAllowedCidrs: [] }, status: "applied" } },
  });
  const runtime = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    // managementApiRuntimeLayer doesn't provide RuntimeInfo itself; the real
    // commandCredentialsLayer built inline for the gate-open case resolves it from here, so
    // point homeDir at this test's tempRoot to avoid picking up a stray token from the shared
    // default test home.
    runtimeInfo: mockRuntimeInfo({ homeDir: tempRoot.current }),
  });
  const layer = Layer.mergeAll(
    runtime,
    CliOutput.layer(textCliOutputFormatter()),
    // The gate-open case reaches the real managementApiRuntimeLayer (provided inline, not
    // by this test's mocked runtime), which reads credentials/env directly — an ambient
    // access token, SUPABASE_EXPERIMENTAL, or keyring entry would make these assertions
    // non-deterministic.
    processEnvLayer({ SUPABASE_NO_KEYRING: "1" }),
    Layer.succeed(
      TelemetryRuntime,
      TelemetryRuntime.of({
        configDir: `${tempRoot.current}/.supabase`,
        tracesDir: `${tempRoot.current}/.supabase/traces`,
        consent: "granted",
        showDebug: false,
        deviceId: "test-device-id",
        sessionId: "test-session-id",
        identity: makeTelemetryIdentity(undefined),
        isFirstRun: false,
        isTty: false,
        isCi: false,
        os: "linux",
        arch: "x64",
        cliVersion: "0.1.0",
      }),
    ),
  );
  return { layer, api };
}

describe("network-restrictions experimental gate (Go PersistentPreRunE parity)", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "get", args: ["network-restrictions", "get"] },
    { name: "update", args: ["network-restrictions", "update"] },
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
    "update: malformed --db-allow-cidr CSV fails at parse time with pflag's exact diagnostic, before the gate",
    () => {
      // `"1.2.3.0/24` is 11 bytes, so pflag's CSV reader hits EOF at column 12.
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Command.runWith(testRoot, { version: "0.0.0-test" })([
            "network-restrictions",
            "update",
            "--db-allow-cidr",
            '"1.2.3.0/24',
          ]),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).not.toContain("ExperimentalRequiredError");
          expect(normalizeCause(exit.cause).message).toBe(
            'invalid argument "\\"1.2.3.0/24" for "--db-allow-cidr" flag: parse error on line 1, column 12: extraneous or missing " in quoted-field',
          );
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );
});
