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
import { statusCommand } from "./status.command.ts";

// `--override-name` and `--exclude` are string-slice flags, so malformed CSV aborts flag parsing
// before the handler runs, with the exact `invalid argument %q for %q flag: %v` line on stderr.
// These run the whole command tree (`Command.runWith`), not just the flag parser.

const tempRoot = useTempWorkdir("supabase-status-string-slice-int-");

// `withGlobalFlags` must come after `withSubcommands`: it excludes each global flag's context
// requirement only from what's already accumulated, so subcommand requirements need to be unioned
// in first. Reversing the order would leave those context tags in `Command.runWith`'s Environment
// type, even though this parse-failure path never reaches the handler.
const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([statusCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup() {
  const out = mockOutput({ format: "text" });
  const api = mockCommandPlatformApi({ response: { status: 200, body: {} } });
  const runtime = buildTestRuntime({
    out,
    api,
    cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
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

describe("status StringSlice flags (pflag CSV parity)", () => {
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
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(normalizeCause(exit.cause).message).toBe(message);
        }
      }).pipe(Effect.provide(layer));
    });
  }
});
