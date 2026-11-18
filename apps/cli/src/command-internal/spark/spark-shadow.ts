import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { ChildProcessSpawner } from "effect/process";
import type { Pool } from "pg";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { NetworkIdFlag } from "../global-flags.ts";
import { acquirePgPool, dbConnectionLayer } from "../db-connection.sql-pg.layer.ts";
import { pgDeltaNextAdapterLayer } from "../../commands/db/shared/pgdelta-next-adapter.layer.ts";
import { waitForPostgresReady } from "../db-bootstrap/health-check.ts";
import { buildLocalDbContainerInputs } from "../db-bootstrap/local-container-inputs.ts";
import {
  createShadowDatabase,
  removeShadowDatabase,
  shadowConnConfig,
  shadowRunInputFromLocalContainerInputs,
} from "../db-bootstrap/shadow-database.ts";
import { allocateFreeHostPort } from "../../commands/db/shared/pgdelta-next-shadow.layer.ts";
import { Output } from "../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { SparkShadowError } from "./spark-project.ts";

const SHADOW_PASSWORD = "postgres";

/**
 * Starts `count` fresh Supabase Postgres containers (the project's image, so the platform roles
 * and schemas exist) and returns a pool for each. They are removed when the scope closes.
 */
export const acquireSparkShadows = Effect.fn("Spark.acquireShadows")(function* (count: number) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const settings = yield* CommandSettings;
  const runtimeInfo = yield* RuntimeInfo;
  const networkId = yield* NetworkIdFlag;
  const output = yield* Output;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const localInputs = yield* buildLocalDbContainerInputs(
    spawner,
    settings.workdir,
    networkId,
    runtimeInfo.platform,
    false,
  );
  const image = yield* localInputs.resolvePostgresImage;
  yield* Effect.annotateCurrentSpan({ "shadow.count": count, "shadow.image": image });
  const ports: Array<number> = [];
  for (let index = 0; index < count; index += 1) {
    const port = yield* allocateFreeHostPort.pipe(
      Effect.flatMap((candidate) =>
        Option.isSome(candidate) && !ports.includes(candidate.value)
          ? Effect.succeed(candidate.value)
          : Effect.fail(
              new SparkShadowError({ message: "failed to allocate a port for a shadow database" }),
            ),
      ),
      Effect.retry({ times: 9 }),
    );
    ports.push(port);
  }
  return yield* Effect.forEach(
    ports,
    (port) =>
      Effect.gen(function* () {
        const input = shadowRunInputFromLocalContainerInputs(
          localInputs,
          image,
          {
            shadowPort: port,
            password: SHADOW_PASSWORD,
            webhooksEnabled: false,
            baseline: { apiAutoExposeNewTables: Option.none() },
            vault: [],
          },
          fs,
          path,
        );
        const handle = yield* Effect.acquireRelease(createShadowDatabase(spawner, input), (h) =>
          removeShadowDatabase(spawner, h.containerId).pipe(Effect.provideService(Output, output)),
        );
        const connection = shadowConnConfig(input);
        yield* waitForPostgresReady(spawner, handle.containerId, connection, {
          timeoutSeconds: input.healthTimeoutSeconds,
          image,
        });
        return yield* acquirePgPool(connection, { isLocal: true, dnsResolver: "native" });
      }),
    { concurrency: "unbounded" },
  );
});

/** Loads a Spark dump into a shadow database as role `postgres`. */
export const loadSparkDump = Effect.fn("Spark.loadDump")(function* (pool: Pool, dump: string) {
  yield* Effect.annotateCurrentSpan({ "spark.dump.bytes": dump.length });
  yield* Effect.tryPromise({
    try: () => pool.query(dump),
    catch: (cause) =>
      new SparkShadowError({
        message: `the project's dump does not load into Postgres: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
});

/** What Spark's `db diff` and `db pull` need beyond the Management API runtime. */
export const sparkShadowLayer = Layer.mergeAll(pgDeltaNextAdapterLayer, dbConnectionLayer);
