import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Stdio } from "effect";
import { CliOutput, Command } from "effect/cli";

import { AccessTokenRequiredError } from "../../../auth/errors.ts";
import { GLOBAL_FLAGS } from "../../../command-internal/global-flags.ts";
import { RemovedSurfaceError } from "../../../command-internal/removed-command.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import {
  buildTestRuntime,
  isolatedHomeLayer,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockTelemetryRuntime,
} from "../../../../tests/helpers/mocks.ts";
import { functionsCommand } from "../functions.command.ts";

const tempRoot = useTempWorkdir("supabase-functions-download-removed-flag-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([functionsCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

// The real `managementApiRuntimeLayer` resolves its token from the raw process env, the OS
// keyring, and `<home>/.supabase/access-token`, so all three are pinned to an empty state.
function runDownload(args: ReadonlyArray<string>, format: "text" | "json" = "text") {
  const out = mockOutput({ format });
  const analytics = mockContextualAnalytics();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: mockCommandPlatformApi(),
      cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
      analytics,
      runtimeInfo: isolatedHomeLayer(tempRoot.current, {
        SUPABASE_HOME: tempRoot.current,
        SUPABASE_NO_KEYRING: "1",
      }),
    }),
    CliOutput.layer(textCliOutputFormatter()),
    mockTelemetryRuntime({ configDir: `${tempRoot.current}/.supabase` }),
    Stdio.layerTest({ args: Effect.succeed(args) }),
  );
  return Command.runWith(testRoot, { version: "0.0.0-test" })(args).pipe(
    Effect.exit,
    Effect.provide(layer),
    Effect.map((exit) => ({ exit, out, analytics })),
  );
}

describe("functions download --legacy-bundle through command dispatch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network request"));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it.live("needs credentials without the removed flag", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDownload(["functions", "download", "hello"]);

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(AccessTokenRequiredError);
    }),
  );

  for (const flag of ["--legacy-bundle", "--legacy-bundle=false"]) {
    it.live(`rejects ${flag} with the removal error and no credentials`, () =>
      Effect.gen(function* () {
        const { exit, analytics } = yield* runDownload(["functions", "download", "hello", flag]);

        expect(Exit.isFailure(exit)).toBe(true);
        if (!Exit.isFailure(exit)) return;
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(RemovedSurfaceError);
        if (!(error instanceof RemovedSurfaceError)) return;
        expect(error.kind).toBe("flag");
        expect(error.message).toBe("--legacy-bundle was removed.");
        expect(error.suggestion).toBe(
          "Retry with `supabase functions download --use-api hello` to unbundle server-side without Docker. If that also fails and the Function was deployed with a CLI older than 1.120.0, redeploy it with the current CLI.",
        );
        expect(fetchSpy).not.toHaveBeenCalled();

        const events = analytics.captured.filter((c) => c.event === "cli_command_executed");
        expect(events).toHaveLength(1);
        expect(events[0]?.properties).toMatchObject({
          command: "functions download",
          exit_code: 1,
          error_fingerprint: "tag:RemovedSurfaceError:removed_flag",
        });
      }),
    );
  }

  it.live("keeps the <slug> placeholder when no function name was given", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDownload(["functions", "download", "--legacy-bundle"]);

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(RemovedSurfaceError);
      if (!(error instanceof RemovedSurfaceError)) return;
      expect(error.suggestion).toContain("`supabase functions download --use-api <slug>`");
    }),
  );

  it.live("reports the removal through the JSON error envelope", () =>
    Effect.gen(function* () {
      const { exit, out } = yield* runDownload(
        ["functions", "download", "hello", "--legacy-bundle"],
        "json",
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0]).toMatchObject({
        code: "RemovedSurfaceError",
        message: "--legacy-bundle was removed.",
      });
    }),
  );
});
