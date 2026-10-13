import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Path, Stdio } from "effect";
import { CliOutput, Command } from "effect/cli";

import { GLOBAL_FLAGS } from "../../../command-internal/global-flags.ts";
import { RemovedSurfaceError } from "../../../command-internal/removed-command.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockTelemetryRuntime,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { isolatedHomeLayer } from "../../../../tests/helpers/command-mocks.ts";
import { dbCommand } from "../db.command.ts";

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([dbCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

const USE_PG_DELTA_SUGGESTION =
  "Use --declarative to pull the declarative schema. The diff engine is chosen with --diff-engine or [experimental.pgdelta] enabled in config.toml.";
const EXPERIMENTAL_MESSAGE = "The --experimental structured-dump mode of db pull was removed.";
const EXPERIMENTAL_SUGGESTION =
  "Use --declarative to pull per-object schema files, or pass --experimental=false (or unset SUPABASE_EXPERIMENTAL) for a migration pull.";

const runDbPull = (
  args: ReadonlyArray<string>,
  opts: {
    readonly env?: Readonly<Record<string, string>>;
    readonly files?: Readonly<Record<string, string>>;
    readonly format?: "text" | "json";
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-db-pull-removed-" });
    for (const [file, content] of Object.entries(opts.files ?? {})) {
      yield* fs.makeDirectory(path.dirname(path.join(workdir, file)), { recursive: true });
      yield* fs.writeFileString(path.join(workdir, file), content);
    }
    const argv = ["db", "pull", "--workdir", workdir, ...args];
    const out = mockOutput({ format: opts.format ?? "text" });
    const analytics = mockContextualAnalytics();
    const layer = Layer.mergeAll(
      CliOutput.layer(textCliOutputFormatter()),
      Layer.succeed(CliArgs, { args: argv }),
      Stdio.layerTest({ args: Effect.succeed(argv) }),
      out.layer,
      analytics.layer,
      mockTelemetryRuntime({ configDir: path.join(workdir, ".supabase") }),
      mockTty(),
      mockProcessControl().layer,
      isolatedHomeLayer(workdir, {
        SUPABASE_HOME: workdir,
        SUPABASE_NO_KEYRING: "1",
        SUPABASE_ACCESS_TOKEN: undefined,
        SUPABASE_PROFILE: undefined,
        SUPABASE_EXPERIMENTAL: undefined,
        ...opts.env,
      }),
    );
    const exit = yield* Command.runWith(testRoot, { version: "0.0.0-test" })(argv).pipe(
      Effect.provide(layer),
      Effect.exit,
    );
    return { exit, out, analytics, workdir };
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const removedError = (exit: Exit.Exit<unknown, unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const error = Cause.squash(exit.cause);
  expect(error).toBeInstanceOf(RemovedSurfaceError);
  return error as RemovedSurfaceError;
};

describe("db pull removed surfaces through command dispatch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected network request"));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  for (const flag of ["--use-pg-delta", "--use-pg-delta=false"]) {
    it.live(`rejects ${flag} with the removal error`, () =>
      Effect.gen(function* () {
        const { exit, out, analytics } = yield* runDbPull([flag]);

        const error = removedError(exit);
        expect(error.kind).toBe("flag");
        expect(error.message).toBe("--use-pg-delta was removed.");
        expect(error.suggestion).toBe(USE_PG_DELTA_SUGGESTION);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(out.rawChunks).toEqual([]);

        const events = analytics.captured.filter((c) => c.event === "cli_command_executed");
        expect(events).toHaveLength(1);
        expect(events[0]?.properties).toMatchObject({
          command: "db pull",
          exit_code: 1,
          error_fingerprint: "tag:RemovedSurfaceError:removed_flag",
        });
        expect(events[0]?.properties.flags).toMatchObject({
          "use-pg-delta": flag === "--use-pg-delta",
        });
      }),
    );
  }

  it.live("rejects --use-pg-delta with a missing profile and no credentials", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDbPull(["--use-pg-delta"], {
        env: { SUPABASE_PROFILE: "missing-profile" },
      });

      expect(removedError(exit).message).toBe("--use-pg-delta was removed.");
    }),
  );

  it.live("a missing profile still fails plain db pull with a different error", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDbPull([], { env: { SUPABASE_PROFILE: "missing-profile" } });

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.squash(exit.cause)).not.toBeInstanceOf(RemovedSurfaceError);
    }),
  );

  it.live("does not reject a plain db pull", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDbPull([]);

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.squash(exit.cause)).not.toBeInstanceOf(RemovedSurfaceError);
    }),
  );

  it.live("does not reject --experimental=false over SUPABASE_EXPERIMENTAL=true", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDbPull(["--experimental=false"], {
        env: { SUPABASE_EXPERIMENTAL: "true" },
      });

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.squash(exit.cause)).not.toBeInstanceOf(RemovedSurfaceError);
    }),
  );

  it.live("does not reject --experimental --declarative", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDbPull(["--experimental", "--declarative"]);

      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      expect(Cause.squash(exit.cause)).not.toBeInstanceOf(RemovedSurfaceError);
    }),
  );

  it.live("rejects --use-pg-delta combined with --declarative", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDbPull(["--declarative", "--use-pg-delta"]);

      expect(removedError(exit).message).toBe("--use-pg-delta was removed.");
    }),
  );

  const experimentalCases: ReadonlyArray<{
    readonly title: string;
    readonly args: ReadonlyArray<string>;
    readonly env?: Record<string, string>;
  }> = [
    { title: "--experimental", args: ["--experimental"] },
    { title: "--experimental=true", args: ["--experimental=true"] },
    { title: "SUPABASE_EXPERIMENTAL=true", args: [], env: { SUPABASE_EXPERIMENTAL: "true" } },
    {
      title: "SUPABASE_EXPERIMENTAL=true with --declarative=false",
      args: ["--declarative=false"],
      env: { SUPABASE_EXPERIMENTAL: "true" },
    },
  ];

  for (const { title, args, env } of experimentalCases) {
    it.live(`rejects the structured-dump mode via ${title}`, () =>
      Effect.gen(function* () {
        const { exit, analytics } = yield* runDbPull(args, { env });

        const error = removedError(exit);
        expect(error.kind).toBe("flag");
        expect(error.message).toBe(EXPERIMENTAL_MESSAGE);
        expect(error.suggestion).toBe(EXPERIMENTAL_SUGGESTION);
        expect(fetchSpy).not.toHaveBeenCalled();

        const events = analytics.captured.filter((c) => c.event === "cli_command_executed");
        expect(events).toHaveLength(1);
        expect(events[0]?.properties).toMatchObject({
          command: "db pull",
          exit_code: 1,
          error_fingerprint: "tag:RemovedSurfaceError:removed_flag",
        });
      }),
    );
  }

  it.live("rejects SUPABASE_EXPERIMENTAL set only in supabase/.env", () =>
    Effect.gen(function* () {
      const { exit } = yield* runDbPull([], {
        files: { "supabase/.env": "SUPABASE_EXPERIMENTAL=1\n" },
      });

      expect(removedError(exit).message).toBe(EXPERIMENTAL_MESSAGE);
    }),
  );

  it.live("reports the removal through the JSON error envelope", () =>
    Effect.gen(function* () {
      const { exit, out } = yield* runDbPull(["--use-pg-delta"], { format: "json" });

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.failures).toHaveLength(1);
      expect(out.failures[0]).toMatchObject({
        code: "RemovedSurfaceError",
        message: "--use-pg-delta was removed.",
      });
    }),
  );
});
