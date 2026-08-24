import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { CliOutput, Command } from "effect/unstable/cli";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  FileSystem,
  Formatter,
  Layer,
  Option,
  Predicate,
  Redacted,
  Schema,
  Stdio,
  Path,
} from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { LegacyCredentials } from "../../auth/legacy-credentials.service.ts";
import { LegacyCliConfig } from "../../config/legacy-cli-config.service.ts";
import { INVALID_PROJECT_REF_MESSAGE } from "../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../telemetry/legacy-linked-project-cache.service.ts";
import { LEGACY_GLOBAL_FLAGS, LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { makeLegacyViperEnvLayer } from "../../../shared/legacy/legacy-viper-env.ts";
import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import { mockLegacyTelemetryStateTracked } from "../../../../tests/helpers/legacy-mocks.ts";
import { useLegacyTempWorkdir } from "../../../../tests/helpers/legacy-mocks.ts";
import {
  listLocalServiceVersions,
  postgresImageForDbMajorVersion,
} from "../../../shared/services/services.shared.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import { processControlLayer } from "../../../shared/runtime/process-control.layer.ts";
import { TelemetryRuntime } from "../../../shared/telemetry/runtime.service.ts";
import { makeTelemetryIdentity } from "../../../shared/telemetry/identity.ts";
import { legacyServicesCommand } from "./services.command.ts";
import { legacyServices } from "./services.handler.ts";

const LOCAL_POSTGRES_SERVICE = listLocalServiceVersions().find(
  (service) => service.name === "supabase/postgres",
);

if (LOCAL_POSTGRES_SERVICE === undefined) {
  throw new Error("Missing supabase/postgres in local service versions.");
}

const LOCAL_POSTGRES_VERSION = LOCAL_POSTGRES_SERVICE.local;
const legacyTestConfigProvider = ConfigProvider.fromEnv({ preserveEmptyStrings: true });
const legacyTestViperLayer = makeLegacyViperEnvLayer(legacyTestConfigProvider);
const tempRoot = useLegacyTempWorkdir("supabase-services-");

const ServiceRowsSchema = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    local: Schema.String,
    remote: Schema.String,
  }),
);

function setup(
  opts: {
    format?: "text" | "json" | "stream-json";
    goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
    workdir?: string;
    accessToken?: string;
    apiUrl?: string;
  } = {},
) {
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cachedRefs: string[] = [];

  return {
    out,
    telemetry,
    cachedRefs,
    layer: Layer.mergeAll(
      BunServices.layer,
      ConfigProvider.layer(legacyTestConfigProvider),
      legacyTestViperLayer,
      FetchHttpClient.layer,
      out.layer,
      telemetry.layer,
      Layer.succeed(LegacyOutputFlag, opts.goOutput ?? Option.none()),
      Layer.succeed(
        LegacyCliConfig,
        LegacyCliConfig.of({
          profile: "supabase",
          apiUrl: opts.apiUrl ?? "https://api.supabase.com",
          projectHost: "supabase.co",
          poolerHost: "supabase.com",
          dashboardUrl: "https://supabase.com/dashboard",
          accessToken: Option.none(),
          projectId: Option.none(),
          workdir: opts.workdir ?? process.cwd(),
          userAgent: "SupabaseCLI/test",
        }),
      ),
      Layer.succeed(
        LegacyCredentials,
        LegacyCredentials.of(legacyCredentialsMock(opts.accessToken)),
      ),
      Layer.succeed(
        LegacyLinkedProjectCache,
        LegacyLinkedProjectCache.of({
          cache: (ref) =>
            Effect.sync(() => {
              cachedRefs.push(ref);
            }),
        }),
      ),
    ),
  };
}

function legacyCredentialsMock(accessToken?: string) {
  return {
    getAccessToken: Effect.succeed(
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

const legacyTestRoot = Command.make("supabase").pipe(
  Command.withSubcommands([legacyServicesCommand]),
  Command.withGlobalFlags(LEGACY_GLOBAL_FLAGS),
);

function writeProjectFile(workdir: string, relativePath: string, content: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = path.join(workdir, "supabase", relativePath);
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, content);
  }).pipe(Effect.provide(BunServices.layer));
}

function makeProjectDirectory(workdir: string, relativePath: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.join(workdir, "supabase", relativePath), { recursive: true });
  }).pipe(Effect.provide(BunServices.layer));
}

function postgresVersionForDbMajorVersion(majorVersion: number): string {
  const image = postgresImageForDbMajorVersion(majorVersion);
  if (image === undefined) {
    throw new Error(`Missing Postgres image for db major ${majorVersion}.`);
  }
  return image.slice(image.lastIndexOf(":") + 1);
}

function expectFailureTag(exit: Exit.Exit<unknown, unknown>, tag: string) {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    return;
  }

  const failure = Cause.findErrorOption(exit.cause);
  expect(Option.isSome(failure)).toBe(true);
  if (Option.isSome(failure)) {
    expect(Predicate.isTagged(failure.value, tag)).toBe(true);
  }
}

describe("legacy services", () => {
  it.live("runs tokenless local service listing through command wiring", () =>
    Effect.gen(function* () {
      const workdir = tempRoot.current;
      const path = yield* Path.Path;
      const out = mockOutput({ format: "text", interactive: false });
      const analytics = mockAnalytics();
      const args = ["services"];
      const layer = Layer.mergeAll(
        BunServices.layer,
        ConfigProvider.layer(legacyTestConfigProvider),
        legacyTestViperLayer,
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

      yield* Command.runWith(legacyTestRoot, { version: "0.0.0-test" })(args).pipe(
        Effect.provide(layer),
      );

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).toContain("supabase/gotrue");
      expect(out.stderrText).not.toContain("Access token not provided");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("prints the services table by default", () => {
    const { layer, out } = setup();

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).toContain("supabase/gotrue");
      expect(out.stdoutText).toContain("supabase/storage-api");
      expect(out.stderrText).toBe("");
    });
  });

  it.live("emits a services JSON array for --output json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(ServiceRowsSchema))(
        out.stdoutText,
      );
      expect(rows).toHaveLength(10);
      expect(rows[0]).toMatchObject({
        name: "supabase/postgres",
        local: LOCAL_POSTGRES_VERSION,
      });
    });
  });

  it.live("reports the configured Postgres version for local projects", () => {
    const workdir = tempRoot.current;
    const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, "config.toml", "[db]\nmajor_version = 15\n");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(ServiceRowsSchema))(
        out.stdoutText,
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          name: "supabase/postgres",
          local: postgresVersionForDbMajorVersion(15),
        }),
      );
    });
  });

  it.live("ignores config.json and reads legacy config.toml for local image selection", () => {
    const workdir = tempRoot.current;
    const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, "config.toml", "[db]\nmajor_version = 15\n");
      yield* writeProjectFile(
        workdir,
        "config.json",
        Formatter.formatJson({ db: { major_version: 14 } }),
      );
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(ServiceRowsSchema))(
        out.stdoutText,
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          name: "supabase/postgres",
          local: postgresVersionForDbMajorVersion(15),
        }),
      );
    });
  });

  it.live("applies linked-project remote config overrides when choosing the local image", () => {
    const workdir = tempRoot.current;
    const config = `
[db]
major_version = 17

[remotes.linked]
project_id = "abcdefghijklmnopqrst"

[remotes.linked.db]
major_version = 15
`;
    const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, "config.toml", config);
      yield* writeProjectFile(workdir, ".temp/project-ref", "abcdefghijklmnopqrst");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(ServiceRowsSchema))(
        out.stdoutText,
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          name: "supabase/postgres",
          local: postgresVersionForDbMajorVersion(15),
        }),
      );
    });
  });

  it.live("warns and skips the remote lookup for a malformed linked project ref", () => {
    const workdir = tempRoot.current;
    const { layer, out } = setup({ workdir });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, ".temp/project-ref", "not-a-valid-ref");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(INVALID_PROJECT_REF_MESSAGE);
      expect(out.stdoutText).toContain("supabase/postgres");
    });
  });

  // A token present doesn't bypass the format guard (the warning is
  // unconditional on login too) — same code path as the previous test, so this
  // isn't new branch coverage, just pinning that login state can't skip it.
  it.live("still warns on a malformed ref even when logged in", () => {
    const workdir = tempRoot.current;
    const { layer, out } = setup({ workdir, accessToken: "sbp_test-token" });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, ".temp/project-ref", "not-a-valid-ref");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain(INVALID_PROJECT_REF_MESSAGE);
      expect(out.stdoutText).toContain("supabase/postgres");
    });
  });

  it.live("fetches and merges remote versions for a valid ref when logged in", () => {
    const workdir = tempRoot.current;

    const server = Bun.serve({
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
          // Deliberately no service-role key: this test only needs to prove the
          // handler wires the fetch+merge branch through, not re-test
          // `fetchLinkedServiceVersions`'s own tenant-probe logic (already
          // covered in services.shared.unit.test.ts). Omitting the
          // service-role key keeps this test free of a second, tenant-gateway
          // mock without weakening the assertion below.
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
    });

    const { layer, out } = setup({
      workdir,
      accessToken: "sbp_test-token",
      apiUrl: server.url.origin,
      goOutput: Option.some("json"),
    });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, ".temp/project-ref", "abcdefghijklmnopqrst");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stderrText).not.toContain(INVALID_PROJECT_REF_MESSAGE);
      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(ServiceRowsSchema))(
        out.stdoutText,
      );
      expect(rows).toContainEqual(
        expect.objectContaining({ name: "supabase/postgres", remote: "17.6.1.200" }),
      );
    }).pipe(Effect.ensuring(Effect.promise(() => server.stop(true))));
  });

  it.live("reports pinned legacy temp service versions", () => {
    const workdir = tempRoot.current;
    const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, "config.toml", "[db]\nmajor_version = 15\n");
      yield* writeProjectFile(workdir, ".temp/postgres-version", "15.1.0.117\n");
      yield* writeProjectFile(workdir, ".temp/gotrue-version", "2.74.2\n");
      yield* writeProjectFile(workdir, ".temp/storage-version", "v1.28.0\n");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(ServiceRowsSchema))(
        out.stdoutText,
      );
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "supabase/postgres", local: "15.1.0.117" }),
          expect.objectContaining({ name: "supabase/gotrue", local: "2.74.2" }),
          expect.objectContaining({ name: "supabase/storage-api", local: "v1.28.0" }),
        ]),
      );
    });
  });

  it.live("reports the Deno 1 edge-runtime image instead of the temp pin", () => {
    const workdir = tempRoot.current;
    const { layer, out } = setup({ goOutput: Option.some("json"), workdir });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, "config.toml", "[edge_runtime]\ndeno_version = 1\n");
      yield* writeProjectFile(workdir, ".temp/edge-runtime-version", "v9.9.9\n");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      const rows = yield* Schema.decodeEffect(Schema.fromJsonString(ServiceRowsSchema))(
        out.stdoutText,
      );
      expect(rows).toContainEqual(
        expect.objectContaining({
          name: "supabase/edge-runtime",
          local: "v1.68.4",
        }),
      );
    });
  });

  it.live("prints config load errors and falls back to the default matrix", () => {
    const workdir = tempRoot.current;
    const { layer, out } = setup({ workdir });

    return Effect.gen(function* () {
      yield* writeProjectFile(workdir, "config.toml", "[db]\nmajor_version = ");
      yield* writeProjectFile(workdir, ".temp/storage-version", "v9.9.9\n");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).not.toContain("v9.9.9");
      expect(out.stderrText).not.toBe("");
    });
  });

  it.live("emits structured JSON for --output pretty combined with --output-format json", () => {
    // Regression guard (CLI-1546): a Go `--output pretty` must defer to the TS
    // `--output-format json` flag instead of forcing the human-readable table.
    const { layer, out } = setup({ format: "json", goOutput: Option.some("pretty") });

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

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
      yield* legacyServices({}).pipe(Effect.provide(layer));

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
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("[[services]]");
      // The hand-written imageVersion struct emits PascalCase field names in
      // declaration order (Name, Local, Remote) with 2-space indent (CLI-1975).
      expect(out.stdoutText).toContain('  Name = "supabase/postgres"');
    });
  });

  it.live("emits a YAML services array for --output yaml", () => {
    const { layer, out } = setup({ goOutput: Option.some("yaml") });

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("- name: supabase/postgres");
      expect(out.stdoutText).toContain(`local: ${LOCAL_POSTGRES_VERSION}`);
    });
  });

  it.live("rejects --output env", () => {
    const { layer } = setup({ goOutput: Option.some("env") });

    return Effect.gen(function* () {
      const exit = yield* legacyServices({}).pipe(Effect.provide(layer), Effect.exit);
      expectFailureTag(exit, "LegacyServicesEnvNotSupportedError");
    });
  });

  it.live("warns to stderr when the project-ref file exists but cannot be read", () => {
    // A directory at the ref path makes `exists()` true but `readFileString()` fail
    // (EISDIR), exercising the READ-error branch distinct from "file absent".
    const workdir = tempRoot.current;
    const { layer, out } = setup({ workdir });

    return Effect.gen(function* () {
      yield* makeProjectDirectory(workdir, ".temp/project-ref");
      yield* legacyServices({}).pipe(Effect.provide(layer));

      expect(out.stderrText).toContain("failed to load project ref: ");
      expect(out.stdoutText).toContain("supabase/postgres");
    });
  });

  it.live("flushes telemetry state after the command finishes", () => {
    const { layer, telemetry } = setup();

    return Effect.gen(function* () {
      yield* legacyServices({}).pipe(Effect.provide(layer));
      expect(telemetry.flushed).toBe(true);
    });
  });
});
