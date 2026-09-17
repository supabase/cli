import { PgClient } from "@effect/sql-pg";
import { NodeServices } from "@effect/platform-node";
import { Config, Data, Effect, FileSystem, ManagedRuntime, Option, Path, Redacted } from "effect";
import { afterAll, describe, expect, test } from "vitest";
import { isolatedInstanceApi } from "../../tests/helpers/instance-api.ts";

const host = ManagedRuntime.make(NodeServices.layer);
afterAll(() => host.dispose());

const selectedRuntime = Option.getOrUndefined(
  Effect.runSync(Config.option(Config.string("SUPABASE_STACK_E2E_RUNTIME"))),
);
const runtimes = [{ kind: "native" }, { kind: "container", engine: "docker" }] as const;

class DatabaseSmokeError extends Data.TaggedError("DatabaseSmokeError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const query = (url: string, statement: string) =>
  host.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* PgClient.PgClient;
        return yield* client.unsafe(statement);
      }).pipe(
        Effect.provide(PgClient.layer({ url: Redacted.make(url), connectTimeout: "10 seconds" })),
      ),
    ).pipe(
      Effect.mapError(
        (cause) => new DatabaseSmokeError({ message: `SQL failed: ${statement}`, cause }),
      ),
    ),
  );

const assertActiveSqlBlocksSleep = (
  url: string,
  sleep: () => Promise<unknown>,
  instanceId: string,
) =>
  host.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* PgClient.PgClient;
        yield* client.withTransaction(
          Effect.gen(function* () {
            yield* client.unsafe("SELECT 1");
            yield* Effect.tryPromise(() =>
              expect(sleep()).rejects.toMatchObject({
                _tag: "StackLifecycleConflictError",
                instanceId,
              }),
            );
          }),
        );
      }).pipe(
        Effect.provide(PgClient.layer({ url: Redacted.make(url), connectTimeout: "10 seconds" })),
      ),
    ),
  );

describe("registered database instances through the public API", () => {
  for (const runtime of runtimes) {
    test.skipIf(selectedRuntime !== undefined && selectedRuntime !== runtime.kind)(
      `clones a stopped catalog baseline and preserves independent data in ${runtime.kind}`,
      { timeout: 15 * 60_000 },
      // oxlint-disable-next-line effecttsgo/async-function -- This test consumes the public Promise API across real supervisor processes.
      async () => {
        const { root, snapshotPath } = await host.runPromise(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const root = yield* fs.makeTempDirectory({ prefix: "supabase-instance-snapshot-" });
            return { root, snapshotPath: path.join(root, "baseline.tar") };
          }),
        );
        const { createStack, openStack } = await host.runPromise(isolatedInstanceApi(root));
        const stack = await createStack({
          projectRoot: root,
          name: "instance-snapshot",
          runtime,
          initialConfig: {
            capabilities: {
              database: { enabled: false },
              auth: { enabled: false },
              rest: { enabled: false },
              realtime: { enabled: false },
              storage: { enabled: false },
              functions: { enabled: false },
              studio: { enabled: false },
              mail: { enabled: false },
              analytics: { enabled: false },
              pooler: { enabled: false },
            },
          },
        });
        const failures: unknown[] = [];
        try {
          expect((await stack.credentials()).database).toBeUndefined();
          const initialization = { catalog: { auth: {}, storage: {}, realtime: {} } };
          const source = await stack.services.create({
            service: "database",
            name: "baseline",
            config: {
              activation: "eager",
              password: "baseline-fixture-password",
              endpoints: { sql: { port: "auto" } },
            },
            initialization,
          });
          const clone = await stack.services.create({
            service: "database",
            name: "comparison",
            config: {
              activation: "eager",
              password: "comparison-fixture-password",
              endpoints: { sql: { port: "auto" } },
            },
            initialization,
          });
          expect(source.id).not.toBe(clone.id);
          expect((await source.status()).phase).toBe("stopped");
          const sourceDescriptor = await source.describe();
          const cloneDescriptor = await clone.describe();
          expect(cloneDescriptor.data).toEqual({ origin: "absent" });
          const sourceCredentials = await source.credentials();
          const cloneCredentials = await clone.credentials();
          if (sourceCredentials === undefined || cloneCredentials === undefined)
            throw new Error("Registered SQL endpoints did not provide planned credentials");
          expect(new URL(sourceCredentials.url).port).not.toBe(new URL(cloneCredentials.url).port);

          const started = await source.start();
          expect(started.phase).toBe("ready");
          expect(started.endpoints.find((endpoint) => endpoint.binding === "sql")).toMatchObject({
            availability: "listening",
            port: Number(new URL(sourceCredentials.url).port),
          });
          expect(
            await query(
              sourceCredentials.url,
              "SELECT nspname FROM pg_namespace WHERE nspname IN ('auth', 'storage', 'realtime') ORDER BY nspname",
            ),
          ).toEqual([{ nspname: "auth" }, { nspname: "realtime" }, { nspname: "storage" }]);
          await query(sourceCredentials.url, "CREATE TABLE public.snapshot_marker (value text)");
          await query(
            sourceCredentials.url,
            "INSERT INTO public.snapshot_marker VALUES ('baseline')",
          );
          await assertActiveSqlBlocksSleep(sourceCredentials.url, () => source.sleep(), source.id);
          expect((await source.status()).phase).toBe("ready");
          expect((await source.sleep()).phase).toBe("dormant");
          expect(
            await query(sourceCredentials.url, "SELECT value FROM public.snapshot_marker"),
          ).toEqual([{ value: "baseline" }]);
          expect((await source.status()).phase).toBe("ready");
          await source.stop();
          const exported = await source.exportSnapshot({ destination: snapshotPath });
          expect((await source.status()).phase).toBe("stopped");
          expect(exported.provenance.sourceInstanceId).toBe(source.id);
          expect((await source.describe()).data).toEqual({
            origin: "fresh",
            lineageId: exported.lineageId,
          });
          expect((await source.describe()).initializationProfileId).toBe(
            exported.initializationProfileId,
          );
          expect(exported.artifactIdentity).toBe((await source.describe()).artifactIdentity);
          expect(exported.runtimeIdentity).toBe((await source.describe()).runtimeIdentity);
          await expect(source.exportSnapshot({ destination: snapshotPath })).rejects.toMatchObject({
            _tag: "SnapshotTargetInvalidError",
          });
          const restored = await clone.restoreSnapshot({ source: snapshotPath });
          expect(restored).toEqual(exported);
          expect((await clone.status()).phase).toBe("stopped");
          expect((await clone.describe()).data).toEqual({ origin: "restored", snapshot: exported });

          await source.start();
          await clone.start();
          expect(
            await query(cloneCredentials.url, "SELECT value FROM public.snapshot_marker"),
          ).toEqual([{ value: "baseline" }]);
          await query(cloneCredentials.url, "UPDATE public.snapshot_marker SET value = 'clone'");
          expect(
            await query(sourceCredentials.url, "SELECT value FROM public.snapshot_marker"),
          ).toEqual([{ value: "baseline" }]);
          await clone.stop();
          await expect(clone.restoreSnapshot({ source: snapshotPath })).rejects.toMatchObject({
            _tag: "SnapshotTargetInvalidError",
          });
          await clone.start();
          expect(
            await query(cloneCredentials.url, "SELECT value FROM public.snapshot_marker"),
          ).toEqual([{ value: "clone" }]);
          await clone.destroy();
          expect((await stack.services.list()).some(({ id }) => id === clone.id)).toBe(false);
          expect(
            await query(sourceCredentials.url, "SELECT value FROM public.snapshot_marker"),
          ).toEqual([{ value: "baseline" }]);
          expect((await stack.status()).instances.find(({ name }) => name === "auth")?.phase).toBe(
            "stopped",
          );
          expect((await stack.credentials()).database).toBeUndefined();
          expect(sourceDescriptor.bootstrapRecipeId).toEqual(expect.any(String));
          expect(sourceDescriptor.bootstrapInputsId).toEqual(expect.any(String));
          expect(cloneDescriptor.bootstrapInputsId).toEqual(expect.any(String));
          expect(sourceDescriptor.bootstrapInputsId).not.toBe(cloneDescriptor.bootstrapInputsId);
          expect(sourceDescriptor.initializationProfileId).toBe(
            cloneDescriptor.initializationProfileId,
          );
        } catch (error) {
          failures.push(error);
        }
        try {
          await stack.destroy();
          await expect(openStack(stack.id)).rejects.toMatchObject({ _tag: "StackNotFoundError" });
        } catch (error) {
          throw new AggregateError(
            [...failures, error],
            `Instance smoke cleanup failed; retained project at ${root}`,
          );
        }
        await host.runPromise(
          Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(root, { recursive: true })),
        );
        if (failures.length > 0) throw failures[0];
      },
    );
  }
});
