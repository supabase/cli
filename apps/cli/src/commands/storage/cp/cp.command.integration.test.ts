import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { normalizeCause } from "../../../shared/output/normalize-error.ts";
import { GLOBAL_FLAGS } from "../../../command-internal/global-flags.ts";
import {
  mockAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import { makeTelemetryIdentity } from "../../../shared/telemetry/identity.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { storageCommand } from "../storage.command.ts";

// Proves `--jobs`'s negative-value rejection is wired into the real command tree, ahead of the
// `--experimental` gate and the `--linked`/`--local` mutex check in the handler — not just
// reachable by calling `storageCp` directly with a handcrafted flags object, which
// `cp.integration.test.ts` can't exercise since it calls the handler directly.
const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([storageCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

function setup(args: ReadonlyArray<string>) {
  const out = mockOutput({ format: "text" });
  const layer = Layer.mergeAll(
    BunServices.layer,
    CliOutput.layer(textCliOutputFormatter()),
    out.layer,
    Layer.succeed(CliArgs, { args }),
    // The jobs check never reaches `storageGatewayRuntimeLayer`'s lazy cliSettings/credentials
    // factory, but isolate ambient env defensively anyway.
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

describe("storage cp --jobs negative rejection (command-tree wiring)", () => {
  it.live(
    "rejects --jobs=-1 with pflag's exact ParseUint message, ahead of the experimental gate and the --linked/--local mutex conflict",
    () => {
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
          expect(JSON.stringify(exit.cause)).not.toContain(
            "must set the --experimental flag to run this command",
          );
          expect(JSON.stringify(exit.cause)).not.toContain("StorageMutuallyExclusiveFlags");
          // `normalizeCause` is the same rendering path `runCli` uses for parse failures.
          expect(normalizeCause(exit.cause).message).toBe(
            'invalid argument "-1" for "-j, --jobs" flag: strconv.ParseUint: parsing "-1": invalid syntax',
          );
        }
      }).pipe(Effect.provide(layer));
    },
  );

  // `-0` normalizes to negative zero in a numeric check but must still be rejected with its
  // original spelling (`-01`, not `-1`); non-numeric tokens get the same exact pflag message.
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
    // The value and error both get shell-escaped, so quotes/backslashes/newlines stay one
    // escaped line, never raw, in stderr.
    {
      token: 'a"b',
      message:
        'invalid argument "a\\"b" for "-j, --jobs" flag: strconv.ParseUint: parsing "a\\"b": invalid syntax',
    },
    {
      token: "a\\b",
      message:
        'invalid argument "a\\\\b" for "-j, --jobs" flag: strconv.ParseUint: parsing "a\\\\b": invalid syntax',
    },
    {
      token: "1\n2",
      message:
        'invalid argument "1\\n2" for "-j, --jobs" flag: strconv.ParseUint: parsing "1\\n2": invalid syntax',
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

  // `0x10`→16, `010`→octal 8, `1_0`→10: valid base-0 forms that must clear parsing.
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

  // Flags are declared ahead of the positionals in cp.command.ts's config record, so a
  // malformed `--jobs` wins even when `src`/`dst` are missing.
  it.live.each([
    { label: "zero positionals", args: ["storage", "cp", "--jobs=-1"] },
    { label: "one positional", args: ["storage", "cp", "onearg", "--jobs=-1"] },
  ])("rejects --jobs=-1 ahead of missing operands ($label)", ({ args }) => {
    const { layer } = setup(args);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).not.toContain("MissingArgument");
        expect(normalizeCause(exit.cause).message).toBe(
          'invalid argument "-1" for "-j, --jobs" flag: strconv.ParseUint: parsing "-1": invalid syntax',
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("still reports the missing operand when --jobs is valid", () => {
    const args = ["storage", "cp", "--jobs=2"];
    const { layer } = setup(args);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Command.runWith(testRoot, { version: "0.0.0-test" })(args));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(normalizeCause(exit.cause).message).toBe("Missing required argument: src");
      }
    }).pipe(Effect.provide(layer));
  });
});
