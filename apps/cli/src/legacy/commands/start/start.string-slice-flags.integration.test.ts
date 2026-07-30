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
import { legacyStartCommand } from "./start.command.ts";

// Go parity (CLI-2005): `--exclude`/`-x` is a pflag `StringSliceVarP`
// (`cmd/start.go:58`), so malformed CSV aborts cobra's `ParseFlags` before
// RunE — before any Docker interaction — with pflag's exact
// `invalid argument %q for %q flag: %v` line on stderr. Because the flag has
// a shorthand, pflag frames the diagnostic with BOTH spellings
// (`-x, --exclude`, pflag v1.0.10 `errors.go:108-117`) regardless of which
// one the user typed. These scenarios run the whole command tree
// (`Command.runWith`), mirroring the network-bans/network-restrictions prior
// art from CLI-1983.

const tempRoot = useLegacyTempWorkdir("supabase-start-string-slice-int-");

const testRoot = Command.make("supabase").pipe(
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
  Command.withSubcommands([legacyStartCommand]),
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

describe("legacy start --exclude flag (pflag CSV parity)", () => {
  // Go-verified (CLI-2005): the rendered line is identical for both
  // spellings — pflag always frames a shorthand flag as `-x, --exclude`.
  const spellings: ReadonlyArray<{ readonly name: string; readonly flag: string }> = [
    { name: "--exclude", flag: "--exclude" },
    { name: "-x", flag: "-x" },
  ];

  for (const { name, flag } of spellings) {
    it.live(
      `${name}: malformed CSV fails at parse time with pflag's shorthand-framed diagnostic`,
      () => {
        const { layer } = setup();
        const run = Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Command.runWith(testRoot, { version: "0.0.0-test" })(["start", flag, 'a"b']),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(normalizeCause(exit.cause).message).toBe(
              'invalid argument "a\\"b" for "-x, --exclude" flag: parse error on line 1, column 2: bare " in non-quoted-field',
            );
          }
        }).pipe(Effect.provide(layer));

        // Command.runWith's Environment type retains the GlobalFlag services the
        // start handler reads (--debug, --workdir, ...) even though this
        // parse-failure path never reaches the handler at runtime — same
        // precedent as migration.integration.test.ts.
        return run as Effect.Effect<void>;
      },
    );
  }
});
