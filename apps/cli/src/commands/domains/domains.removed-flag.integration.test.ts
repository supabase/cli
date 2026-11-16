import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Stdio } from "effect";
import { CliOutput, Command } from "effect/cli";

import { AccessTokenRequiredError } from "../../auth/errors.ts";
import { GLOBAL_FLAGS } from "../../command-internal/global-flags.ts";
import { RemovedSurfaceError } from "../../command-internal/removed-command.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import {
  buildTestRuntime,
  isolatedHomeLayer,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockTelemetryRuntime,
} from "../../../tests/helpers/mocks.ts";
import { domainsCommand } from "./domains.command.ts";

const tempRoot = useTempWorkdir("supabase-domains-removed-flag-");

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([domainsCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

const PROJECT_REF = "abcdefghijklmnopqrst";

const SUBCOMMANDS = [
  ["create", "--custom-hostname", "example.com"],
  ["get"],
  ["reverify"],
  ["activate"],
  ["delete"],
] as const;

function runDomains(args: ReadonlyArray<string>, format: "text" | "json" = "text") {
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

describe("domains --include-raw-output through command dispatch", () => {
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
      const { exit } = yield* runDomains(["domains", "get", "--project-ref", PROJECT_REF]);

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.squash(exit.cause)).toBeInstanceOf(AccessTokenRequiredError);
    }),
  );

  for (const [subcommand, ...subArgs] of SUBCOMMANDS) {
    for (const flag of ["--include-raw-output", "--include-raw-output=false"]) {
      it.live(`domains ${subcommand} rejects ${flag} with the removal error`, () =>
        Effect.gen(function* () {
          const { exit, analytics } = yield* runDomains([
            "domains",
            subcommand,
            ...subArgs,
            "--project-ref",
            PROJECT_REF,
            flag,
          ]);

          expect(Exit.isFailure(exit)).toBe(true);
          if (!Exit.isFailure(exit)) return;
          const error = Cause.squash(exit.cause);
          expect(error).toBeInstanceOf(RemovedSurfaceError);
          if (!(error instanceof RemovedSurfaceError)) return;
          expect(error.kind).toBe("flag");
          expect(error.message).toBe("--include-raw-output was removed.");
          expect(error.suggestion).toBe("Use -o json instead.");
          expect(fetchSpy).not.toHaveBeenCalled();

          const events = analytics.captured.filter((c) => c.event === "cli_command_executed");
          expect(events).toHaveLength(1);
          expect(events[0]?.properties).toMatchObject({
            command: `domains ${subcommand}`,
            exit_code: 1,
            error_fingerprint: "tag:RemovedSurfaceError:removed_flag",
          });
        }),
      );
    }
  }

  it.live("reports the removal through the JSON error envelope", () =>
    Effect.gen(function* () {
      const { exit, out } = yield* runDomains(
        ["domains", "get", "--project-ref", PROJECT_REF, "--include-raw-output"],
        "json",
      );

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0]).toMatchObject({
        code: "RemovedSurfaceError",
        message: "--include-raw-output was removed.",
      });
    }),
  );
});
