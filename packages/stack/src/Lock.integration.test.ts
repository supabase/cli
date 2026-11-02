import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { database15, selection } from "../tests/pins.ts";
import {
  HOSTED_LOCK_SCHEMA_URL,
  Lock,
  LOCK_SCHEMA_URL,
  lockSelection,
  LockInvalidError,
  LockUnsupportedVersionError,
  readLock,
  writeLock,
} from "./Lock.ts";

const V1_LOCK_SCHEMA_URL = "https://supabase.com/docs/cli/supabase-lock/v1.schema.json";

const bundled = (pin: Lock["services"]["rest"]["resolved"]) =>
  ({ specifier: "bundled", resolution: "resolved", resolved: pin }) as const;

const lockOf = (pins: typeof selection, majorVersion = 17): Lock => ({
  $schema: LOCK_SCHEMA_URL,
  lockfileVersion: 1,
  services: {
    pooler: bundled(pins.pooler),
    analytics: bundled(pins.analytics),
    mail: bundled(pins.mail),
    pgmeta: bundled(pins.pgmeta),
    studio: bundled(pins.studio),
    functions: bundled(pins.functions),
    imgproxy: bundled(pins.imgproxy),
    storage: bundled(pins.storage),
    realtime: bundled(pins.realtime),
    auth: bundled(pins.auth),
    rest: bundled(pins.rest),
    database: { ...bundled(pins.database), majorVersion, line: "stock" },
  },
});

const json = Schema.fromJsonString(Schema.Unknown);
const parse = Schema.decodeUnknownSync(json);
const stringify = Schema.encodeSync(json);

const keysSortedEverywhere = (value: unknown): boolean => {
  if (typeof value !== "object" || value === null) return true;
  const keys = Object.keys(value);
  return keys.toSorted().join() === keys.join() && Object.values(value).every(keysSortedEverywhere);
};

const inProject = <A, E>(
  body: (
    projectRoot: string,
    lockFile: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-stack-lock-" });
      return yield* body(projectRoot, `${projectRoot}/supabase/supabase.lock`);
    }),
  ).pipe(Effect.provide(NodeServices.layer));

describe("lock", () => {
  it.live("a project without a lock reads as none", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        expect(yield* readLock(projectRoot)).toEqual(Option.none());
      }),
    ),
  );

  it.live("writing, reading and writing again produces identical sorted bytes", () =>
    inProject((projectRoot, lockFile) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lock = lockOf(selection);

        yield* writeLock(projectRoot, lock);
        const first = yield* fs.readFileString(lockFile);
        const read = yield* readLock(projectRoot);
        yield* writeLock(projectRoot, Option.getOrThrow(read));
        const second = yield* fs.readFileString(lockFile);

        expect(Option.getOrThrow(read)).toEqual(lock);
        expect(second).toBe(first);
        expect(first.endsWith("}\n")).toBe(true);
        expect(keysSortedEverywhere(parse(first))).toBe(true);
      }),
    ),
  );

  it.live.skipIf(process.platform === "win32")(
    "a written lock is readable by everyone, as a committed file",
    () =>
      inProject((projectRoot, lockFile) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;

          yield* writeLock(projectRoot, lockOf(selection));

          expect((yield* fs.stat(lockFile)).mode & 0o777).toBe(0o644 & ~process.umask());
        }),
      ),
  );

  it.live("a fresh lock is written with the schema URL older CLIs require", () =>
    inProject((projectRoot, lockFile) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        yield* writeLock(projectRoot, lockOf(selection));

        expect(parse(yield* fs.readFileString(lockFile))).toMatchObject({
          $schema: V1_LOCK_SCHEMA_URL,
        });
      }),
    ),
  );

  it.live("a lock naming the hosted schema URL reads and rewrites with the written one", () =>
    inProject((projectRoot, lockFile) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${projectRoot}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          lockFile,
          stringify({ ...lockOf(selection), $schema: HOSTED_LOCK_SCHEMA_URL }),
        );

        const read = yield* readLock(projectRoot);
        yield* writeLock(projectRoot, Option.getOrThrow(read));

        expect(Option.getOrThrow(read).$schema).toBe(V1_LOCK_SCHEMA_URL);
        expect(parse(yield* fs.readFileString(lockFile))).toMatchObject({
          $schema: V1_LOCK_SCHEMA_URL,
        });
      }),
    ),
  );

  it.live("a lock with a newer lockfileVersion fails with an upgrade error", () =>
    inProject((projectRoot, lockFile) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${projectRoot}/supabase`, { recursive: true });
        yield* fs.writeFileString(lockFile, stringify({ lockfileVersion: 2, shape: "new" }));

        const error = yield* Effect.flip(readLock(projectRoot));

        expect(error).toBeInstanceOf(LockUnsupportedVersionError);
        expect(error.message).toContain("upgrade the CLI");
      }),
    ),
  );

  it.live("a lock of the supported version that does not decode is invalid, never absent", () =>
    inProject((projectRoot, lockFile) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${projectRoot}/supabase`, { recursive: true });
        const { rest: _rest, ...services } = lockOf(selection).services;
        yield* fs.writeFileString(lockFile, stringify({ ...lockOf(selection), services }));
        const missingService = yield* Effect.flip(readLock(projectRoot));

        yield* fs.writeFileString(lockFile, '{"lockfileVersion":1,');
        const truncated = yield* Effect.flip(readLock(projectRoot));

        expect(missingService).toBeInstanceOf(LockInvalidError);
        expect(truncated).toBeInstanceOf(LockInvalidError);
      }),
    ),
  );

  describe("pin images", () => {
    const digest = "a".repeat(64);
    const restPin = (image: string, upstreamVersion = "v14.1", revision = 3) => ({
      ...selection.rest,
      upstreamVersion,
      revision,
      image,
    });

    const readWithRest = (pin: typeof selection.rest) =>
      inProject((projectRoot, lockFile) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${projectRoot}/supabase`, { recursive: true });
          const lock = lockOf(selection);
          yield* fs.writeFileString(
            lockFile,
            stringify({ ...lock, services: { ...lock.services, rest: bundled(pin) } }),
          );
          return yield* readLock(projectRoot);
        }),
      );

    it.live.each([
      { name: "a revision above zero", repository: "ghcr.io/supabase/cli/postgrest", revision: 3 },
      { name: "revision zero", repository: "ghcr.io/supabase/cli/postgrest", revision: 0 },
    ])("accepts the image of $name", ({ repository, revision }) =>
      Effect.gen(function* () {
        const read = yield* readWithRest(
          restPin(`${repository}:v14.1-r${revision}@sha256:${digest}`, "v14.1", revision),
        );

        expect(Option.getOrThrow(read).services.rest.resolved.revision).toBe(revision);
      }),
    );

    it.live("rejects an image of a registry other than the canonical one", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          readWithRest(
            restPin(`registry.example.com:5000/mirror/postgrest:v14.1-r3@sha256:${digest}`),
          ),
        );

        expect(error).toBeInstanceOf(LockInvalidError);
        expect(error.message).toContain("rest image");
        expect(error.message).toContain("must be ghcr.io/supabase/cli/postgrest:v14.1-r3@sha256:");
      }),
    );

    it.live("rejects an image without a digest", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          readWithRest(restPin("ghcr.io/supabase/cli/postgrest:v14.1-r3")),
        );

        expect(error).toBeInstanceOf(LockInvalidError);
        expect(error.message).toContain("rest image");
        expect(error.message).toContain("@sha256:<64 hex digits>");
      }),
    );

    it.live("rejects an image tagged for another build than the pin", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          readWithRest(restPin(`ghcr.io/supabase/cli/postgrest:v14.1-r2@sha256:${digest}`)),
        );

        expect(error).toBeInstanceOf(LockInvalidError);
        expect(error.message).toContain("rest image");
        expect(error.message).toContain("tagged v14.1-r2 but the pin is v14.1-r3");
      }),
    );

    it.live("rejects an image of another service's producer", () =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          readWithRest(restPin(`ghcr.io/supabase/cli/auth:v14.1-r3@sha256:${digest}`)),
        );

        expect(error).toBeInstanceOf(LockInvalidError);
        expect(error.message).toContain("is not a postgrest image");
      }),
    );

    it.live("rejects a database whose image names another build than its pin", () =>
      inProject((projectRoot, lockFile) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.makeDirectory(`${projectRoot}/supabase`, { recursive: true });
          const lock = lockOf(selection);
          const stale = { ...selection.database, revision: selection.database.revision + 1 };
          yield* fs.writeFileString(
            lockFile,
            stringify({
              ...lock,
              services: {
                ...lock.services,
                database: { ...lock.services.database, resolved: stale },
              },
            }),
          );

          const error = yield* Effect.flip(readLock(projectRoot));

          expect(error).toBeInstanceOf(LockInvalidError);
          expect(error.message).toContain("database image");
        }),
      ),
    );
  });

  it.live("the selection of a lock is its resolved pins, including overrides", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        const lock = lockOf({ ...selection, database: database15 }, 15);
        yield* writeLock(projectRoot, lock);

        const read = Option.getOrThrow(yield* readLock(projectRoot));

        expect(lockSelection(read)).toEqual({ ...selection, database: database15 });
      }),
    ),
  );
});
