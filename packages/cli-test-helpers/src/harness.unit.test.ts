import { tmpdir } from "node:os";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path } from "effect";
import { describe, expect, it } from "vitest";
import { createHarness, createSubprocessBaseEnv, exec, makeTempDir } from "./harness.ts";

describe("createSubprocessBaseEnv", () => {
  it("removes inherited agent-detection environment variables", () => {
    expect(
      createSubprocessBaseEnv({
        PATH: "/usr/bin",
        AI_AGENT: "github-copilot-cli",
        CLAUDECODE: "1",
        CODEX_THREAD_ID: "thread",
        CURSOR_TRACE_ID: "trace",
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });

  it("drops undefined values from the subprocess environment", () => {
    expect(
      createSubprocessBaseEnv({
        PATH: "/usr/bin",
        SUPABASE_ACCESS_TOKEN: undefined,
      }),
    ).toEqual({ PATH: "/usr/bin" });
  });
});

describe("makeTempDir", () => {
  it("creates and disposes an isolated working directory", () =>
    makeTempDir("cli-helper-").then((temp) => {
      const inspect = Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return {
          exists: yield* fs.exists(temp.path),
          parent: path.dirname(temp.path),
          name: path.basename(temp.path),
        };
      }).pipe(Effect.provide(BunServices.layer), Effect.runPromise);
      return inspect.then((before) => {
        expect(before.parent).toBe(tmpdir());
        expect(before.name).toMatch(/^cli-helper-/u);
        expect(before.exists).toBe(true);
        return temp[Symbol.asyncDispose]().then(() =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            return yield* fs.exists(temp.path);
          })
            .pipe(Effect.provide(BunServices.layer), Effect.runPromise)
            .then((exists) => {
              expect(exists).toBe(false);
            }),
        );
      });
    }));
});

describe("exec", () => {
  it("reports missing CLI build artifacts", () =>
    makeTempDir("cli-helper-workspace-").then((workspace) => {
      const result = exec(
        createHarness("ts-next", {
          apiUrl: "http://127.0.0.1",
          accessToken: "token",
          workspaceRoot: workspace.path,
        }),
        [],
      );

      const assertion = expect(result).rejects.toMatchObject({
        binaryPath: `${workspace.path}/apps/cli/dist/supabase-next`,
        message: expect.stringContaining(`${workspace.path}/apps/cli/dist/supabase.js`),
      });
      return assertion.finally(() => workspace[Symbol.asyncDispose]());
    }));
});
