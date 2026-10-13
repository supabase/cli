import { it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, test } from "vitest";
import {
  makeTempCliProject,
  makeTempHome,
  runSupabase,
  runSupabaseEffect,
} from "../../tests/helpers/cli.ts";

describe("CLI feature routing", () => {
  test("reports invalid stack feature configuration during completion", async () => {
    const project = await makeTempCliProject("supabase-main-routing-e2e-");
    const home = makeTempHome();
    try {
      const result = await runSupabase(["__complete", "start", "--"], {
        cwd: project.dir,
        home: home.dir,
        env: {
          SUPABASE_EXPERIMENTAL_STACK: "yes",
          SUPABASE_WORKDIR: undefined,
        },
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("SUPABASE_EXPERIMENTAL_STACK must be 0 or 1");
    } finally {
      await project.cleanup();
      home[Symbol.dispose]();
    }
  });
});

describe.skipIf(process.platform === "win32")("CLI output to a closed pipe", () => {
  /* The agent `status` row puts stdout and stderr on one dead pipe, as in the issue. The
     `--debug` row guards the NodeSink patch and needs an unlinked project: once `--debug`'s ignored
     writes have errored stderr, the project-ref notice is the Output write that finds it dead. The
     `--bogus` row guards the recovery of a final error report written to a closed pipe. */
  it.live.each<[string, "stdout" | "stderr" | "stdout-and-stderr", Record<string, string>]>([
    ["projects list --output-format json", "stdout", {}],
    ["status", "stdout-and-stderr", { CLAUDECODE: "1" }],
    ["projects list --debug --output-format json", "stderr", {}],
    ["projects list --bogus --output-format json", "stdout", {}],
  ])("exits 141 for `%s` with %s on a closed pipe (env %j)", ([args, closedPipe, env]) =>
    Effect.gen(function* () {
      const server = yield* Effect.acquireRelease(
        Effect.try(() =>
          Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json([]) }),
        ),
        (running) => Effect.promise(() => running.stop(true)),
      );
      const home = yield* Effect.acquireRelease(
        Effect.try(() => makeTempHome()),
        (owned) => Effect.sync(() => owned[Symbol.dispose]()),
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = path.join(home.dir, "profile.yaml");
      const url = server.url.origin;
      yield* fs.writeFileString(
        profile,
        `name: e2e\napi_url: ${url}\ndashboard_url: ${url}\nproject_host: x.invalid\n`,
      );

      const result = yield* runSupabaseEffect(args.split(" "), {
        cwd: home.dir,
        home: home.dir,
        closedPipe,
        exitTimeoutMs: 30_000,
        env: {
          ...env,
          SUPABASE_ACCESS_TOKEN: `sbp_${"a".repeat(40)}`,
          SUPABASE_PROFILE: profile,
          /* Unlinked and without Docker, whatever the parent shell exports. */
          SUPABASE_PROJECT_ID: undefined,
          SUPABASE_WORKDIR: undefined,
          DOCKER_HOST: `unix://${path.join(home.dir, "docker.sock")}`,
        },
      });

      /* A hang shows as a harness SIGKILL (timedOutAfterMs), not as a wrong exit code. */
      expect(
        { exitCode: result.exitCode, timedOutAfterMs: result.timedOutAfterMs },
        result.stderr || result.stdout,
      ).toEqual({ exitCode: 141, timedOutAfterMs: undefined });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
