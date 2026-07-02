import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer, Option } from "effect";
import { CliOutput, Command } from "effect/unstable/cli";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { LEGACY_GLOBAL_FLAGS } from "../../../shared/legacy/global-flags.ts";
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
import { LegacyExperimentalRequiredError } from "../../shared/legacy-experimental-gate.ts";
import { legacyStorageCommand } from "./storage.command.ts";
import { LegacyStorageMutuallyExclusiveFlagsError } from "./storage.errors.ts";

// Go gates `storageCmd` behind `--experimental` in `PersistentPreRunE`
// (`apps/cli-go/cmd/root.go:91-96`), which cobra runs BEFORE
// `ValidateFlagGroups()` (mutual-exclusivity checks, `cobra@v1.10.2/command.go:985,1010`).
// So `supabase storage ls --linked --local` without `--experimental` must
// surface the experimental-gate error in Go, not the mutex error — this suite
// proves that ordering is wired into the actual `.command.ts` handler
// pipeline for all four leaves, not just the shared helper in isolation.

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
    // real env/files when built. Neither check under test ever reaches that
    // lazy factory, but isolate ambient env defensively anyway.
    processEnvLayer({ SUPABASE_NO_KEYRING: "1" }),
    mockRuntimeInfo(),
    mockProcessControl().layer,
    mockTty({ stdinIsTty: false, stdoutIsTty: false }),
    mockAnalytics().layer,
    Layer.succeed(
      TelemetryRuntime,
      TelemetryRuntime.of({
        configDir: "/tmp/supabase-storage-experimental-gate-test/.supabase",
        tracesDir: "/tmp/supabase-storage-experimental-gate-test/.supabase/traces",
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

describe("legacy storage experimental gate vs mutual-exclusivity ordering (Go PersistentPreRunE parity)", () => {
  const leaves: ReadonlyArray<{ readonly name: string; readonly args: ReadonlyArray<string> }> = [
    { name: "ls", args: ["storage", "ls", "ss:///bucket"] },
    { name: "cp", args: ["storage", "cp", "ss:///bucket/a", "ss:///bucket/b"] },
    { name: "mv", args: ["storage", "mv", "ss:///bucket/a", "ss:///bucket/b"] },
    { name: "rm", args: ["storage", "rm", "ss:///bucket/a"] },
  ];

  for (const { name, args } of leaves) {
    const conflictingArgs = [...args, "--linked", "--local"];

    it.live(
      `${name} --linked --local without --experimental fails with the gate error, not the mutex error`,
      () => {
        const { layer } = setup(conflictingArgs);
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(
            Command.runWith(testRoot, { version: "0.0.0-test" })(conflictingArgs),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const failure = Cause.findErrorOption(exit.cause);
            expect(
              Option.isSome(failure) && failure.value instanceof LegacyExperimentalRequiredError,
            ).toBe(true);
          }
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(`${name} --linked --local with --experimental fails with the mutex error`, () => {
      const withExperimental = [...conflictingArgs, "--experimental"];
      const { layer } = setup(withExperimental);
      return Effect.gen(function* () {
        const exit = yield* Effect.exit(
          Command.runWith(testRoot, { version: "0.0.0-test" })(withExperimental),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Cause.findErrorOption(exit.cause);
          expect(
            Option.isSome(failure) &&
              failure.value instanceof LegacyStorageMutuallyExclusiveFlagsError,
          ).toBe(true);
        }
      }).pipe(Effect.provide(layer));
    });
  }
});
