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
import { legacyStatusCommand } from "./status.command.ts";

// Go parity (CLI-2005): `--override-name` and `--exclude` are pflag
// `StringSliceVar`s (`cmd/status.go:38-39`), so malformed CSV aborts cobra's
// `ParseFlags` before RunE — before any Docker interaction — with pflag's
// exact `invalid argument %q for %q flag: %v` line on stderr. These scenarios
// run the whole command tree (`Command.runWith`), mirroring the network-bans/
// network-restrictions prior art from CLI-1983.

const tempRoot = useLegacyTempWorkdir("supabase-status-string-slice-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
  Command.withSubcommands([legacyStatusCommand]),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockLegacyPlatformApi({ response: { status: 200, body: {} } });
  const runtime = buildLegacyTestRuntime({
    out,
    api,
    cliConfig: mockLegacyCliConfig({ workdir: tempRoot.current }),
    runtimeInfo: mockRuntimeInfo({ homeDir: tempRoot.current }),
  });
  const layer = Layer.mergeAll(
    runtime,
    CliOutput.layer(textCliOutputFormatter()),
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
  return { layer };
}

describe("legacy status StringSlice flags (pflag CSV parity)", () => {
  // Every rendered line below was verified against the real Go CLI binary
  // (apps/cli-go, pflag v1.0.10 → encoding/csv).
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly args: ReadonlyArray<string>;
    readonly message: string;
  }> = [
    {
      name: "malformed --override-name",
      args: ["status", "--override-name", '"api.url=FOO'],
      // `"api.url=FOO` is 12 bytes → EOF at column 13.
      message:
        'invalid argument "\\"api.url=FOO" for "--override-name" flag: parse error on line 1, column 13: extraneous or missing " in quoted-field',
    },
    {
      name: "malformed --exclude (hidden flag)",
      args: ["status", "--exclude", 'a"b'],
      message:
        'invalid argument "a\\"b" for "--exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
    },
  ];

  for (const { name, args, message } of cases) {
    it.live(`${name} CSV fails at parse time with pflag's exact diagnostic`, () => {
      const { layer } = setup();
      const run = Effect.gen(function* () {
        const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(normalizeCause(exit.cause).message).toBe(message);
        }
      }).pipe(Effect.provide(layer));

      // Command.runWith's Environment type retains the GlobalFlag services the
      // status handler reads (--debug, --workdir, --profile) even though this
      // parse-failure path never reaches the handler at runtime — same
      // precedent as migration.integration.test.ts.
      return run as Effect.Effect<void>;
    });
  }
});
