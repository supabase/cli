// oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- This scenario exercises the public graph build with temporary native roots and reads generated configuration as a consumer would.

import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Scope } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mockBinaryResolver } from "../tests/helpers/mocks.ts";
import { mockChildProcessSpawner } from "../../process-compose/tests/helpers/mocks.ts";
import { StackBuilder } from "./StackBuilder.ts";
import { StackPreparation } from "./StackPreparation.ts";
import type { StackPreparationInput } from "./StackPreparation.ts";
import { resolveConfig } from "./StackConfigResolver.ts";
import { SERVICE_NAMES } from "./ServiceCatalog.ts";
import { nativeLogRoot, nativeServiceLogPath } from "./NativeLogWriter.ts";
import type { AllocatedPorts } from "./PortCatalog.ts";

const ports: AllocatedPorts = {
  apiPort: 41000,
  dbPort: 41001,
  authPort: 41002,
  postgrestPort: 41003,
  postgrestAdminPort: 41004,
  edgeRuntimePort: 41005,
  edgeRuntimeInspectorPort: 41006,
  realtimePort: 41007,
  storagePort: 41008,
  imgproxyPort: 41009,
  mailpitPort: 41010,
  mailpitSmtpPort: 41011,
  mailpitPop3Port: 41012,
  pgmetaPort: 41013,
  studioPort: 41014,
  analyticsPort: 41015,
  vectorAdminPort: 41016,
  poolerSessionPort: 41017,
  poolerTransactionPort: 41018,
  poolerApiPort: 41019,
  poolerInternalPort: 41020,
};

const binaryRoots: Record<string, string> = Object.fromEntries(
  SERVICE_NAMES.map((service) => [service, `/opt/slim/${service}`]),
);

const fullNativeConfig = {
  mode: "native" as const,
  edgeRuntime: {},
  realtime: {},
  storage: {},
  imgproxy: {},
  mailpit: {},
  pgmeta: {},
  studio: {},
  analytics: {},
  vector: {},
  pooler: {},
};

describe("StackBuilder native graph", () => {
  it("builds the complete public graph with isolated native companions and config", async () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-builder-"));
    const resolver = mockBinaryResolver({ binaries: binaryRoots });
    const spawner = mockChildProcessSpawner();
    const layer = Layer.mergeAll(
      StackBuilder.layer,
      NodeFileSystem.layer,
      StackPreparation.layer.pipe(Layer.provide(resolver.layer), Layer.provide(spawner.layer)),
    );

    try {
      const built = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const config = yield* resolveConfig(fullNativeConfig, {
              ports,
              stackRoot: join(root, "stack"),
              runtimeRoot: join(root, "runtime"),
              runtime: { mode: "native", containerRuntime: null },
            });
            const preparation = yield* StackPreparation;
            const builder = yield* StackBuilder;
            const input: StackPreparationInput = {
              mode: "native",
              services: SERVICE_NAMES,
              versions: {},
            };
            const prepared = yield* preparation.prepare(input);
            const scope = yield* Effect.scope;
            return {
              result: yield* builder
                .build(config, prepared)
                .pipe(Effect.provideService(Scope.Scope, scope)),
              storageDataDir: config.storage === false ? "" : config.storage.dataDir,
            };
          }).pipe(Effect.provide(layer)),
        ),
      );

      const { result, storageDataDir } = built;
      const names = result.graph.startOrder.map((service) => service.name);
      expect(names).toEqual(
        expect.arrayContaining([
          ...SERVICE_NAMES,
          "postgres-init",
          "realtime-migrate",
          "realtime-seed",
          "analytics-migrate",
          "analytics-seed",
          "pooler-migrate",
          "pooler-bootstrap",
        ]),
      );
      expect(names).toHaveLength(20);
      expect(result.cleanupTargets.dockerContainerNames).toEqual([]);

      for (const service of SERVICE_NAMES) {
        const definition = result.graph.startOrder.find((candidate) => candidate.name === service);
        expect(definition, service).toBeDefined();
        expect(definition?.command, service).not.toMatch(/^(docker|podman)$/);
        if (service !== "postgres") expect(definition?.command, service).toContain("/bin/");
      }
      expect(
        result.graph.startOrder.find((service) => service.name === "storage")?.env,
      ).toMatchObject({
        SERVER_HOST: "127.0.0.1",
        DATABASE_URL: `postgresql://supabase_storage_admin:postgres@127.0.0.1:${ports.dbPort}/postgres`,
        IMGPROXY_URL: `http://127.0.0.1:${ports.imgproxyPort}`,
      });
      expect(
        result.graph.startOrder.find((service) => service.name === "imgproxy")?.env,
      ).toMatchObject({
        IMGPROXY_LOCAL_FILESYSTEM_ROOT: "/",
        IMGPROXY_ALLOWED_SOURCES: `local:///${storageDataDir.replace(/\/+$/u, "")}/`,
      });
      expect(result.graph.startOrder.find((service) => service.name === "auth")?.env).toMatchObject(
        {
          GOTRUE_SMTP_HOST: "127.0.0.1",
          GOTRUE_SMTP_PORT: String(ports.mailpitSmtpPort),
        },
      );
      expect(result.graph.startOrder.find((service) => service.name === "analytics")?.args).toEqual(
        ["start"],
      );
      for (const service of ["realtime", "analytics", "pooler"] as const) {
        const env = result.graph.startOrder.find((candidate) => candidate.name === service)?.env;
        expect(env).toMatchObject({ RELEASE_DISTRIBUTION: "none" });
        expect(env).not.toHaveProperty("ERL_EPMD_ADDRESS");
        expect(env).not.toHaveProperty("ERL_AFLAGS");
        expect(env).not.toHaveProperty("NODE_NAME");
        expect(env).not.toHaveProperty("NODE_IP");
        expect(env).not.toHaveProperty("RELEASE_NODE");
        expect(env).not.toHaveProperty("RELEASE_COOKIE");
      }
      expect(
        result.graph.startOrder.find((service) => service.name === "studio")?.env,
      ).toMatchObject({
        HOSTNAME: "127.0.0.1",
        STUDIO_PG_META_URL: `http://127.0.0.1:${ports.pgmetaPort}`,
        LOGFLARE_URL: `http://127.0.0.1:${ports.analyticsPort}`,
      });
      expect(
        result.graph.startOrder.find((service) => service.name === "vector")?.healthCheck?.probe,
      ).toEqual({
        _tag: "Http",
        host: "127.0.0.1",
        port: ports.vectorAdminPort,
        path: "/health",
        scheme: "http",
      });
      expect(
        result.graph.startOrder.find((service) => service.name === "pooler")?.env,
      ).toMatchObject({
        PORT: String(ports.poolerApiPort),
        PROXY_PORT_SESSION: String(ports.poolerSessionPort),
        PROXY_PORT_TRANSACTION: String(ports.poolerTransactionPort),
        SESSION_PROXY_PORTS: Array.from({ length: 4 }, (_, index) =>
          String(ports.poolerInternalPort + index),
        ).join(","),
        TRANSACTION_PROXY_PORTS: Array.from({ length: 4 }, (_, index) =>
          String(ports.poolerInternalPort + 4 + index),
        ).join(","),
      });
      expect(result.serviceProjection.get("realtime-migrate")).toEqual({
        visibility: "internal",
        owner: "realtime",
        ownerStatusWhileActive: "Initializing",
      });
      expect(result.serviceProjection.get("analytics-migrate")).toEqual({
        visibility: "internal",
        owner: "analytics",
        ownerStatusWhileActive: "Initializing",
      });
      expect(result.serviceProjection.get("analytics-seed")).toEqual({
        visibility: "internal",
        owner: "analytics",
        ownerStatusWhileActive: "Initializing",
      });
      expect(result.serviceProjection.get("pooler-bootstrap")).toEqual({
        visibility: "internal",
        owner: "pooler",
        ownerStatusWhileActive: "Initializing",
      });
      expect(result.serviceProjection.get("storage")).toEqual({ visibility: "public" });

      const vectorConfig = readFileSync(join(root, "runtime", "vector", "vector.yaml"), "utf8");
      expect(vectorConfig).toContain(`http://127.0.0.1:${ports.analyticsPort}/api/logs`);
      expect(vectorConfig).toContain(nativeLogRoot(join(root, "runtime")));
      expect(vectorConfig).toContain(nativeServiceLogPath(join(root, "runtime"), "vector"));
      expect(vectorConfig).toContain("exclude:");
      expect(vectorConfig).toContain("native_logs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps Docker Auth pointed at the container-to-host Mailpit address", async () => {
    const root = mkdtempSync(join(tmpdir(), "supabase-stack-builder-docker-smtp-"));
    const resolver = mockBinaryResolver({ binaries: binaryRoots });
    const spawner = mockChildProcessSpawner();
    const layer = Layer.mergeAll(
      StackBuilder.layer,
      NodeFileSystem.layer,
      StackPreparation.layer.pipe(Layer.provide(resolver.layer), Layer.provide(spawner.layer)),
    );

    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const config = yield* resolveConfig(
              {
                mode: "docker",
                postgrest: false,
                auth: {},
                edgeRuntime: false,
                realtime: false,
                storage: false,
                imgproxy: false,
                mailpit: {},
                pgmeta: false,
                studio: false,
                analytics: false,
                vector: false,
                pooler: false,
              },
              {
                ports,
                stackRoot: join(root, "stack"),
                runtimeRoot: join(root, "runtime"),
                runtime: { mode: "docker", containerRuntime: "docker" },
              },
            );
            const preparation = yield* StackPreparation;
            const builder = yield* StackBuilder;
            const prepared = yield* preparation.prepare({
              mode: "docker",
              containerRuntime: "docker",
              services: ["postgres", "auth", "mailpit"],
              versions: {},
            });
            const scope = yield* Effect.scope;
            return yield* builder
              .build(config, prepared)
              .pipe(Effect.provideService(Scope.Scope, scope));
          }).pipe(Effect.provide(layer)),
        ),
      );

      expect(result.graph.startOrder.find((service) => service.name === "auth")?.env).toMatchObject(
        {
          GOTRUE_SMTP_HOST: "host.docker.internal",
          GOTRUE_SMTP_PORT: String(ports.mailpitSmtpPort),
        },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
