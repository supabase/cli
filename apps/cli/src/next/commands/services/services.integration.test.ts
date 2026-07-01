import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { DEFAULT_VERSIONS, stackMetadata, type VersionManifest } from "@supabase/stack/effect";
import { Effect, Layer, Option, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { CliConfig } from "../../config/cli-config.service.ts";
import type { LocalServiceVersionsState } from "../../config/project-local-service-versions.service.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import {
  ProjectLinkState,
  type ProjectLinkStateValue,
} from "../../config/project-link-state.service.ts";
import { InvalidProjectLinkStateError } from "../../config/project-link-state.service.ts";
import { Credentials } from "../../auth/credentials.service.ts";
import {
  mockOutput,
  mockProjectLocalServiceVersions,
  mockStateManager,
} from "../../../../tests/helpers/mocks.ts";
import { CommandRuntime } from "../../../shared/runtime/command-runtime.service.ts";
import { listLocalServiceVersions } from "../../../shared/services/services.shared.ts";
import { services } from "./services.handler.ts";

const LINKED_REF = "abcdefghijklmnopqrst";
const LOCAL_POSTGRES_SERVICE = listLocalServiceVersions().find(
  (service) => service.name === "supabase/postgres",
);

if (LOCAL_POSTGRES_SERVICE === undefined) {
  throw new Error("Missing supabase/postgres in local service versions.");
}

const LOCAL_POSTGRES_VERSION = LOCAL_POSTGRES_SERVICE.local;

function linkedStateFixture(): ProjectLinkStateValue {
  return {
    project: {
      ref: LINKED_REF,
      name: "Linked Project",
      organization_id: "org-id",
      organization_slug: "org",
    },
    active_branch: { ref: "branch-ref", name: "main", is_default: true },
    fetchedAt: "2026-03-13T12:00:00.000Z",
    versions: {},
  };
}

function setup(
  opts: {
    format?: "text" | "json" | "stream-json";
    linkedState?: Option.Option<ProjectLinkStateValue>;
    invalidLinkedState?: boolean;
    accessToken?: string;
    apiUrl?: string;
    workdir?: string;
    localServiceVersions?: LocalServiceVersionsState;
    pinnedStackVersions?: VersionManifest;
  } = {},
) {
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const linkedState = opts.linkedState ?? Option.none<ProjectLinkStateValue>();
  const projectRoot = opts.workdir ?? process.cwd();
  const supabaseDir = join(projectRoot, "supabase");

  return {
    out,
    layer: Layer.mergeAll(
      BunServices.layer,
      out.layer,
      mockStateManager({
        metadata:
          opts.pinnedStackVersions === undefined
            ? []
            : [
                {
                  name: "default",
                  metadata: stackMetadata({
                    ports: {
                      apiPort: 54321,
                      dbPort: 54322,
                      authPort: 54323,
                      postgrestPort: 54324,
                      postgrestAdminPort: 54325,
                      edgeRuntimePort: 54337,
                      edgeRuntimeInspectorPort: 54338,
                      realtimePort: 54326,
                      storagePort: 54327,
                      imgproxyPort: 54328,
                      mailpitPort: 54329,
                      mailpitSmtpPort: 54330,
                      mailpitPop3Port: 54331,
                      pgmetaPort: 54332,
                      studioPort: 54333,
                      analyticsPort: 54334,
                      poolerPort: 54335,
                      poolerApiPort: 54336,
                    },
                    services: opts.pinnedStackVersions,
                    launch: { mode: "auto", excludedServices: [] },
                  }),
                },
              ],
      }),
      mockProjectLocalServiceVersions(opts.localServiceVersions),
      FetchHttpClient.layer,
      Layer.succeed(
        CliConfig,
        CliConfig.of({
          apiUrl: opts.apiUrl ?? "https://api.supabase.com",
          dashboardUrl: "https://supabase.com/dashboard",
          projectHost: "supabase.co",
          telemetryPosthogHost: "https://ph.supabase.com",
          telemetryPosthogKey: Option.none(),
          accessToken: Option.none(),
          noKeyring: Option.none(),
          supabaseHome: "/tmp/supabase-home",
          debug: Option.none(),
          telemetryDebug: Option.none(),
          telemetryDisabled: Option.none(),
          doNotTrack: Option.none(),
        }),
      ),
      Layer.succeed(
        Credentials,
        Credentials.of({
          getAccessToken: Effect.succeed(
            opts.accessToken === undefined
              ? Option.none()
              : Option.some(Redacted.make(opts.accessToken)),
          ),
          saveAccessToken: () => Effect.die("unexpected saveAccessToken"),
          deleteAccessToken: Effect.die("unexpected deleteAccessToken"),
        }),
      ),
      Layer.succeed(
        ProjectHome,
        ProjectHome.of({
          projectRoot,
          supabaseDir,
          projectHomeDir: join(supabaseDir, ".temp"),
          projectLinkPath: join(supabaseDir, ".temp", "project-ref"),
          projectLocalVersionsPath: join(supabaseDir, ".temp", "local-versions"),
          ensureProjectHomeDir: Effect.void,
          stackDir: (name) => join(supabaseDir, ".branches", name),
          stackStatePath: (name) => join(supabaseDir, ".branches", name, "stack-state.json"),
          stackMetadataPath: (name) => join(supabaseDir, ".branches", name, "stack.json"),
          stackDataDir: (name) => join(supabaseDir, ".branches", name, "data"),
          stackLogsDir: (name) => join(supabaseDir, ".branches", name, "logs"),
        }),
      ),
      Layer.succeed(
        ProjectLinkState,
        ProjectLinkState.of({
          load: opts.invalidLinkedState
            ? Effect.fail(
                new InvalidProjectLinkStateError({
                  detail: "broken project link state",
                  suggestion: "fix it",
                }),
              )
            : Effect.succeed(linkedState),
          save: () => Effect.die("unexpected save"),
          clear: Effect.die("unexpected clear"),
          getActiveBranch: Effect.succeed(Option.none()),
          setActiveBranch: () => Effect.die("unexpected setActiveBranch"),
        }),
      ),
      Layer.succeed(
        CommandRuntime,
        CommandRuntime.of({
          commandPath: ["services"],
          commandRunId: "run-services-test",
        }),
      ),
    ),
  };
}

function makeProjectWithConfig(config: string): string {
  const workdir = mkdtempSync(join(tmpdir(), "supabase-services-config-"));
  const configDir = join(workdir, "supabase");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.toml"), config);
  return workdir;
}

function makeProjectWithDbMajorVersion(majorVersion: number): string {
  return makeProjectWithConfig(`[db]\nmajor_version = ${majorVersion}\n`);
}

describe("next services", () => {
  it.live("prints the services table in text mode", () => {
    const { layer, out } = setup();

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stdoutText).toContain("supabase/gotrue");
      expect(out.stdoutText).toContain("supabase/storage-api");
      expect(out.stderrText).toBe("");
    });
  });

  it.live("emits structured services data in json mode", () => {
    const { layer, out } = setup({ format: "json" });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

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

  it.live("reports the stack runtime Postgres version instead of config db.major_version", () => {
    const workdir = makeProjectWithDbMajorVersion(15);
    const { layer, out } = setup({ format: "json", workdir });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: DEFAULT_VERSIONS.postgres,
          }),
        ]),
      });
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(workdir, { recursive: true, force: true }))));
  });

  it.live("reports the stack runtime version instead of linked remote config db overrides", () => {
    const workdir = makeProjectWithConfig(`
[db]
major_version = 17

[remotes.linked]
project_id = "${LINKED_REF}"

[remotes.linked.db]
major_version = 15
`);
    const { layer, out } = setup({
      format: "json",
      linkedState: Option.some(linkedStateFixture()),
      workdir,
    });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: DEFAULT_VERSIONS.postgres,
          }),
        ]),
      });
    }).pipe(Effect.ensuring(Effect.sync(() => rmSync(workdir, { recursive: true, force: true }))));
  });

  it.live("reports pinned local service versions", () => {
    const { layer, out } = setup({
      format: "json",
      localServiceVersions: {
        updatedAt: "2026-07-01T14:00:00.000Z",
        versions: {
          postgres: "15.1.0.117",
          auth: "2.74.2",
          storage: "1.28.0",
        },
      },
    });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({ name: "supabase/postgres", local: "15.1.0.117" }),
          expect.objectContaining({ name: "supabase/gotrue", local: "v2.74.2" }),
          expect.objectContaining({ name: "supabase/storage-api", local: "v1.28.0" }),
        ]),
      });
    });
  });

  it.live("reports pinned stack metadata before newer linked baseline versions", () => {
    const { layer, out } = setup({
      format: "json",
      linkedState: Option.some({
        ...linkedStateFixture(),
        versions: { postgres: "17.6.1.200" },
      }),
      pinnedStackVersions: {
        ...DEFAULT_VERSIONS,
        postgres: "17.6.1.100",
      },
    });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: "17.6.1.100",
          }),
        ]),
      });
    });
  });

  it.live("falls back to local output when linked state is invalid", () => {
    const { layer, out } = setup({ invalidLinkedState: true });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      expect(out.stdoutText).toContain("supabase/postgres");
      expect(out.stderrText).toBe("");
    });
  });

  it.live("merges linked service versions and warns on a version mismatch", () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === `/v1/projects/${LINKED_REF}/api-keys`) {
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

        if (url.pathname === `/v1/projects/${LINKED_REF}`) {
          return Response.json({
            id: LINKED_REF,
            ref: LINKED_REF,
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

        return new Response("not found", { status: 404 });
      },
    });

    const { layer, out } = setup({
      format: "json",
      linkedState: Option.some(linkedStateFixture()),
      accessToken: "sbp_token",
      apiUrl: server.url.origin,
    });

    return Effect.gen(function* () {
      yield* services().pipe(Effect.provide(layer));

      const success = out.messages.find((message) => message.type === "success");
      expect(success?.data).toMatchObject({
        services: expect.arrayContaining([
          expect.objectContaining({
            name: "supabase/postgres",
            local: LOCAL_POSTGRES_VERSION,
            remote: "17.6.1.200",
          }),
        ]),
      });
      expect(out.stderrText).toContain("WARNING:");
    }).pipe(Effect.ensuring(Effect.promise(() => server.stop(true))));
  });
});
