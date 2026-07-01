import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { DEFAULT_VERSIONS, stackMetadata } from "@supabase/stack/effect";
import {
  mockOutput,
  mockProcessControl,
  mockProjectLinkRemote,
  mockRuntimeInfo,
  processEnvLayer,
} from "../../../../tests/helpers/mocks.ts";
import { cliConfigLayer } from "../../config/cli-config.layer.ts";
import { projectContextLayer } from "../../config/project-context.layer.ts";
import { projectHomeLayer } from "../../config/project-home.layer.ts";
import { projectLinkStateLayer } from "../../config/project-link-state.layer.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { projectLocalServiceVersionsLayer } from "../../config/project-local-service-versions.layer.ts";
import { projectStackStateManagerLayer } from "../../config/project-stack-state-manager.layer.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { update } from "./update.handler.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "supabase-update-command-"));
}

function buildLayer(opts: {
  cwd: string;
  env?: Record<string, string>;
  format?: "text" | "json";
  remoteProject?: {
    ref: string;
    name: string;
    region: string;
    status: string;
    versions: {
      postgres?: string;
      postgrest?: string;
      auth?: string;
      storage?: string;
    };
    unavailableServices?: ReadonlyArray<"postgres" | "postgrest" | "auth" | "storage">;
  };
}) {
  const runtimeInfoLayer = mockRuntimeInfo({
    cwd: opts.cwd,
    homeDir: opts.env?.SUPABASE_HOME ? join(opts.env.SUPABASE_HOME, "..") : join(opts.cwd, ".home"),
  });
  const envLayer = processEnvLayer(opts.env ?? {});
  const discoveredProjectContextLayer = projectContextLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(envLayer),
  );
  const discoveredCliConfigLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
  );
  const discoveredProjectHomeLayer = projectHomeLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(runtimeInfoLayer),
    Layer.provide(discoveredProjectContextLayer),
    Layer.provide(discoveredCliConfigLayer),
  );
  const discoveredProjectLinkStateLayer = projectLinkStateLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(discoveredProjectHomeLayer),
  );
  const discoveredProjectLocalServiceVersionsLayer = projectLocalServiceVersionsLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(discoveredProjectHomeLayer),
  );
  const discoveredProjectStackStateManagerLayer = projectStackStateManagerLayer.pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(discoveredProjectHomeLayer),
  );
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: false,
  });
  const remote = mockProjectLinkRemote({
    linkedProject: opts.remoteProject ?? {
      ref: "abcdefghijklmnopqrst",
      name: "Linked Project",
      region: "eu-west-3",
      status: "ACTIVE_HEALTHY",
      versions: {
        postgres: "17.6.1.090",
        postgrest: "v14.5",
        auth: "v2.187.0",
        storage: "v1.39.2",
      },
    },
  });

  return {
    out,
    layer: Layer.mergeAll(
      BunServices.layer,
      runtimeInfoLayer,
      envLayer,
      discoveredProjectContextLayer,
      discoveredCliConfigLayer,
      discoveredProjectHomeLayer,
      discoveredProjectLinkStateLayer,
      discoveredProjectLocalServiceVersionsLayer,
      discoveredProjectStackStateManagerLayer,
      out.layer,
      remote,
    ),
  };
}

describe("update handler", () => {
  it.live(
    "refreshes linked project versions and updates pinned stack versions without touching local overrides",
    () => {
      const tempDir = makeTempDir();
      const projectRoot = join(tempDir, "repo");
      const supabaseHome = join(tempDir, "supabase-home");

      return Effect.gen(function* () {
        yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

        const { layer, out } = buildLayer({
          cwd: projectRoot,
          env: { SUPABASE_HOME: supabaseHome },
        });

        const projectLinkState = yield* Effect.gen(function* () {
          return yield* ProjectLinkState;
        }).pipe(Effect.provide(layer));

        yield* projectLinkState.save({
          project: {
            ref: "abcdefghijklmnopqrst",
            name: "Linked Project",
            organization_id: "org_123",
            organization_slug: "supabase",
          },
          active_branch: { ref: "abcdefghijklmnopqrst", name: "main", is_default: true },
          fetchedAt: "2026-03-24T10:00:00.000Z",
          versions: {
            postgres: "17.6.1.001",
            postgrest: "v14.4",
            auth: "v2.180.0",
            storage: "v1.39.1",
          },
        });

        yield* Effect.tryPromise(() =>
          mkdir(join(projectRoot, ".supabase", "stacks", "default"), { recursive: true }),
        );
        yield* Effect.tryPromise(() =>
          writeFile(
            join(projectRoot, ".supabase", "stacks", "default", "stack.json"),
            JSON.stringify(
              stackMetadata({
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
                services: {
                  postgres: "17.6.1.081",
                  postgrest: "14.4",
                  auth: "2.180.0",
                  "edge-runtime": DEFAULT_VERSIONS["edge-runtime"],
                  realtime: "2.111.8",
                  storage: "1.39.1",
                  imgproxy: "v3.8.0",
                  mailpit: "v1.30.2",
                  pgmeta: "0.96.1",
                  studio: "2026.03.04-sha-0043607",
                  analytics: "1.34.7",
                  vector: "0.28.1-alpine",
                  pooler: "2.7.4",
                },
                launch: { mode: "auto", excludedServices: [] },
              }),
              null,
              2,
            ),
          ),
        );
        yield* Effect.tryPromise(() =>
          writeFile(
            join(projectRoot, ".supabase", "local-versions.json"),
            JSON.stringify(
              {
                updatedAt: "2026-03-25T10:00:00.000Z",
                versions: { auth: "2.170.0" },
              },
              null,
              2,
            ),
          ),
        );

        const previousLocalOverrides = yield* Effect.tryPromise(() =>
          readFile(join(projectRoot, ".supabase", "local-versions.json"), "utf8"),
        );

        yield* update({ stack: "default" }).pipe(Effect.provide(layer));

        const refreshedProject = JSON.parse(
          yield* Effect.tryPromise(() =>
            readFile(join(projectRoot, ".supabase", "project.json"), "utf8"),
          ),
        );
        expect(refreshedProject).toEqual({
          project: {
            ref: "abcdefghijklmnopqrst",
            name: "Linked Project",
            organization_id: "org_123",
            organization_slug: "supabase",
          },
          active_branch: { ref: "abcdefghijklmnopqrst", name: "main", is_default: true },
          fetchedAt: expect.any(String),
          versions: {
            postgres: "17.6.1.090",
            postgrest: "v14.5",
            auth: "v2.187.0",
            storage: "v1.39.2",
          },
        });

        const nextMetadata = JSON.parse(
          yield* Effect.tryPromise(() =>
            readFile(join(projectRoot, ".supabase", "stacks", "default", "stack.json"), "utf8"),
          ),
        );
        expect(nextMetadata.services).toEqual({
          ...DEFAULT_VERSIONS,
          postgres: "17.6.1.090",
          postgrest: "14.5",
          auth: "2.187.0",
          storage: "1.39.2",
        });

        expect(
          yield* Effect.tryPromise(() =>
            readFile(join(projectRoot, ".supabase", "local-versions.json"), "utf8"),
          ),
        ).toBe(previousLocalOverrides);

        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "info",
            message: "Project: Linked Project (abcdefghijklmnopqrst)",
          }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "info",
            message: "Updated linked project service versions:",
          }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            message: "Updated pinned local stack versions.",
          }),
        );
        expect(out.messages).toContainEqual(
          expect.objectContaining({
            type: "outro",
            message: "Pinned versions are ready for stack default.",
          }),
        );
      });
    },
  );

  it.live("reports when linked and pinned versions are already up to date", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        remoteProject: {
          ref: "abcdefghijklmnopqrst",
          name: "Linked Project",
          region: "eu-west-3",
          status: "ACTIVE_HEALTHY",
          versions: {
            postgres: "17.6.1.090",
            postgrest: "v14.5",
            auth: "v2.187.0",
            storage: "v1.39.2",
          },
        },
      });

      const projectLinkState = yield* Effect.gen(function* () {
        return yield* ProjectLinkState;
      }).pipe(Effect.provide(layer));

      yield* projectLinkState.save({
        project: {
          ref: "abcdefghijklmnopqrst",
          name: "Linked Project",
          organization_id: "org_123",
          organization_slug: "supabase",
        },
        active_branch: { ref: "abcdefghijklmnopqrst", name: "main", is_default: true },
        fetchedAt: "2026-03-24T10:00:00.000Z",
        versions: {
          postgres: "17.6.1.090",
          postgrest: "v14.5",
          auth: "v2.187.0",
          storage: "v1.39.2",
        },
      });

      yield* Effect.tryPromise(() =>
        mkdir(join(projectRoot, ".supabase", "stacks", "default"), { recursive: true }),
      );
      yield* Effect.tryPromise(() =>
        writeFile(
          join(projectRoot, ".supabase", "stacks", "default", "stack.json"),
          JSON.stringify(
            stackMetadata({
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
              services: {
                ...DEFAULT_VERSIONS,
                postgres: "17.6.1.090",
                postgrest: "14.5",
                auth: "2.187.0",
                storage: "1.39.2",
              },
              launch: { mode: "auto", excludedServices: [] },
            }),
            null,
            2,
          ),
        ),
      );

      yield* update({ stack: "default" }).pipe(Effect.provide(layer));

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "info",
          message: "Linked project service versions are already up to date.",
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Pinned stack versions are already up to date.",
        }),
      );
    });
  });

  it.live("emits a clean JSON error when cached project link state is malformed", () => {
    const tempDir = makeTempDir();
    const projectRoot = join(tempDir, "repo");
    const supabaseHome = join(tempDir, "supabase-home");

    return Effect.gen(function* () {
      yield* Effect.tryPromise(() => mkdir(join(projectRoot, ".git"), { recursive: true }));
      yield* Effect.tryPromise(() =>
        mkdir(join(projectRoot, ".supabase", "stacks", "default"), { recursive: true }),
      );
      yield* Effect.tryPromise(() =>
        writeFile(join(projectRoot, ".supabase", "project.json"), "{not-json"),
      );

      const { layer, out } = buildLayer({
        cwd: projectRoot,
        env: { SUPABASE_HOME: supabaseHome },
        format: "json",
      });
      const processControl = mockProcessControl();

      yield* update({ stack: "default" }).pipe(
        withJsonErrorHandling,
        Effect.provide(Layer.mergeAll(layer, processControl.layer)),
      );

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "fail",
          message: `The linked project state file at ${join(projectRoot, ".supabase", "project.json")} is invalid or unreadable.`,
        }),
      );
      expect(processControl.exitCode).toBe(1);
    });
  });
});
