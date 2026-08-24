import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect } from "vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { PROJECT_REF } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

// CLI-1489: v2.99.0 introduced a TypeScript config loader in the Bun shell
// that strictly decoded supabase/config.toml through an Effect schema. Any
// non-string field written as env(VAR) — e.g. a port — was rejected before
// env-resolution could run, crashing the CLI at boot with
// ProjectConfigParseError. This test runs against every CLI_HARNESS_TARGET
// (ts-legacy, ts-next) so the regression cannot return on any shell.
//
// A 401 is injected so the test does not need a real API fixture: pre-fix the
// TS shells crashed before any API call, post-fix they reach the (faked) API
// and get the injected error. Either way we only assert that the CLI got
// past config decode.

const writeConfigWithEnvPorts = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, "supabase", "config.toml"),
      [
        'project_id = "with-env-ports"',
        "",
        "[api]",
        'port = "env(SUPABASE_API_PORT)"',
        "",
        "[db]",
        'port = "env(SUPABASE_DB_PORT)"',
        "",
        "[analytics]",
        'port = "env(SUPABASE_ANALYTICS_PORT)"',
        "",
      ].join("\n"),
    );
  });

const ENV_PORTS = {
  SUPABASE_API_PORT: "54321",
  SUPABASE_DB_PORT: "54322",
  SUPABASE_ANALYTICS_PORT: "54327",
};

describe("env-in-config-toml", () => {
  testBehaviour("does not crash on numeric fields", ({ run, workspace, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* writeConfigWithEnvPorts(workspace.path);
        const request = yield* HttpClientRequest.make("POST")(apiUrl + "/_ctrl/error-all").pipe(
          HttpClientRequest.bodyJson({
            status: 401,
            body: { message: "Invalid token" },
          }),
        );
        yield* HttpClient.execute(request);
        const result = yield* Effect.promise(() =>
          run(["secrets", "list", "--project-ref", PROJECT_REF], {
            env: ENV_PORTS,
          }),
        );
        const output = result.stdout + "\n" + result.stderr;
        expect(output).not.toContain("ProjectConfigParseError");
        expect(output).not.toMatch(/Expected number.*env\(SUPABASE_/);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});
