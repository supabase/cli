import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Path } from "effect";

import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";
import { v2ProjectConfigResponse } from "../../../../tests/helpers/config-fixtures.ts";

class ConfigPullServerError extends Data.TaggedError("ConfigPullServerError")<{
  readonly cause: unknown;
}> {}

// A fake-but-well-formed token bypasses the eager SUPABASE_ACCESS_TOKEN check, so the run
// reaches this command's own handler instead of failing generically first.
const TEST_TOKEN = "sbp_" + "a".repeat(40);
const TEST_REF = "abcdefghijklmnopqrst";

describe("config pull CLI surface", () => {
  it.live("plain `config pull` parses — no boolean flag is accidentally required", () =>
    Effect.gen(function* () {
      // A Flag.boolean without Flag.withDefault(false) is a required flag, so a missing default
      // on --dry-run/--force would fail plain `supabase config pull`. Integration tests hand the
      // handler pre-built flags and never exercise the parser, so this needs pinning at the
      // subprocess boundary.
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-config-pull-e2e-" });
      const { stdout, stderr } = yield* runSupabaseEffect(["config", "pull"], {
        cwd,
        env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN },
      });
      const combined = `${stdout}\n${stderr}`;
      expect(combined).not.toContain("required flag");
      // Positive anchor: this hermetic cwd has no config file, so only a run that actually
      // reached the handler prints this exact load error — a vacuously-green regression (e.g.
      // the binary failing to start) wouldn't.
      expect(combined).toContain(
        "failed to read supabase/config.toml or supabase/config.json: file not found. Run `supabase init` to create one.",
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("reads a piped confirmation through the production command layer", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-config-pull-piped-e2e-",
      });
      const server = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                const url = new URL(request.url);
                if (
                  request.method === "GET" &&
                  url.pathname === `/v2/projects/${TEST_REF}/config`
                ) {
                  return Response.json(v2ProjectConfigResponse({ ref: TEST_REF }));
                }
                return new Response("not found", { status: 404 });
              },
            }),
          catch: (cause) => new ConfigPullServerError({ cause }),
        }),
        (running) => Effect.promise(() => running.stop(true)),
      );
      const configDir = path.join(cwd, "supabase");
      const configPath = path.join(configDir, "config.toml");
      const profilePath = path.join(cwd, "profile.yaml");
      const before = `project_id = "${TEST_REF}"\n[api]\nmax_rows = 500\n`;
      yield* fs.makeDirectory(configDir, { recursive: true });
      yield* fs.writeFileString(configPath, before);
      yield* fs.writeFileString(
        profilePath,
        [
          "name: config-pull-piped-e2e",
          `api_url: "${server.url.origin}"`,
          `dashboard_url: "${server.url.origin}"`,
          'project_host: "example.invalid"',
          "",
        ].join("\n"),
      );

      const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
        ["config", "pull", "--project-ref", TEST_REF],
        {
          cwd,
          stdin: "n\n",
          env: {
            SUPABASE_ACCESS_TOKEN: TEST_TOKEN,
            SUPABASE_PROFILE: profilePath,
            SUPABASE_WORKDIR: cwd,
          },
        },
      );

      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      expect(stderr).toContain(
        `Apply 1 change(s) to ${path.join("supabase", "config.toml")}? [Y/n] n\n`,
      );
      expect(stdout).toContain("not written (declined)");
      expect(yield* fs.readFileString(configPath)).toBe(before);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
