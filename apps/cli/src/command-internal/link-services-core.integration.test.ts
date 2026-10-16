import { legacyProjectStateLayer } from "./legacy-project-state.layer.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";

import {
  VALID_REF,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  useTempWorkdir,
} from "../../tests/helpers/command-mocks.ts";
import { assertBlockDrift } from "../../tests/helpers/permission-drift.ts";
import { linkServices, linkServicesCore } from "./link-services-core.ts";

const storageConfigUrl = `https://api.supabase.com/v1/projects/${VALID_REF}/config/storage`;
const poolerConfigUrl = `https://api.supabase.com/v1/projects/${VALID_REF}/config/database/pooler`;

const storageConfig = {
  fileSizeLimit: 52428800,
  features: {
    imageTransformation: { enabled: true },
    s3Protocol: { enabled: true },
    purgeCache: { enabled: false },
    icebergCatalog: { enabled: false, maxNamespaces: 10, maxTables: 10, maxCatalogs: 2 },
    vectorBuckets: { enabled: false, maxBuckets: 10, maxIndexes: 10 },
  },
  capabilities: { list_v2: true, iceberg_catalog: false, object_versioning: false },
  external: { upstreamTarget: "main" },
  migrationVersion: "20260101000000",
};
const poolerConfigs = [
  {
    identifier: "primary",
    database_type: "PRIMARY",
    is_using_scram_auth: true,
    db_user: "postgres",
    db_host: "db.example",
    db_port: 5432,
    db_name: "postgres",
    connection_string: `postgres://postgres.${VALID_REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    connectionString: `postgres://postgres.${VALID_REF}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
    default_pool_size: null,
    max_client_conn: null,
    pool_mode: "transaction",
  },
];

describe("linkServicesCore", () => {
  const workdir = useTempWorkdir("link-services-");

  const run = (
    skipPooler: boolean,
    handler?: (
      request: HttpClientRequest.HttpClientRequest,
    ) => { readonly status: number; readonly body: unknown } | undefined,
  ) => {
    const api = mockCommandPlatformApi(
      handler === undefined
        ? {}
        : {
            handler: (request) => {
              const reply = handler(request) ?? { status: 404, body: { message: "not found" } };
              return Effect.succeed(jsonResponse(request, reply.status, reply.body));
            },
          },
    );
    return linkServicesCore({
      ref: VALID_REF,
      serviceKey: "service-key",
      skipPooler,
      workdir: workdir.current,
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          api.layer,
          api.httpClientLayer,
          mockCommandSettings({ workdir: workdir.current }),
        ).pipe(Layer.provideMerge(legacyProjectStateLayer), Layer.provideMerge(BunServices.layer)),
      ),
      Effect.as(api.requests),
    );
  };

  it.live("requests the storage and pooler configs of the linked project", () =>
    Effect.gen(function* () {
      const requests = yield* run(false);

      const urls = requests.map((request) => request.url);
      expect(urls).toContain(storageConfigUrl);
      expect(urls).toContain(poolerConfigUrl);
      assertBlockDrift(linkServices, {
        activeFlags: { "skip-pooler": false },
        requests,
      });
    }),
  );

  it.live("writes the storage migration version and the session-mode pooler URL", () =>
    Effect.gen(function* () {
      const requests = yield* run(false, (request) =>
        request.url === storageConfigUrl
          ? { status: 200, body: storageConfig }
          : request.url === poolerConfigUrl
            ? { status: 200, body: poolerConfigs }
            : undefined,
      );

      const fs = yield* FileSystem.FileSystem;
      const temp = `${workdir.current}/supabase/.temp`;
      expect(
        requests
          .map((request) => request.url)
          .filter((url) => url.startsWith("https://api.supabase.com")),
      ).toEqual([storageConfigUrl, poolerConfigUrl]);
      expect(yield* fs.readFileString(`${temp}/storage-migration`)).toBe("20260101000000");
      expect(yield* fs.readFileString(`${temp}/pooler-url`)).toBe(
        `postgres://postgres.${VALID_REF}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
      );
      assertBlockDrift(linkServices, {
        activeFlags: { "skip-pooler": false },
        requests,
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("writes nothing and still completes when both config lookups are forbidden", () =>
    Effect.gen(function* () {
      const requests = yield* run(false, (request) =>
        request.url === storageConfigUrl || request.url === poolerConfigUrl
          ? { status: 403, body: { message: "Forbidden" } }
          : undefined,
      );

      const fs = yield* FileSystem.FileSystem;
      const temp = `${workdir.current}/supabase/.temp`;
      expect(requests.map((request) => request.url)).toEqual(
        expect.arrayContaining([storageConfigUrl, poolerConfigUrl]),
      );
      expect(yield* fs.exists(`${temp}/storage-migration`)).toBe(false);
      expect(yield* fs.exists(`${temp}/pooler-url`)).toBe(false);
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.live("requests no pooler config when skipPooler is set", () =>
    Effect.gen(function* () {
      const requests = yield* run(true);

      const urls = requests.map((request) => request.url);
      expect(urls).toContain(storageConfigUrl);
      expect(urls).not.toContain(poolerConfigUrl);
      assertBlockDrift(linkServices, {
        activeFlags: { "skip-pooler": true },
        requests,
      });
    }),
  );
});
