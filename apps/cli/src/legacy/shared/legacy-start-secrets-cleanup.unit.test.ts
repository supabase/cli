import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { legacyCleanupStartSecrets } from "./legacy-start-secrets-cleanup.ts";

describe("legacyCleanupStartSecrets", () => {
  it.effect(
    "removes a NAMED container's secret directory keyed off container.name when secretDirId is empty",
    () => {
      const workdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-"));
      const secretDir = join(workdir, "supabase", ".temp", "start-secrets", "supabase_kong_demo");
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(secretDir, { recursive: true });
        yield* fs.writeFileString(path.join(secretDir, "secret-0"), "kong-secret");
        yield* legacyCleanupStartSecrets(
          [{ id: "abc123", name: "supabase_kong_demo", workdir: "", secretDirId: "" }],
          workdir,
        );
        expect(yield* fs.exists(secretDir)).toBe(false);
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

  it.effect(
    "removes an UNNAMED (shadow) container's secret directory keyed off secretDirId, not container.name",
    () => {
      // The shadow database is created with no name (Docker auto-generates one) and stages
      // its secrets under a randomized `shadow-<uuid>` id it stamps onto
      // `LEGACY_CLI_SECRET_DIR_LABEL` at creation time — `container.name` here is Docker's
      // own auto-generated string, which bears no relation to that directory, so cleanup
      // must prefer `secretDirId` whenever it's present (review: PRRT_kwDOErm0O86W8ZYt).
      const workdir = mkdtempSync(join(tmpdir(), "legacy-start-secrets-cleanup-"));
      const secretDirId = "shadow-11111111-1111-1111-1111-111111111111";
      const secretDir = join(workdir, "supabase", ".temp", "start-secrets", secretDirId);
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(secretDir, { recursive: true });
        yield* fs.writeFileString(path.join(secretDir, "secret-0"), "pgsodium-root-key");
        yield* legacyCleanupStartSecrets(
          [{ id: "abc123", name: "sad_turing", workdir: "", secretDirId }],
          workdir,
        );
        expect(yield* fs.exists(secretDir)).toBe(false);
        // The auto-generated Docker name must never be treated as a directory to remove —
        // asserting its absence would be vacuous (it was never created), so this only
        // documents intent alongside the positive assertion above.
        rmSync(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(BunServices.layer));
    },
  );

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
          [{ id: "abc123", name: "supabase_kong_demo", workdir: "", secretDirId: "" }],
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
        [{ id: "abc123", name: "supabase_db_demo", workdir: ownWorkdir, secretDirId: "" }],
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
        [{ id: "abc123", name: "supabase_realtime_demo", workdir: "", secretDirId: "" }],
        workdir,
      );
      rmSync(workdir, { recursive: true, force: true });
    }).pipe(Effect.provide(BunServices.layer));
  });
});
