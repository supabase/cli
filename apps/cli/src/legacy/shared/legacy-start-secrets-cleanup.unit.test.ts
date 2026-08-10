import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { legacyCleanupStartSecrets } from "./legacy-start-secrets-cleanup.ts";

describe("legacyCleanupStartSecrets", () => {
  it.effect("removes a NAMED container's secret directory keyed off container.name", () => {
    const workdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-"));
    const secretDir = join(workdir, "supabase", ".temp", "start-secrets", "supabase_kong_demo");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(secretDir, { recursive: true });
      yield* fs.writeFileString(path.join(secretDir, "secret-0"), "kong-secret");
      yield* legacyCleanupStartSecrets(
        [{ id: "abc123", name: "supabase_kong_demo", workdir: "" }],
        workdir,
      );
      expect(yield* fs.exists(secretDir)).toBe(false);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "falls back to fallbackWorkdir when a container carries no com.supabase.cli.workdir label",
    () => {
      const workdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-"));
      const secretDir = join(workdir, "supabase", ".temp", "start-secrets", "supabase_kong_demo");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(secretDir, { recursive: true });
        yield* fs.writeFileString(path.join(secretDir, "secret-0"), "kong-secret");
        yield* legacyCleanupStartSecrets(
          [{ id: "abc123", name: "supabase_kong_demo", workdir: "" }],
          workdir,
        );
        expect(yield* fs.exists(secretDir)).toBe(false);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("prefers a container's OWN com.supabase.cli.workdir label over fallbackWorkdir", () => {
    const ownWorkdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-own-"));
    const otherWorkdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-other-"));
    const secretDir = join(ownWorkdir, "supabase", ".temp", "start-secrets", "supabase_db_demo");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(secretDir, { recursive: true });
      yield* fs.writeFileString(path.join(secretDir, "secret-0"), "db-secret");
      yield* legacyCleanupStartSecrets(
        [{ id: "abc123", name: "supabase_db_demo", workdir: ownWorkdir }],
        otherWorkdir,
      );
      expect(yield* fs.exists(secretDir)).toBe(false);
      rmSync(ownWorkdir, { recursive: true, force: true });
      rmSync(otherWorkdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect("never fails when nothing was ever staged for a container", () => {
    const workdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-"));
    return Effect.gen(function* () {
      yield* legacyCleanupStartSecrets(
        [{ id: "abc123", name: "supabase_realtime_demo", workdir: "" }],
        workdir,
      );
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });

  it.effect(
    "refuses to delete outside the staging root when container.name contains path-traversal segments",
    () => {
      // `container.name` is a `docker ps` field value read back off whatever containers
      // matched the caller's project-label filter — external metadata, not something this
      // process generated. A crafted name containing `..` segments must never be able to walk
      // `rm -rf` outside `start-secrets/` and onto an unrelated host directory.
      const workdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-"));
      const canary = join(workdir, "important");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(canary, { recursive: true });
        yield* fs.writeFileString(path.join(canary, "do-not-delete"), "canary");
        yield* legacyCleanupStartSecrets(
          [{ id: "abc123", name: "../../important", workdir: "" }],
          workdir,
        );
        expect(yield* fs.exists(canary)).toBe(true);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect("refuses to delete the whole staging root when container.name is empty", () => {
    // Degenerate case: an empty `name` would otherwise resolve to the staging root itself
    // (`<workdir>/supabase/.temp/start-secrets`) and wipe every project's staged secrets in
    // one call, not just this one container's.
    const workdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-"));
    const stagingRoot = join(workdir, "supabase", ".temp", "start-secrets");
    const otherProjectSecretDir = join(stagingRoot, "supabase_kong_other");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(otherProjectSecretDir, { recursive: true });
      yield* fs.writeFileString(path.join(otherProjectSecretDir, "secret-0"), "kong-secret");
      yield* legacyCleanupStartSecrets([{ id: "abc123", name: "", workdir: "" }], workdir);
      expect(yield* fs.exists(otherProjectSecretDir)).toBe(true);
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });
});
