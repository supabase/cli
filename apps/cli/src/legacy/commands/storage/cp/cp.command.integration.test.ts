import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../../../shared/output/text-formatter.ts";
import { normalizeCause } from "../../../../shared/output/normalize-error.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../../shared/legacy/global-flags.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../../../tests/helpers/mocks.ts";
import { makeTelemetryIdentity } from "../../../../shared/telemetry/identity.ts";
import { TelemetryRuntime } from "../../../../shared/telemetry/runtime.service.ts";
import { legacyStorageCommand } from "../storage.command.ts";

// Go's `--jobs` is a pflag uint (`UintVarP`, `cmd/storage.go:107`): a negative
// value fails `strconv.ParseUint` at cobra flag-parse time — before the
// `--experimental` gate in `PersistentPreRunE` (`cmd/root.go:93-96`), before
// cobra's mutual-exclusivity check, and before RunE. `cp.command.ts`
// reproduces that ordering by rejecting inside the flag's own
// `Flag.mapTryCatch`, which Effect CLI runs while parsing the command tree —
// strictly ahead of the handler (where the experimental gate and the
// `--linked`/`--local` mutex check live). This suite proves the rejection is
// wired into the real command tree — not just reachable by calling
// `legacyStorageCp` directly with a handcrafted `Option.some(-1)` flags
// object, which `cp.integration.test.ts` cannot exercise since it calls the
// handler directly.
const testRoot = Command.make("supabase").pipe(
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
  Command.withSubcommands([legacyStorageCommand]),
);

function setup(args: ReadonlyArray<string>) {
  const out = mockOutput({ format: "text" });
  const layer = Layer.mergeAll(
    BunServices.layer,
    CliOutput.layer(textCliOutputFormatter()),
    out.layer,
    Layer.succeed(CliArgs, { args }),
    // `legacyStorageGatewayRuntimeLayer`'s cliConfig/credentials layers read
    // real env/files when built. The jobs check under test never reaches that
    // lazy factory, but isolate ambient env defensively anyway.
    processEnvLayer({ SUPABASE_NO_KEYRING: "1" }),
    mockRuntimeInfo(),
    mockProcessControl().layer,
    mockTty({ stdinIsTty: false, stdoutIsTty: false }),
    mockAnalytics().layer,
    Layer.succeed(
      TelemetryRuntime,
      TelemetryRuntime.of({
        configDir: "/tmp/supabase-storage-cp-jobs-test/.supabase",
        tracesDir: "/tmp/supabase-storage-cp-jobs-test/.supabase/traces",
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

describe("legacy storage cp --jobs negative rejection (command-tree wiring)", () => {
  it.live(
    "rejects --jobs=-1 with pflag's exact ParseUint message, ahead of the experimental gate and the --linked/--local mutex conflict",
    () => {
      // `--experimental` is deliberately ABSENT and `--linked`/`--local` are
      // BOTH set: in Go, pflag's ParseUint failure preempts the experimental
      // gate (`PersistentPreRunE`) and the mutex validation, so this must
      // fail with the flag-parse error — not
      // `LegacyExperimentalRequiredError`, and not
      // `LegacyStorageMutuallyExclusiveFlagsError`.
      const args = [
        "storage",
        "cp",
        "ss:///bucket/a",
        "ss:///bucket/b",
        "--jobs=-1",
        "--linked",
        "--local",
      ];
      const { layer } = setup(args);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(Option.isSome(failure)).toBe(true);
          // The parse failure must never reach the handler: neither the
          // experimental gate nor the mutex check may fire.
          expect(JSON.stringify(exit.cause)).not.toContain(
            "must set the --experimental flag to run this command",
          );
          expect(JSON.stringify(exit.cause)).not.toContain("LegacyStorageMutuallyExclusiveFlags");
          // `normalizeCause` is the exact rendering path `runCli` uses for
          // parse failures — the user-visible line must be pflag's message,
          // byte-identical, with no `Invalid value for flag --jobs:` wrapper.
          expect(normalizeCause(exit.cause).message).toBe(
            'invalid argument "-1" for "-j, --jobs" flag: strconv.ParseUint: parsing "-1": invalid syntax',
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );
});
