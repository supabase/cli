import { randomUUID } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vitest";

import {
  requireLiveSuccess,
  storageLiveFlags,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";
import { removeObject } from "../../../../tests/helpers/storage-live.ts";

test("lists an uploaded object", ({ cli, cliEffect, project, workspace }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const suffix = randomUUID().slice(0, 8);
      const local = path.join(workspace.path, `upload-${suffix}.txt`);
      const remote = `ss:///${project.storageBucket}/upload-${suffix}.txt`;
      yield* fs.writeFileString(local, "live-e2e storage payload\n");

      const target = Effect.gen(function* () {
        const linked = yield* cliEffect(["link", "--project-ref", project.ref], {
          env: { SUPABASE_DB_PASSWORD: project.dbPassword },
        });
        requireLiveSuccess(linked, "link setup for storage ls");
        const uploaded = yield* cliEffect(["storage", "cp", local, remote, ...storageLiveFlags]);
        requireLiveSuccess(uploaded, "storage cp setup for storage ls");

        const result = yield* cliEffect([
          "storage",
          "ls",
          `ss:///${project.storageBucket}/`,
          ...storageLiveFlags,
        ]);
        expect(result.exitCode, result.stderr).toBe(0);
        expect(result.stdout).toContain(`upload-${suffix}.txt`);
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupExit = yield* Effect.exit(removeObject(cli, remote));
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors: Exit.isFailure(cleanupExit) ? [Cause.squash(cleanupExit.cause)] : [],
      };
    }).pipe(Effect.provide(BunServices.layer)),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
