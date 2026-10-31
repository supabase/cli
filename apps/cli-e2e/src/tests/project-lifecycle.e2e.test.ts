import { Effect, FileSystem, Path } from "effect";
import { describe, expect, inject, test } from "vitest";
import { createHarness, makeTempDir } from "@supabase/cli-test-helpers";
import { ACCESS_TOKEN, isRecording, PROJECT_REF } from "./env.ts";
import { execCli, postControl, runE2e, testBehaviour } from "./test-context.ts";

describe("init", () => {
  testBehaviour("creates supabase/config.toml and exits zero", ({ run, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const result = yield* run(["init"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Finished supabase init");
        expect(yield* fs.exists(path.join(workspace.path, "supabase", "config.toml"))).toBe(true);
      }),
      signal,
    ),
  );

  testBehaviour(
    "exits non-zero if config.toml already exists without --force",
    ({ run, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          yield* fs.makeDirectory(path.join(workspace.path, "supabase"), { recursive: true });
          yield* fs.writeFileString(
            path.join(workspace.path, "supabase", "config.toml"),
            "# existing config\n",
          );
          const result = yield* run(["init"]);
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("force");
        }),
        signal,
      ),
  );

  testBehaviour("exits zero with --force when config.toml exists", ({ run, workspace, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workspace.path, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          path.join(workspace.path, "supabase", "config.toml"),
          "# existing config\n",
        );
        const result = yield* run(["init", "--force"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Finished supabase init");
        expect(yield* fs.exists(path.join(workspace.path, "supabase", "config.toml"))).toBe(true);
      }),
      signal,
    ),
  );

  testBehaviour(
    "creates VS Code settings with --with-vscode-settings",
    ({ run, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const result = yield* run(["init", "--with-vscode-settings"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Generated VS Code settings");
          expect(yield* fs.exists(path.join(workspace.path, ".vscode", "settings.json"))).toBe(
            true,
          );
        }),
        signal,
      ),
  );

  testBehaviour(
    "creates IntelliJ settings with --with-intellij-settings",
    ({ run, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const result = yield* run(["init", "--with-intellij-settings"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Generated IntelliJ settings");
          expect(yield* fs.exists(path.join(workspace.path, ".idea", "deno.xml"))).toBe(true);
        }),
        signal,
      ),
  );

  testBehaviour("includes debug output with --debug", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["init", "--debug"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Finished supabase init");
      }),
      signal,
    ),
  );
});

describe("link", () => {
  // Not using testBehaviour here because its `run` fixture always injects
  // SUPABASE_PROJECT_ID, which the CLI accepts as a substitute for
  // --project-ref in non-TTY mode. A raw test omits it so the CLI correctly
  // requires the --project-ref flag.
  test("exits non-zero without --project-ref in non-TTY", ({ signal }) => {
    const serverUrl = inject("replayServerUrl") as string;
    return runE2e(
      Effect.acquireUseRelease(
        Effect.promise(() => makeTempDir("cli-e2e-link-no-ref-")),
        (dir) =>
          Effect.gen(function* () {
            const harness = createHarness({
              apiUrl: serverUrl,
              accessToken: ACCESS_TOKEN,
              cwd: dir.path,
            });
            const result = yield* execCli(harness, ["link"]);
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr).toContain("project-ref");
          }),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      ),
      signal,
    );
  });

  // The testBehaviour run fixture always injects SUPABASE_PROJECT_ID, which the
  // CLI accepts in place of --project-ref, so link proceeds to the API and succeeds.
  testBehaviour("links when only SUPABASE_PROJECT_ID is set in non-TTY", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["link"]);
        expect(result.exitCode).toBe(0);
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 401", ({ run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 401,
          body: { message: "Invalid token" },
        });
        const result = yield* run(["link", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Invalid token");
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 403", ({ run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 403,
          body: { message: "Forbidden" },
        });
        const result = yield* run(["link", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Forbidden");
      }),
      signal,
    ),
  );

  testBehaviour("exits non-zero on 500", ({ run, apiUrl, signal }) =>
    runE2e(
      Effect.gen(function* () {
        yield* postControl(`${apiUrl}/_ctrl/error-all`, {
          status: 500,
          body: { message: "Internal Server Error" },
        });
        const result = yield* run(["link", "--project-ref", PROJECT_REF]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Internal Server Error");
      }),
      signal,
    ),
  );

  // link's concurrent service calls (after project-status and api-keys) fail
  // silently, so only the first two sequential calls need fixture entries.
  testBehaviour.skipIf(isRecording)(
    "links project successfully",
    ({ run, projectRef, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const result = yield* run(["link", "--project-ref", projectRef]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished supabase link");
          expect(
            yield* fs.exists(path.join(workspace.path, "supabase", ".temp", "project-ref")),
          ).toBe(true);
          expect(
            new TextDecoder("utf-8", { ignoreBOM: true }).decode(
              yield* fs.readFile(
                path.join(workspace.path, "supabase", ".temp", "storage-migration"),
              ),
            ),
          ).toBe("operation-ergonomics");
        }),
        signal,
      ),
  );

  testBehaviour.skipIf(isRecording)(
    "--skip-pooler uses direct connection",
    ({ run, projectRef, workspace, signal }) =>
      runE2e(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const result = yield* run(["link", "--project-ref", projectRef, "--skip-pooler"]);
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished supabase link");
          expect(
            yield* fs.exists(path.join(workspace.path, "supabase", ".temp", "project-ref")),
          ).toBe(true);
        }),
        signal,
      ),
  );
});

describe("unlink", () => {
  testBehaviour("exits non-zero when project not linked", ({ run, signal }) =>
    runE2e(
      Effect.gen(function* () {
        const result = yield* run(["unlink"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("supabase link");
      }),
      signal,
    ),
  );

  // The success path is omitted: unlink deletes a keyring entry on success, and
  // Linux CI (no D-Bus session bus) makes that call exit 1. See
  // unlink.integration.test.ts for success-path coverage.
});
