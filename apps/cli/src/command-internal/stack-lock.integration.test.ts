import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { LOCK_SCHEMA_URL, writeLock, type Lock } from "@supabase/stack/effect";
import type { ArtifactPin } from "@supabase/stack/internal/artifacts";
import { Crypto, Effect, FileSystem, Path } from "effect";

import {
  database15,
  orioledb,
  orioledbConfigVersion,
  selection,
} from "../../tests/helpers/pins.ts";
import { StackConfigError } from "./stack-config.ts";
import {
  LockResolutionError,
  outdatedServices,
  readSelectionOrBundled,
  type LockRequest,
} from "./stack-lock.ts";
import { selectionForRequest } from "./stack-project-selection.ts";

const inProject = <A, E>(
  body: (
    projectRoot: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Crypto.Crypto>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* body(yield* fs.makeTempDirectoryScoped({ prefix: "stack-lock-int-" }));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const requestFor = (
  projectRoot: string,
  overrides: Partial<Omit<LockRequest, "projectRoot">> = {},
): LockRequest => ({
  projectRoot,
  majorVersion: 17,
  orioledbVersion: undefined,
  services: undefined,
  ...overrides,
});

const orioledbBuild = `${orioledb.upstreamVersion}-r${orioledb.revision}`;

describe("readSelectionOrBundled without a lock", () => {
  it.live("selects the bundled OrioleDB build a [local.services] database version names", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        const chosen = yield* readSelectionOrBundled(
          requestFor(projectRoot, { services: { database: { version: orioledbBuild } } }),
        );

        expect(chosen.database).toEqual(orioledb);
        expect(chosen.rest).toEqual(selection.rest);
      }),
    ),
  );

  it.live(
    "fails with the missing-lock error for an upstream version this CLI does not bundle",
    () =>
      inProject((projectRoot) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            readSelectionOrBundled(
              requestFor(projectRoot, { services: { auth: { version: "v99.0.0" } } }),
            ),
          );

          expect(error).toBeInstanceOf(LockResolutionError);
          expect(error.message).toBe(
            "supabase/supabase.lock not found; run supabase start to create it",
          );
        }),
      ),
  );

  it.live("fails for a database revision this CLI does not bundle", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          readSelectionOrBundled(
            requestFor(projectRoot, {
              services: {
                database: { version: `${orioledb.upstreamVersion}-r${orioledb.revision + 1}` },
              },
            }),
          ),
        );

        expect(error).toBeInstanceOf(LockResolutionError);
      }),
    ),
  );

  it.live("fails when the OrioleDB alias and the database version name different builds", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(
          readSelectionOrBundled(
            requestFor(projectRoot, {
              orioledbVersion: orioledbConfigVersion,
              services: { database: { version: "17.6.1.000" } },
            }),
          ),
        );

        expect(error).toBeInstanceOf(StackConfigError);
        expect(error.message).toContain("conflicts with local.services.database.version");
      }),
    ),
  );
});

const linkedEntry = (resolved: ArtifactPin) =>
  ({ specifier: "linked", resolution: "unlinked", resolved }) as const;

const orioledbLock = (specifier: string, resolved: ArtifactPin): Lock => ({
  $schema: LOCK_SCHEMA_URL,
  lockfileVersion: 1,
  services: {
    database: { specifier, resolution: "resolved", resolved, majorVersion: 17, line: "orioledb" },
    rest: linkedEntry(selection.rest),
    auth: linkedEntry(selection.auth),
    realtime: linkedEntry(selection.realtime),
    storage: linkedEntry(selection.storage),
    imgproxy: linkedEntry(selection.imgproxy),
    functions: linkedEntry(selection.functions),
    studio: linkedEntry(selection.studio),
    pgmeta: linkedEntry(selection.pgmeta),
    mail: linkedEntry(selection.mail),
    analytics: linkedEntry(selection.analytics),
    pooler: linkedEntry(selection.pooler),
  },
});

describe("a locked OrioleDB build", () => {
  it.live("is reported with the bundled OrioleDB pin, not the stock one", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        yield* writeLock(projectRoot, orioledbLock(orioledbBuild, orioledb));

        const rows = yield* outdatedServices(
          requestFor(projectRoot, { services: { database: { version: orioledbBuild } } }),
        );

        expect(rows.find(({ service }) => service === "database")?.bundled).toBe(orioledbBuild);
      }),
    ),
  );
});

describe("selectionForRequest with a stale lock", () => {
  const staleRequest = (projectRoot: string) =>
    requestFor(projectRoot, { services: { database: { version: orioledbBuild } } });

  it.live("falls back to the bundled pins of the merged request when a remote applied", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        yield* writeLock(projectRoot, orioledbLock(orioledb.upstreamVersion, orioledb));

        const chosen = yield* selectionForRequest({
          ...staleRequest(projectRoot),
          appliedRemote: "remote-ref",
        });

        expect(chosen.database).toEqual(orioledb);
        expect(chosen.rest).toEqual(selection.rest);
      }),
    ),
  );

  const pinnedAuth = {
    ...selection.auth,
    upstreamVersion: "v2.1.0",
    image: selection.auth.image.replace(`:${selection.auth.upstreamVersion}-`, ":v2.1.0-"),
  };
  const remoteMajorRequest = (projectRoot: string, auth: string) => ({
    ...requestFor(projectRoot, { majorVersion: 15, services: { auth: { version: auth } } }),
    appliedRemote: "remote-ref",
  });
  const stockLockWithAuth = (auth: Lock["services"]["auth"]): Lock => ({
    ...orioledbLock(orioledb.upstreamVersion, orioledb),
    services: {
      ...orioledbLock(orioledb.upstreamVersion, orioledb).services,
      database: {
        specifier: "linked",
        resolution: "unlinked",
        resolved: selection.database,
        majorVersion: 17,
        line: "stock",
      },
      auth,
    },
  });

  it.live("keeps a fresh locked pin the CLI does not bundle while the database falls back", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        yield* writeLock(
          projectRoot,
          stockLockWithAuth({ specifier: "v2.1.0", resolution: "resolved", resolved: pinnedAuth }),
        );

        const chosen = yield* selectionForRequest(remoteMajorRequest(projectRoot, "v2.1.0"));

        expect(chosen.database).toEqual(database15);
        expect(chosen.auth).toEqual(pinnedAuth);
      }),
    ),
  );

  it.live("reports a stale entry the CLI does not bundle as stale", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        yield* writeLock(projectRoot, stockLockWithAuth(linkedEntry(selection.auth)));

        const error = yield* Effect.flip(
          selectionForRequest(remoteMajorRequest(projectRoot, "v2.1.0")),
        );

        expect(error).toMatchObject({ _tag: "LockResolutionError", reason: "frozen-stale" });
        expect(error.message).toBe(
          "supabase/supabase.lock is stale for: auth (specifier v2.1.0 ≠ locked linked); run supabase start to refresh it",
        );
      }),
    ),
  );

  it.live("still fails when no remote applied", () =>
    inProject((projectRoot) =>
      Effect.gen(function* () {
        yield* writeLock(projectRoot, orioledbLock(orioledb.upstreamVersion, orioledb));

        const error = yield* Effect.flip(
          selectionForRequest({ ...staleRequest(projectRoot), appliedRemote: undefined }),
        );

        expect(error).toMatchObject({ _tag: "LockResolutionError", reason: "frozen-stale" });
      }),
    ),
  );
});
