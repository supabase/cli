import { Effect, FileSystem, Path } from "effect";
import { describe, expect } from "vitest";
import { PROJECT_REF } from "./env.ts";
import { postControl, runE2e, testBehaviour } from "./test-context.ts";

// Regression guard: a non-string field written as `env(VAR)` (e.g.
// a port) must not crash config decoding before env resolution runs.
//
// A 401 is injected so the test doesn't need a real API fixture; it only
// asserts that the CLI got past config decode.

const writeConfigWithEnvPorts = Effect.fnUntraced(function* (dir: string) {
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
  testBehaviour("does not crash on numeric fields", ({ run, workspace, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* writeConfigWithEnvPorts(workspace.path);

        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 401,
          body: { message: "Invalid token" },
        });

        const result = yield* run(["secrets", "list", `--remote=${PROJECT_REF}`], {
          env: ENV_PORTS,
        });

        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).not.toContain("CliConfigParseError");
        expect(output).not.toMatch(/Expected number.*env\(SUPABASE_/);
      }),
      signal,
    ),
  );
});
