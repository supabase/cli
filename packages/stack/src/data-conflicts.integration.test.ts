import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { findDataConflicts } from "./effect.ts";
import { seedSavedStack, type SeedSavedStackOptions } from "./testing.ts";
import { selection } from "../tests/pins.ts";

const built = selection.database.upstreamVersion;
const newerBuild = "17.99.0.001";

const pinned = <Pin extends { readonly upstreamVersion: string }>(
  pin: Pin,
  upstreamVersion: string,
) => ({ ...pin, upstreamVersion });

const project = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-data-conflicts-" });
  const projectRoot = path.join(root, "project");
  yield* fs.makeDirectory(projectRoot);
  const stateRoot = path.join(root, "state");
  return {
    root,
    projectRoot,
    stateRoot,
    seed: (options: Partial<SeedSavedStackOptions> = {}) =>
      seedSavedStack({ projectRoot, stateRoot, ...options }),
    conflicts: (requested: Parameters<typeof findDataConflicts>[0]["requested"]) =>
      findDataConflicts({ stateRoot, projectRoot, requested }),
  };
});

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "reports initialized data built by another upstream, but not a newer revision of its own",
  () =>
    run(
      Effect.gen(function* () {
        const { seed, conflicts } = yield* project;
        const { stackId, databaseId } = yield* seed({ built });

        const [conflict] = yield* conflicts({ database: pinned(selection.database, newerBuild) });

        expect(conflict).toMatchObject({
          kind: "database-build",
          stackId,
          service: "database",
          instanceId: databaseId,
          recorded: built,
          requested: newerBuild,
        });
        expect(conflict?.message).toContain("was requested; keep this data by pinning");
        expect(
          yield* conflicts({
            database: { ...selection.database, revision: selection.database.revision + 1 },
          }),
        ).toEqual([]);
      }),
    ),
);

it.effect("reports initialized data that has no recorded identity", () =>
  run(
    Effect.gen(function* () {
      const { seed, conflicts } = yield* project;
      const { stackId } = yield* seed({ built, withoutIdentity: true });

      const [conflict] = yield* conflicts({ database: selection.database });

      expect(conflict).toMatchObject({
        kind: "database-build",
        recorded: undefined,
        requested: built,
      });
      expect(conflict?.message).toBe(
        `PostgreSQL data has no recorded identity, but stock PostgreSQL build ${built} was requested; run \`supabase stack destroy --stack-id ${stackId}\` to recreate the stack — this permanently deletes its local database data`,
      );
    }),
  ),
);

it.effect("accepts any database build while the data was never initialized", () =>
  run(
    Effect.gen(function* () {
      const { seed, conflicts } = yield* project;
      yield* seed();

      expect(yield* conflicts({ database: pinned(selection.database, newerBuild) })).toEqual([]);
    }),
  ),
);

it.effect("reports the identity a Docker first start recorded before it was interrupted", () =>
  run(
    Effect.gen(function* () {
      const { seed, conflicts } = yield* project;
      const { stackId, databaseId } = yield* seed({ built, interrupted: true, runtime: "docker" });

      const [conflict] = yield* conflicts({ database: pinned(selection.database, newerBuild) });

      expect(conflict).toMatchObject({
        kind: "database-build",
        stackId,
        instanceId: databaseId,
        recorded: built,
        requested: newerBuild,
      });
      expect(yield* conflicts({ database: selection.database })).toEqual([]);
    }),
  ),
);

it.effect("stays quiet about a Docker data directory that has no recorded identity", () =>
  run(
    Effect.gen(function* () {
      const { seed, conflicts } = yield* project;
      yield* seed({ built, interrupted: true, runtime: "docker", withoutIdentity: true });

      expect(yield* conflicts({ database: pinned(selection.database, newerBuild) })).toEqual([]);
    }),
  ),
);

it.effect(
  "reports a composed schema-owning service older than the newest one that migrated the database",
  () =>
    run(
      Effect.gen(function* () {
        const { seed, conflicts } = yield* project;
        const { stackId, databaseId } = yield* seed({
          composed: ["auth", "storage"],
          migrated: { auth: "v2.197.0" },
        });

        const found = yield* conflicts({
          auth: pinned(selection.auth, "v2.196.1"),
          storage: pinned(selection.storage, "v0.0.1"),
          rest: pinned(selection.rest, "v0.0.1"),
        });

        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
          kind: "schema-downgrade",
          stackId,
          service: "auth",
          instanceId: databaseId,
          recorded: "v2.197.0",
          requested: "v2.196.1",
        });
        expect(found[0]?.message).toContain(
          'keep this data by pinning `[local.services.auth] version = "v2.197.0"`',
        );
        expect(yield* conflicts({ auth: pinned(selection.auth, "v2.197.0") })).toEqual([]);
        expect(yield* conflicts({ auth: pinned(selection.auth, "v2.198.0") })).toEqual([]);
      }),
    ),
);

it.effect("keeps reporting a recorded downgrade before the database data initialized", () =>
  run(
    Effect.gen(function* () {
      const { seed, conflicts } = yield* project;
      yield* seed({ composed: ["auth"], migrated: { auth: "v2.197.0" } });

      expect(yield* conflicts({ auth: pinned(selection.auth, "v2.196.1") })).toHaveLength(1);
    }),
  ),
);

it.effect("stays quiet about a schema writer the saved composition no longer runs", () =>
  run(
    Effect.gen(function* () {
      const { seed, conflicts } = yield* project;
      yield* seed({ composed: ["auth"], migrated: { auth: "v2.197.0", storage: "v1.50.0" } });

      expect(
        yield* conflicts({
          auth: pinned(selection.auth, "v2.197.0"),
          storage: pinned(selection.storage, "v0.0.1"),
        }),
      ).toEqual([]);
    }),
  ),
);

it.effect("reports only the stacks of the project it is asked about", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { root, stateRoot, seed, conflicts } = yield* project;
      const other = `${root}/other`;
      yield* fs.makeDirectory(other);
      yield* seedSavedStack({ projectRoot: other, stateRoot, built });
      const { stackId } = yield* seed({ built });

      const found = yield* conflicts({ database: pinned(selection.database, newerBuild) });

      expect(found.map((conflict) => conflict.stackId)).toEqual([stackId]);
    }),
  ),
);

it.effect("reports nothing, and creates nothing, when there is no saved state", () =>
  run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateRoot, conflicts } = yield* project;

      expect(yield* conflicts({ database: pinned(selection.database, newerBuild) })).toEqual([]);
      expect(yield* fs.exists(stateRoot)).toBe(false);
    }),
  ),
);
