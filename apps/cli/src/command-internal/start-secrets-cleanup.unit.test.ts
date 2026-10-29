import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import { cleanupStartSecrets } from "./start-secrets-cleanup.ts";

const makeTempWorkdir = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectory({ prefix });
  }).pipe(Effect.provide(NodeServices.layer));

describe("cleanupStartSecrets", () => {
  it.effect("removes a NAMED container's secret directory keyed off container.name", () => {
    return Effect.gen(function* () {
      const workdir = yield* makeTempWorkdir("start-secrets-cleanup-");
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const secretDir = path.join(
          workdir,
          "supabase",
          ".temp",
          "start-secrets",
          "supabase_kong_demo",
        );
        yield* fs.makeDirectory(secretDir, { recursive: true });
        yield* fs.writeFileString(path.join(secretDir, "secret-0"), "kong-secret");
        yield* cleanupStartSecrets(
          [{ id: "abc123", name: "supabase_kong_demo", workdir: "" }],
          workdir,
        );
        expect(yield* fs.exists(secretDir)).toBe(false);
        yield* fs.remove(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer));
    });
  });

  it.effect(
    "falls back to fallbackWorkdir when a container carries no com.supabase.cli.workdir label",
    () => {
      return Effect.gen(function* () {
        const workdir = yield* makeTempWorkdir("start-secrets-cleanup-");
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const secretDir = path.join(
            workdir,
            "supabase",
            ".temp",
            "start-secrets",
            "supabase_kong_demo",
          );
          yield* fs.makeDirectory(secretDir, { recursive: true });
          yield* fs.writeFileString(path.join(secretDir, "secret-0"), "kong-secret");
          yield* cleanupStartSecrets(
            [{ id: "abc123", name: "supabase_kong_demo", workdir: "" }],
            workdir,
          );
          expect(yield* fs.exists(secretDir)).toBe(false);
          yield* fs.remove(workdir, { recursive: true, force: true });
        }).pipe(Effect.provide(NodeServices.layer));
      });
    },
  );

  it.effect("prefers a container's OWN com.supabase.cli.workdir label over fallbackWorkdir", () => {
    return Effect.gen(function* () {
      const ownWorkdir = yield* makeTempWorkdir("start-secrets-cleanup-own-");
      const otherWorkdir = yield* makeTempWorkdir("start-secrets-cleanup-other-");
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const secretDir = path.join(
          ownWorkdir,
          "supabase",
          ".temp",
          "start-secrets",
          "supabase_db_demo",
        );
        yield* fs.makeDirectory(secretDir, { recursive: true });
        yield* fs.writeFileString(path.join(secretDir, "secret-0"), "db-secret");
        yield* cleanupStartSecrets(
          [{ id: "abc123", name: "supabase_db_demo", workdir: ownWorkdir }],
          otherWorkdir,
        );
        expect(yield* fs.exists(secretDir)).toBe(false);
        yield* fs.remove(ownWorkdir, { recursive: true, force: true });
        yield* fs.remove(otherWorkdir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer));
    });
  });

  it.effect("never fails when nothing was ever staged for a container", () => {
    return Effect.gen(function* () {
      const workdir = yield* makeTempWorkdir("start-secrets-cleanup-");
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* cleanupStartSecrets(
          [{ id: "abc123", name: "supabase_realtime_demo", workdir: "" }],
          workdir,
        );
        yield* fs.remove(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer));
    });
  });

  it.effect(
    "refuses to delete outside the staging root when container.name contains path-traversal segments",
    () => {
      return Effect.gen(function* () {
        const workdir = yield* makeTempWorkdir("start-secrets-cleanup-");
        yield* Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const canary = path.join(workdir, "important");
          yield* fs.makeDirectory(canary, { recursive: true });
          yield* fs.writeFileString(path.join(canary, "do-not-delete"), "canary");
          yield* cleanupStartSecrets(
            [{ id: "abc123", name: "../../../important", workdir: "" }],
            workdir,
          );
          expect(yield* fs.exists(canary)).toBe(true);
          yield* fs.remove(workdir, { recursive: true, force: true });
        }).pipe(Effect.provide(NodeServices.layer));
      });
    },
  );

  it.effect("refuses to delete the whole staging root when container.name is empty", () => {
    return Effect.gen(function* () {
      const workdir = yield* makeTempWorkdir("start-secrets-cleanup-");
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const stagingRoot = path.join(workdir, "supabase", ".temp", "start-secrets");
        const otherProjectSecretDir = path.join(stagingRoot, "supabase_kong_other");
        yield* fs.makeDirectory(otherProjectSecretDir, { recursive: true });
        yield* fs.writeFileString(path.join(otherProjectSecretDir, "secret-0"), "kong-secret");
        yield* cleanupStartSecrets([{ id: "abc123", name: "", workdir: "" }], workdir);
        expect(yield* fs.exists(otherProjectSecretDir)).toBe(true);
        yield* fs.remove(workdir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer));
    });
  });
});
