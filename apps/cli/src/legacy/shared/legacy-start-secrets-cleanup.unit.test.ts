import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { legacyCleanupStartSecrets } from "./legacy-start-secrets-cleanup.ts";

const withTempDirectory = <A>(
  prefix: string,
  use: (
    directory: string,
    fs: FileSystem.FileSystem,
    path: Path.Path,
  ) => Effect.Effect<A, Error, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix });
    return yield* Effect.acquireUseRelease(
      Effect.succeed(directory),
      (root) => use(root, fs, path),
      (root) => fs.remove(root, { recursive: true, force: true }).pipe(Effect.ignore),
    );
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie);

describe("legacyCleanupStartSecrets", () => {
  it.effect("removes a NAMED container's secret directory keyed off container.name", () => {
    return withTempDirectory("legacy-start-secrets-cleanup-", (workdir, fs, path) =>
      Effect.gen(function* () {
        const secretDir = path.join(
          workdir,
          "supabase",
          ".temp",
          "start-secrets",
          "supabase_kong_demo",
        );
        yield* fs.makeDirectory(secretDir, { recursive: true });
        yield* fs.writeFileString(path.join(secretDir, "secret-0"), "kong-secret");
        yield* legacyCleanupStartSecrets(
          [{ id: "abc123", name: "supabase_kong_demo", workdir: "" }],
          workdir,
        );
        expect(yield* fs.exists(secretDir)).toBe(false);
      }),
    );
  });

  it.effect(
    "falls back to fallbackWorkdir when a container carries no com.supabase.cli.workdir label",
    () => {
      return withTempDirectory("legacy-start-secrets-cleanup-", (workdir, fs, path) =>
        Effect.gen(function* () {
          const secretDir = path.join(
            workdir,
            "supabase",
            ".temp",
            "start-secrets",
            "supabase_kong_demo",
          );
          yield* fs.makeDirectory(secretDir, { recursive: true });
          yield* fs.writeFileString(path.join(secretDir, "secret-0"), "kong-secret");
          yield* legacyCleanupStartSecrets(
            [{ id: "abc123", name: "supabase_kong_demo", workdir: "" }],
            workdir,
          );
          expect(yield* fs.exists(secretDir)).toBe(false);
        }),
      );
    },
  );

  it.effect("prefers a container's OWN com.supabase.cli.workdir label over fallbackWorkdir", () => {
    return withTempDirectory("legacy-start-secrets-cleanup-own-", (ownWorkdir, fs, path) =>
      withTempDirectory("legacy-start-secrets-cleanup-other-", (otherWorkdir) =>
        Effect.gen(function* () {
          const secretDir = path.join(
            ownWorkdir,
            "supabase",
            ".temp",
            "start-secrets",
            "supabase_db_demo",
          );
          yield* fs.makeDirectory(secretDir, { recursive: true });
          yield* fs.writeFileString(path.join(secretDir, "secret-0"), "db-secret");
          yield* legacyCleanupStartSecrets(
            [{ id: "abc123", name: "supabase_db_demo", workdir: ownWorkdir }],
            otherWorkdir,
          );
          expect(yield* fs.exists(secretDir)).toBe(false);
        }),
      ),
    );
  });

  it.effect("never fails when nothing was ever staged for a container", () => {
    return withTempDirectory("legacy-start-secrets-cleanup-", (workdir) =>
      legacyCleanupStartSecrets(
        [{ id: "abc123", name: "supabase_realtime_demo", workdir: "" }],
        workdir,
      ),
    );
  });

  it.effect(
    "refuses to delete outside the staging root when container.name contains path-traversal segments",
    () => {
      // `container.name` is a `docker ps` field value read back off whatever containers
      // matched the caller's project-label filter — external metadata, not something this
      // process generated. A crafted name containing `..` segments must never be able to walk
      // `rm -rf` outside `start-secrets/` and onto an unrelated host directory.
      return withTempDirectory("legacy-start-secrets-cleanup-", (workdir, fs, path) =>
        Effect.gen(function* () {
          const canary = path.join(workdir, "important");
          yield* fs.makeDirectory(canary, { recursive: true });
          yield* fs.writeFileString(path.join(canary, "do-not-delete"), "canary");
          yield* legacyCleanupStartSecrets(
            [{ id: "abc123", name: "../../important", workdir: "" }],
            workdir,
          );
          expect(yield* fs.exists(canary)).toBe(true);
        }),
      );
    },
  );

  it.effect("refuses to delete the whole staging root when container.name is empty", () => {
    // Degenerate case: an empty `name` would otherwise resolve to the staging root itself
    // (`<workdir>/supabase/.temp/start-secrets`) and wipe every project's staged secrets in
    // one call, not just this one container's.
    return withTempDirectory("legacy-start-secrets-cleanup-", (workdir, fs, path) =>
      Effect.gen(function* () {
        const stagingRoot = path.join(workdir, "supabase", ".temp", "start-secrets");
        const otherProjectSecretDir = path.join(stagingRoot, "supabase_kong_other");
        yield* fs.makeDirectory(otherProjectSecretDir, { recursive: true });
        yield* fs.writeFileString(path.join(otherProjectSecretDir, "secret-0"), "kong-secret");
        yield* legacyCleanupStartSecrets([{ id: "abc123", name: "", workdir: "" }], workdir);
        expect(yield* fs.exists(otherProjectSecretDir)).toBe(true);
      }),
    );
  });
});
