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

  // Go validates the RAW token as unsigned (`strconv.ParseUint(s, 0, 64)`), so
  // `-0` — which numeric normalization turns into negative zero, passing a
  // `value < 0` check — is rejected, and the message keeps the original
  // spelling (`-01`, not a normalized `-1`). Non-numeric tokens get the same
  // byte-exact pflag message. All expected strings are go1.26 ground truth.
  it.live.each([
    {
      token: "-0",
      message:
        'invalid argument "-0" for "-j, --jobs" flag: strconv.ParseUint: parsing "-0": invalid syntax',
    },
    {
      token: "-01",
      message:
        'invalid argument "-01" for "-j, --jobs" flag: strconv.ParseUint: parsing "-01": invalid syntax',
    },
    {
      token: "abc",
      message:
        'invalid argument "abc" for "-j, --jobs" flag: strconv.ParseUint: parsing "abc": invalid syntax',
    },
    {
      token: "3.5",
      message:
        'invalid argument "3.5" for "-j, --jobs" flag: strconv.ParseUint: parsing "3.5": invalid syntax',
    },
    {
      token: "18446744073709551616",
      message:
        'invalid argument "18446744073709551616" for "-j, --jobs" flag: strconv.ParseUint: parsing "18446744073709551616": value out of range',
    },
  ])(
    "rejects --jobs=$token at parse time with pflag's exact raw-token message",
    ({ token, message }) => {
      const args = ["storage", "cp", "ss:///bucket/a", "ss:///bucket/b", `--jobs=${token}`];
      const { layer } = setup(args);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).not.toContain(
            "must set the --experimental flag to run this command",
          );
          expect(normalizeCause(exit.cause).message).toBe(message);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  // Go's base-0 ParseUint ACCEPTS prefix/underscore forms (`0x10` → 16,
  // `010` → octal 8, `1_0` → 10), so these must clear flag parsing and fail
  // later at the experimental gate — proving the token was not rejected.
  it.live.each([{ token: "0x10" }, { token: "010" }, { token: "1_0" }])(
    "accepts --jobs=$token (Go base-0 form) through flag parsing, reaching the experimental gate",
    ({ token }) => {
      const args = ["storage", "cp", "ss:///bucket/a", "ss:///bucket/b", `--jobs=${token}`];
      const { layer } = setup(args);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(JSON.stringify(exit.cause)).toContain(
            "must set the --experimental flag to run this command",
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );
});
