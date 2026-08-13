import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../shared/legacy/global-flags.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../../shared/telemetry/identity.ts";
import { mockOutput, mockRuntimeInfo, processEnvLayer } from "../../../../tests/helpers/mocks.ts";
import {
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { legacySsoCommand } from "./sso.command.ts";

// Go parity (CLI-2005): all four sso domain-list flags are pflag
// `StringSliceVar`s (`cmd/sso.go:158,170-172`), so malformed CSV aborts
// cobra's `ParseFlags` before RunE — and before
// `legacyManagementApiRuntimeLayer`'s eager access-token resolution — with
// pflag's exact `invalid argument %q for %q flag: %v` line on stderr. These
// scenarios run the whole command tree (`Command.runWith`) so the assertion
// covers the real flag wiring plus the renderer's pflag passthrough
// (`formatInvalidValueMessage`), mirroring the network-bans/
// network-restrictions prior art from CLI-1983.

const tempRoot = useLegacyTempWorkdir("supabase-sso-string-slice-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacySsoCommand]),
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockLegacyPlatformApi({
    response: { status: 200, body: {} },
  });
  const runtime = buildLegacyTestRuntime({
    out,
    api,
    cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
    // Keep the file-based token fallback inside this test's isolated tempRoot
    // so a stray token at the shared default test home can't leak in.
    runtimeInfo: mockRuntimeInfo({ homeDir: tempRoot.current }),
  });
  const layer = Layer.mergeAll(
    runtime,
    CliOutput.layer(textCliOutputFormatter()),
    // An ambient SUPABASE_ACCESS_TOKEN or keyring entry would let a
    // hypothetical regression (parse error NOT winning) reach the real
    // Management API layer nondeterministically. Wipe process.env and disable
    // the keyring fallback.
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

describe("legacy sso StringSlice flags (pflag CSV parity)", () => {
  // Every rendered line below was verified against the real Go CLI binary
  // (apps/cli-go, pflag v1.0.10 → encoding/csv).
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly args: ReadonlyArray<string>;
    readonly message: string;
  }> = [
    {
      name: "add: malformed --domains",
      args: ["sso", "add", "--type", "saml", "--domains", 'a"b'],
      message:
        'invalid argument "a\\"b" for "--domains" flag: parse error on line 1, column 2: bare " in non-quoted-field',
    },
    {
      name: "update: malformed --domains",
      args: ["sso", "update", "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8", "--domains", 'a"b'],
      message:
        'invalid argument "a\\"b" for "--domains" flag: parse error on line 1, column 2: bare " in non-quoted-field',
    },
    {
      name: "update: malformed --add-domains",
      args: ["sso", "update", "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8", "--add-domains", '"x'],
      message:
        'invalid argument "\\"x" for "--add-domains" flag: parse error on line 1, column 3: extraneous or missing " in quoted-field',
    },
    {
      name: "update: malformed --remove-domains",
      args: ["sso", "update", "b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8", "--remove-domains", '"x'],
      message:
        'invalid argument "\\"x" for "--remove-domains" flag: parse error on line 1, column 3: extraneous or missing " in quoted-field',
    },
  ];

  for (const { name, args, message } of cases) {
    it.live(`${name} CSV fails at parse time with pflag's exact diagnostic`, () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          // Parse-time failure: the command's Management API layer (and its
          // eager token resolution) must never have been built.
          expect(JSON.stringify(exit.cause)).not.toContain("LegacyPlatformAuthRequiredError");
          expect(normalizeCause(exit.cause).message).toBe(message);
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    });
  }
});
