import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Data, Effect, FileSystem, Path } from "effect";

import { v2ProjectConfigResponse } from "../../../../tests/helpers/config-fixtures.ts";
import { runSupabaseEffect } from "../../../../tests/helpers/cli.ts";

class ConfigPushServerError extends Data.TaggedError("ConfigPushServerError")<{
  readonly cause: unknown;
}> {}

const E2E_TIMEOUT_MS = 30_000;
const TEST_PROJECT_REF = "abcdefghijklmnopqrst";
const TEST_TOKEN = "sbp_" + "a".repeat(40);

/**
 * Golden-path e2e: exercises the real compiled-binary boundary for the only
 * network-free failure path in `config push` — a malformed `supabase/config.toml`
 * aborts before any API call. Validates that `Command.provide` + the runtime
 * layer + `withJsonErrorHandling` surface the parse error with exit code 1.
 * Per-service diff/output parity is covered by the unit + integration suites.
 */
describe("supabase config push", () => {
  it.live(
    "aborts with exit 1 on a malformed config.toml before any network call",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const projectDir = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-config-push-e2e-",
        });
        yield* fs.makeDirectory(path.join(projectDir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(projectDir, "supabase", "config.toml"), "malformed");
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["config", "push", "--project-ref", TEST_PROJECT_REF],
          { cwd: projectDir, env: { SUPABASE_ACCESS_TOKEN: TEST_TOKEN } },
        );
        expect(exitCode).toBe(1);
        expect(`${stdout}${stderr}`).toContain("config.toml");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
  it.live.each(["n", "y"] as const)(
    "agent auto-detection honors piped %s through the built CLI",
    (answer) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* fs.makeTempDirectoryScoped({
          prefix: "supabase-config-push-consent-e2e-",
        });
        const writes: string[] = [];
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
                    url.pathname === `/v2/projects/${TEST_PROJECT_REF}/config`
                  ) {
                    return Response.json(v2ProjectConfigResponse({ ref: TEST_PROJECT_REF }));
                  }
                  if (
                    request.method === "GET" &&
                    url.pathname === `/v1/projects/${TEST_PROJECT_REF}`
                  ) {
                    return new Response("unavailable", { status: 503 });
                  }
                  if (request.method === "GET" && url.pathname.endsWith("/billing/addons")) {
                    return Response.json({ available_addons: [] });
                  }
                  if (request.method === "PATCH" && url.pathname.endsWith("/postgrest")) {
                    return request.text().then((body) => {
                      writes.push(body);
                      return Response.json({
                        db_schema: "",
                        db_extra_search_path: "",
                        max_rows: 500,
                        db_pool: null,
                        db_pool_acquisition_timeout: null,
                      });
                    });
                  }
                  return new Response("not found", { status: 404 });
                },
              }),
            catch: (cause) => new ConfigPushServerError({ cause }),
          }),
          (running) => Effect.promise(() => running.stop(true)),
        );
        yield* fs.makeDirectory(path.join(cwd, "supabase"));
        yield* fs.writeFileString(
          path.join(cwd, "supabase", "config.toml"),
          'project_id = "test"\n[api]\nmax_rows = 500\n',
        );
        const profilePath = path.join(cwd, "profile.yaml");
        yield* fs.writeFileString(
          profilePath,
          `name: config-push-consent-e2e\napi_url: ${server.url.origin}\ndashboard_url: ${server.url.origin}\nproject_host: example.invalid\n`,
        );
        const { exitCode, stdout, stderr } = yield* runSupabaseEffect(
          ["config", "push", "--project-ref", TEST_PROJECT_REF],
          {
            cwd,
            stdin: `${answer}\n`,
            env: {
              SUPABASE_PROFILE: profilePath,
              SUPABASE_ACCESS_TOKEN: TEST_TOKEN,
              SUPABASE_WORKDIR: cwd,
              SUPABASE_YES: undefined,
              CODEX_SANDBOX: "1",
            },
          },
        );
        expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
        expect(writes).toEqual(answer === "y" ? ['{"max_rows":500}'] : []);
        expect(stdout).toContain(`"status":"${answer === "y" ? "updated" : "skipped"}"`);
        expect(stderr).toContain("api.max_rows [update]");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    E2E_TIMEOUT_MS,
  );
});
