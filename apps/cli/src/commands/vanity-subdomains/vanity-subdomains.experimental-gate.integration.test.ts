import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

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
import { vanitySubdomainsCommand } from "./vanity-subdomains.command.ts";

// See postgres-config.experimental-gate.integration.test.ts: this proves `--experimental`
// gates the command pipeline before `managementApiRuntimeLayer`'s eager access-token resolution.

const tempRoot = useTempWorkdir("supabase-vanity-subdomains-experimental-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([vanitySubdomainsCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({
    response: { status: 200, body: { status: "not-used" } },
  });
  const runtime = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
    // Points homeDir at this test's isolated tempRoot so the "gate open" case's real
    // `commandCredentialsLayer` can't pick up a stray token from the shared default home.
    runtimeInfo: mockRuntimeInfo({ homeDir: tempRoot.current }),
  });
  const layer = Layer.mergeAll(
    runtime,
    CliOutput.layer(textCliOutputFormatter()),
    // Wipes ambient SUPABASE_ACCESS_TOKEN/SUPABASE_EXPERIMENTAL/keyring so the "gate open"
    // case's real `managementApiRuntimeLayer` can't pick up host state.
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

describe("vanity-subdomains experimental gate (Go PersistentPreRunE parity)", () => {
  // `check-availability` and `activate` omit `--desired-subdomain`: it's optional at parse
  // time, so the experimental gate error wins when both flags are missing.
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "get", args: ["vanity-subdomains", "get"] },
    {
      name: "check-availability",
      args: ["vanity-subdomains", "check-availability"],
    },
    {
      name: "activate",
      args: ["vanity-subdomains", "activate"],
    },
    { name: "delete", args: ["vanity-subdomains", "delete"] },
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
