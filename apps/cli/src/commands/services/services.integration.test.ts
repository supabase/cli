import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  Cause,
  Data,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  PlatformError,
  Predicate,
  Redacted,
  Schema,
  Stdio,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { CommandCredentials } from "../../auth/command-credentials.service.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { INVALID_PROJECT_REF_MESSAGE } from "../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { GLOBAL_FLAGS, OutputFlag } from "../../command-internal/global-flags.ts";
import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { mockTelemetryStateTracked, useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { dockerfileServiceImageRaw } from "../../shared/services/dockerfile-images.ts";
import { postgresImageForDbMajorVersion } from "../../shared/services/services.shared.ts";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { processControlLayer } from "../../shared/runtime/process-control.layer.ts";
import { TelemetryRuntime } from "../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../shared/telemetry/identity.ts";
import { servicesCommand } from "./services.command.ts";
import { services } from "./services.handler.ts";

const LOCAL_POSTGRES_VERSION = dockerfileServiceImageRaw("pg").split(":")[1] ?? "";

/** Shape of one row in the `--output json` services array. */
const ServiceRows = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    local: Schema.String,
    remote: Schema.String,
  }),
);

const decodeServiceRows = Schema.decodeEffect(Schema.fromJsonString(ServiceRows));

// Isolated default workdir: `process.cwd()` would read the developer's real
// `apps/cli/supabase/.temp/` state (e.g. the pinned `postgres-version` written
// by a local `supabase start`), making these tests machine-dependent.
const defaultWorkdir = useTempWorkdir("supabase-services-");

function setup(
  opts: {
    format?: "text" | "json" | "stream-json";
    goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
    workdir?: string;
    accessToken?: string;
    accessTokenFailure?: PlatformError.PlatformError;
    apiUrl?: string;
  } = {},
) {
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const telemetry = mockTelemetryStateTracked();
  const cachedRefs: string[] = [];

  return {
    out,
    telemetry,
    cachedRefs,
    layer: Layer.mergeAll(
      BunServices.layer,
      FetchHttpClient.layer,
      out.layer,
      telemetry.layer,
      Layer.succeed(OutputFlag, opts.goOutput ?? Option.none()),
      Layer.succeed(
        CommandSettings,
        CommandSettings.of({
          startContainerEnvValues: {},
          dbPassword: Option.none(),
          githubToken: Option.none(),
          workdirEnvValue: Option.none(),
          profile: "supabase",
          profileEnvValue: Option.none(),
          supabaseHome: "/tmp/.supabase",
          apiUrl: opts.apiUrl ?? "https://api.supabase.com",
          projectHost: "supabase.co",
          poolerHost: "supabase.com",
          dashboardUrl: "https://supabase.com/dashboard",
          accessToken: Option.none(),
          projectId: Option.none(),
          workdir: opts.workdir ?? defaultWorkdir.current,
          explicitWorkdir: false,
          userAgent: "SupabaseCLI/test",
        }),
      ),
      Layer.succeed(
        CommandCredentials,
        CommandCredentials.of(commandCredentialsMock(opts.accessToken, opts.accessTokenFailure)),
      ),
      Layer.succeed(
        LinkedProjectCache,
        LinkedProjectCache.of({
          cache: (ref) =>
            Effect.sync(() => {
              cachedRefs.push(ref);
            }),
        }),
      ),
    ),
  };
}

function commandCredentialsMock(
  accessToken?: string,
  accessTokenFailure?: PlatformError.PlatformError,
) {
  return {
    getAccessToken:
      accessTokenFailure !== undefined
        ? Effect.fail(accessTokenFailure)
        : Effect.succeed(
            accessToken === undefined
              ? Option.none()
              : Option.some(Redacted.make(accessToken, { label: "SUPABASE_ACCESS_TOKEN" })),
          ),
    saveAccessToken: () => Effect.die("unexpected saveAccessToken"),
    deleteAccessToken: Effect.die("unexpected deleteAccessToken"),
    deleteAllProjectCredentials: Effect.void,
    deleteProjectCredential: () => Effect.succeed(false),
  };
}

const testRoot = Command.make("supabase").pipe(
  Command.withSubcommands([servicesCommand]),
  Command.withGlobalFlags(GLOBAL_FLAGS),
);

const makeWorkdir = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectoryScoped({ prefix: "supabase-services-" });
});

const makeProjectWithConfig = Effect.fnUntraced(function* (config: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workdir = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-services-config-" });
  const configDir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(configDir, { recursive: true });
  yield* fs.writeFileString(path.join(configDir, "config.toml"), config);
  return workdir;
});

const makeProjectWithConfigFiles = Effect.fnUntraced(function* (opts: {
  toml: string;
  json: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workdir = yield* makeProjectWithConfig(opts.toml);
  yield* fs.writeFileString(path.join(workdir, "supabase", "config.json"), opts.json);
  return workdir;
});

const makeProjectWithDbMajorVersion = (majorVersion: number) =>
  makeProjectWithConfig(`[db]\nmajor_version = ${majorVersion}\n`);

const writeTempFile = Effect.fnUntraced(function* (workdir: string, name: string, content: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = path.join(workdir, "supabase", ".temp");
  yield* fs.makeDirectory(tempDir, { recursive: true });
  yield* fs.writeFileString(path.join(tempDir, name), content);
});

function postgresVersionForDbMajorVersion(majorVersion: number): string {
  const image = postgresImageForDbMajorVersion(majorVersion);
  if (image === undefined) {
    throw new Error(`Missing Postgres image for db major ${majorVersion}.`);
  }
  return image.slice(image.lastIndexOf(":") + 1);
}

class ServicesTestServerError extends Data.TaggedError("ServicesTestServerError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function expectFailureTag(exit: Exit.Exit<unknown, unknown>, tag: string) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    return;
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isSome(failure)) {
    expect(Predicate.isTagged(failure.value, tag), Cause.pretty(exit.cause)).toBe(true);
  }
}

describe("services", () => {
  it.live("surfaces credential storage permission failures", () => {
    const { layer } = setup({
      accessTokenFailure: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        description: "permission denied",
      }),
    });

    return Effect.gen(function* () {
      const exit = yield* services({}).pipe(Effect.provide(layer), Effect.exit);
      expectFailureTag(exit, "PlatformError");
    });
  });

  // `it.live`: the command wiring drives real timeouts, so it needs the live clock.
  it.live("runs tokenless local service listing through command wiring", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir();
      const out = mockOutput({ format: "text", interactive: false });
      const analytics = mockAnalytics();
      const args = ["services"];
      const layer = Layer.mergeAll(
        BunServices.layer,
        processControlLayer,
        CliOutput.layer(textCliOutputFormatter()),
        out.layer,
        analytics.layer,
        processEnvLayer({ SUPABASE_HOME: workdir, SUPABASE_NO_KEYRING: "1" }),
        mockRuntimeInfo({ cwd: workdir, homeDir: workdir }),
        mockTty({ stdinIsTty: false, stdoutIsTty: false }),
        Stdio.layerTest({ args: Effect.succeed(args) }),
        Layer.succeed(
          TelemetryRuntime,
          TelemetryRuntime.of({
            configDir: path.join(workdir, ".supabase"),
            tracesDir: path.join(workdir, ".supabase", "traces"),
            consent: "granted",
            showDebug: false,
            deviceId: "test-device-id",
            sessionId: "test-session-id",
            identity: makeTelemetryIdentity(undefined),
            isFirstRun: false,
            isTty: false,
            isCi: false,
            os: "linux",
            arch: "x64",
            cliVersion: "0.1.0",
          }),
        ),
      );

      yield* Command.runWith(testRoot, { version: "0.0.0-test" })(args).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).toContain("supabase/gotrue");
      expect(out.stderrText).not.toContain("Access token not provided");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("prints the services table by default", () => {
    const { layer, out } = setup();

    return Effect.gen(function* () {
      yield* services({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).toContain("supabase/gotrue");
      expect(out.stdoutText).toContain("supabase/storage-api");
      expect(out.stderrText).toBe("");
    });
  });

  it.live("emits a services JSON array for --output json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });

    return Effect.gen(function* () {
      yield* services({}).pipe(Effect.provide(layer));

      const rows = yield* decodeServiceRows(out.stdoutText);
      expect(rows).toHaveLength(10);
      expect(rows[0]).toMatchObject({
        name: "supabase/postgres",
        local: LOCAL_POSTGRES_VERSION,
      });
    });
  });

  it.live("reports the configured Postgres version for local projects", () =>
    Effect.gen(function* () {
      const workdir = yield* makeProjectWithDbMajorVersion(15);
      const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

      yield* services({}).pipe(Effect.provide(layer));

      const rows = yield* decodeServiceRows(out.stdoutText);
      expect(rows).toContainEqual(
        expect.objectContaining({
          name: "supabase/postgres",
          local: postgresVersionForDbMajorVersion(15),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("ignores config.json and reads legacy config.toml for local image selection", () =>
    Effect.gen(function* () {
      const workdir = yield* makeProjectWithConfigFiles({
        toml: "[db]\nmajor_version = 15\n",
        json: '{"db":{"major_version":14}}',
      });
      const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

      yield* services({}).pipe(Effect.provide(layer));

      const rows = yield* decodeServiceRows(out.stdoutText);
      expect(rows).toContainEqual(
        expect.objectContaining({
          name: "supabase/postgres",
          local: postgresVersionForDbMajorVersion(15),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("applies linked-project remote config overrides when choosing the local image", () =>
    Effect.gen(function* () {
      const workdir = yield* makeProjectWithConfig(`
[db]
major_version = 17

[remotes.linked]
project_id = "abcdefghijklmnopqrst"

[remotes.linked.db]
major_version = 15
`);
      yield* writeTempFile(workdir, "project-ref", "abcdefghijklmnopqrst");
      const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

      yield* services({}).pipe(Effect.provide(layer));

      const rows = yield* decodeServiceRows(out.stdoutText);
      expect(rows).toContainEqual(
        expect.objectContaining({
          name: "supabase/postgres",
          local: postgresVersionForDbMajorVersion(15),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("warns and skips the remote lookup for a malformed linked project ref", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir();
      yield* writeTempFile(workdir, "project-ref", "not-a-valid-ref");
      const { layer, out } = setup({ workdir });

      yield* services({}).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(INVALID_PROJECT_REF_MESSAGE);
      expect(out.stdoutText).toContain("supabase/postgres");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  // A token present doesn't bypass the format guard (the warning is
  // unconditional on login too) — same code path as the previous test, so this
  // isn't new branch coverage, just pinning that login state can't skip it.
  it.live("still warns on a malformed ref even when logged in", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir();
      yield* writeTempFile(workdir, "project-ref", "not-a-valid-ref");
      const { layer, out } = setup({ workdir, accessToken: "sbp_test-token" });

      yield* services({}).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(INVALID_PROJECT_REF_MESSAGE);
      expect(out.stdoutText).toContain("supabase/postgres");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("fetches and merges remote versions for a valid ref when logged in", () =>
    Effect.gen(function* () {
      const workdir = yield* makeWorkdir();
      yield* writeTempFile(workdir, "project-ref", "abcdefghijklmnopqrst");

      const server = yield* Effect.acquireRelease(
        Effect.try({
          catch: (cause) =>
            new ServicesTestServerError({ message: "test API server failed to start", cause }),
          try: () =>
            Bun.serve({
              hostname: "127.0.0.1",
              port: 0,
              fetch(request) {
                const url = new URL(request.url);
                if (url.pathname === "/v1/projects/abcdefghijklmnopqrst") {
                  return Response.json({
                    id: "abcdefghijklmnopqrst",
                    ref: "abcdefghijklmnopqrst",
                    organization_id: "org-id",
                    organization_slug: "org",
                    name: "Linked Project",
                    region: "us-east-1",
                    created_at: "2026-03-13T12:00:00.000Z",
                    status: "ACTIVE_HEALTHY",
                    database: {
                      host: "db.supabase.internal",
                      version: "17.6.1.200",
                      postgres_engine: "17",
                      release_channel: "ga",
                    },
                  });
                }

                if (url.pathname === "/v1/projects/abcdefghijklmnopqrst/api-keys") {
                  // No service-role key: proves only the fetch+merge wiring, not the
                  // tenant probe (covered in services.shared.unit.test.ts).
                  return Response.json([
                    {
                      name: "anon",
                      id: "publishable-id",
                      type: "publishable",
                      api_key: "publishable-key",
                      description: null,
                    },
                  ]);
                }

                return new Response("not found", { status: 404 });
              },
            }),
        }),
        (running) =>
          // `acquireRelease` types the release as `Effect<unknown, never, _>`, so die instead
          // of fail; the tagged wrapper keeps a failed stop attributable.
          Effect.tryPromise({
            try: () => running.stop(true),
            catch: (cause) =>
              new ServicesTestServerError({ message: "test API server failed to stop", cause }),
          }).pipe(Effect.orDie),
      );

      const { layer, out } = setup({
        workdir,
        accessToken: "sbp_test-token",
        apiUrl: server.url.origin,
        goOutput: Option.some("json"),
      });

      yield* services({}).pipe(Effect.provide(layer));

      expect(out.stderrText).not.toContain(INVALID_PROJECT_REF_MESSAGE);
      const rows = yield* decodeServiceRows(out.stdoutText);
      expect(rows).toContainEqual(
        expect.objectContaining({ name: "supabase/postgres", remote: "17.6.1.200" }),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("reports pinned legacy temp service versions", () =>
    Effect.gen(function* () {
      const workdir = yield* makeProjectWithDbMajorVersion(15);
      yield* writeTempFile(workdir, "postgres-version", "15.1.0.117\n");
      yield* writeTempFile(workdir, "gotrue-version", "2.74.2\n");
      yield* writeTempFile(workdir, "storage-version", "v1.28.0\n");
      const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

      yield* services({}).pipe(Effect.provide(layer));

      const rows = yield* decodeServiceRows(out.stdoutText);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "supabase/postgres", local: "15.1.0.117" }),
          expect.objectContaining({ name: "supabase/gotrue", local: "2.74.2" }),
          expect.objectContaining({ name: "supabase/storage-api", local: "v1.28.0" }),
        ]),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("reports the Deno 1 edge-runtime image instead of the temp pin", () =>
    Effect.gen(function* () {
      const workdir = yield* makeProjectWithConfig("[edge_runtime]\ndeno_version = 1\n");
      yield* writeTempFile(workdir, "edge-runtime-version", "v9.9.9\n");
      const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

      yield* services({}).pipe(Effect.provide(layer));

      const rows = yield* decodeServiceRows(out.stdoutText);
      expect(rows).toContainEqual(
        expect.objectContaining({
          name: "supabase/edge-runtime",
          local: "v1.68.4",
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("prints config load errors and falls back to the default matrix", () =>
    Effect.gen(function* () {
      const workdir = yield* makeProjectWithConfig("[db]\nmajor_version = ");
      yield* writeTempFile(workdir, "storage-version", "v9.9.9\n");
      const { layer, out } = setup({ workdir });

      yield* services({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).not.toContain("v9.9.9");
      expect(out.stderrText).not.toBe("");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("emits structured JSON for --output pretty combined with --output-format json", () => {
    // --output pretty defers to --output-format json instead of forcing the
    // human-readable table.
    const { layer, out } = setup({ format: "json", goOutput: Option.some("pretty") });

    return Effect.gen(function* () {
      yield* services({}).pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: LOCAL_POSTGRES_VERSION,
          }),
        ]),
      });
    });
  });

  it.live("emits structured JSON for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json" });

    return Effect.gen(function* () {
      yield* services({}).pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: LOCAL_POSTGRES_VERSION,
          }),
        ]),
      });
    });
  });

  it.live("emits a TOML services array for --output toml", () => {
    const { layer, out } = setup({ goOutput: Option.some("toml") });

    return Effect.gen(function* () {
      yield* services({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("[[services]]");
      // The hand-written imageVersion struct emits PascalCase field names in
      // declaration order (Name, Local, Remote) with 2-space indent.
      expect(out.stdoutText).toContain('  Name = "supabase/postgres"');
    });
  });

  it.live("emits a YAML services array for --output yaml", () => {
    const { layer, out } = setup({ goOutput: Option.some("yaml") });

    return Effect.gen(function* () {
      yield* services({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("- name: supabase/postgres");
      expect(out.stdoutText).toContain(`local: ${LOCAL_POSTGRES_VERSION}`);
    });
  });

  it.live("rejects --output env", () => {
    const { layer } = setup({ goOutput: Option.some("env") });

    return Effect.gen(function* () {
      const exit = yield* services({}).pipe(Effect.provide(layer), Effect.exit);
      expectFailureTag(exit, "ServicesEnvNotSupportedError");
    });
  });

  it.live("warns to stderr when the project-ref file exists but cannot be read", () =>
    // A directory at the ref path makes `exists()` true but `readFileString()`
    // fail (EISDIR), exercising the read-error branch distinct from "file absent".
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workdir = yield* makeWorkdir();
      yield* fs.makeDirectory(path.join(workdir, "supabase", ".temp", "project-ref"), {
        recursive: true,
      });
      const { layer, out } = setup({ workdir });

      yield* services({}).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("failed to load project ref: ");
      expect(out.stdoutText).toContain("supabase/postgres");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("flushes telemetry state after the command finishes", () => {
    const { layer, telemetry } = setup();

    return Effect.gen(function* () {
      yield* services({}).pipe(Effect.provide(layer));
      expect(telemetry.flushed).toBe(true);
    });
  });
});
