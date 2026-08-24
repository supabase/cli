import { BunFileSystem, BunPath } from "@effect/platform-bun";
import { describe, expect, inject, test } from "vitest";
import { createHarness, exec, makeTempDir } from "@supabase/cli-test-helpers";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpMethod } from "effect/unstable/http";
import { ACCESS_TOKEN, isRecording, PROJECT_REF, TARGET } from "./env.ts";
import { testBehaviour } from "./test-context.ts";

const testLayer = Layer.mergeAll(FetchHttpClient.layer, BunFileSystem.layer, BunPath.layer);

interface HttpRequestOptions extends Omit<RequestInit, "body"> {
  readonly body?: unknown;
}

function httpRequest(input: string, init: HttpRequestOptions): Promise<Response> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const method = init.method ?? "GET";
      if (!HttpMethod.isHttpMethod(method)) {
        return yield* Effect.die(new Error(`Unsupported HTTP method: ${method}`));
      }
      let request = HttpClientRequest.make(method)(input, {
        headers: init.headers === undefined ? {} : new globalThis.Headers(init.headers),
      });
      if (init.body !== undefined) {
        request = yield* HttpClientRequest.bodyJson(request, init.body);
      }
      const response = yield* HttpClient.execute(request);
      const body = yield* response.arrayBuffer;
      return new Response(body, { status: response.status, headers: { ...response.headers } });
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.orDie),
  );
}

const writeExistingConfig = (workspacePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(workspacePath, "supabase"), { recursive: true });
    yield* fs.writeFileString(
      path.join(workspacePath, "supabase", "config.toml"),
      "# existing config\n",
    );
  });

const fileExists = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(filePath);
  });

describe("init", () => {
  testBehaviour("creates supabase/config.toml and exits zero", ({ run, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["init"]));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Finished supabase init");
        expect(
          yield* fileExists((yield* Path.Path).join(workspace.path, "supabase", "config.toml")),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour(
    "exits non-zero if config.toml already exists without --force",
    ({ run, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          yield* writeExistingConfig(workspace.path);
          const result = yield* Effect.promise(() => run(["init"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("force");
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
  );

  testBehaviour("exits zero with --force when config.toml exists", ({ run, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* writeExistingConfig(workspace.path);
        const result = yield* Effect.promise(() => run(["init", "--force"]));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Finished supabase init");
        expect(
          yield* fileExists((yield* Path.Path).join(workspace.path, "supabase", "config.toml")),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("creates VS Code settings with --with-vscode-settings", ({ run, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["init", "--with-vscode-settings"]));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Generated VS Code settings");
        expect(
          yield* fileExists((yield* Path.Path).join(workspace.path, ".vscode", "settings.json")),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("creates IntelliJ settings with --with-intellij-settings", ({ run, workspace }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["init", "--with-intellij-settings"]));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Generated IntelliJ settings");
        expect(
          yield* fileExists((yield* Path.Path).join(workspace.path, ".idea", "deno.xml")),
        ).toBe(true);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("includes debug output with --debug", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["init", "--debug"]));
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("Finished supabase init");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );
});

describe("link", () => {
  // Not using testBehaviour here because the testBehaviour `run` fixture always
  // injects SUPABASE_PROJECT_ID, which the new Go CLI accepts as a substitute for
  // --project-ref in non-TTY mode, bypassing the required-flag check. A raw test
  // lets us omit projectId so the CLI correctly requires the --project-ref flag.
  test("exits non-zero without --project-ref in non-TTY", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const serverUrl = yield* Schema.decodeEffect(Schema.String)(inject("replayServerUrl"));
          const dir = yield* Effect.acquireRelease(
            Effect.promise(() => makeTempDir("cli-e2e-link-no-ref-")),
            (temp) => Effect.promise(() => temp[Symbol.asyncDispose]()),
          );
          const harness = createHarness(TARGET, {
            apiUrl: serverUrl,
            accessToken: ACCESS_TOKEN,
            cwd: dir.path,
          });
          const result = yield* Effect.promise(() => exec(harness, ["link"]));
          expect(result.exitCode).not.toBe(0);
          expect(result.stderr).toContain("project-ref");
        }),
      ),
    ));

  // The testBehaviour run fixture always injects SUPABASE_PROJECT_ID, which the
  // new Go CLI accepts in place of --project-ref, bypassing the required-flag
  // check. Link therefore proceeds to the API and succeeds.
  testBehaviour("links when only SUPABASE_PROJECT_ID is set in non-TTY", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["link"]));
        expect(result.exitCode).toBe(0);
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 401", ({ run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { status: 401, body: { message: "Invalid token" } },
          }),
        );
        const result = yield* Effect.promise(() => run(["link", "--project-ref", PROJECT_REF]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Invalid token");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 403", ({ run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { status: 403, body: { message: "Forbidden" } },
          }),
        );
        const result = yield* Effect.promise(() => run(["link", "--project-ref", PROJECT_REF]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Forbidden");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  testBehaviour("exits non-zero on 500", ({ run, apiUrl }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          httpRequest(`${apiUrl}/_ctrl/error-all`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: { status: 500, body: { message: "Internal Server Error" } },
          }),
        );
        const result = yield* Effect.promise(() => run(["link", "--project-ref", PROJECT_REF]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("Internal Server Error");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  // link makes concurrent Management API calls after the initial project-status and
  // api-keys calls. The concurrent service calls fail silently (non-fatal). Only
  // the first two sequential calls need fixture entries.
  testBehaviour.skipIf(isRecording)(
    "links project successfully",
    ({ run, projectRef, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() => run(["link", "--project-ref", projectRef]));
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished supabase link");
          expect(
            yield* fileExists(
              (yield* Path.Path).join(workspace.path, "supabase", ".temp", "project-ref"),
            ),
          ).toBe(true);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
  );

  testBehaviour.skipIf(isRecording)(
    "--skip-pooler uses direct connection",
    ({ run, projectRef, workspace }) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            run(["link", "--project-ref", projectRef, "--skip-pooler"]),
          );
          expect(result.exitCode).toBe(0);
          expect(result.stdout).toContain("Finished supabase link");
          expect(
            yield* fileExists(
              (yield* Path.Path).join(workspace.path, "supabase", ".temp", "project-ref"),
            ),
          ).toBe(true);
        }).pipe(Effect.provide(testLayer), Effect.orDie),
      ),
  );
});

describe("unlink", () => {
  testBehaviour("exits non-zero when project not linked", ({ run }) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => run(["unlink"]));
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("supabase link");
      }).pipe(Effect.provide(testLayer), Effect.orDie),
    ),
  );

  // The success path (pre-populate project-ref → unlink succeeds) is omitted: the
  // unlink handler deletes the database-password keyring entry on success. On
  // Linux CI (no D-Bus session bus) the keyring call returns an unhandled error
  // and the command exits 1. The not-linked error path above gives meaningful
  // coverage; deeper success-path behaviour is covered by unlink.integration.test.ts.
});
