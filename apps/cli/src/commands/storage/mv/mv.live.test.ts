import { randomUUID } from "node:crypto";

import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Path } from "effect";
import { expect } from "vitest";

import {
  removeStorageLiveObject,
  requireLiveSuccess,
  storageLiveFlags,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";

test("moves an uploaded object to a new path", ({ cli, cliEffect, project, workspace }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const suffix = randomUUID().slice(0, 8);
      const local = path.join(workspace.path, `mv-src-${suffix}.txt`);
      const source = `ss:///${project.storageBucket}/mv-src-${suffix}.txt`;
      const destination = `ss:///${project.storageBucket}/mv-dst-${suffix}.txt`;
      yield* fs.writeFileString(local, "live-e2e storage payload\n");

      const target = Effect.gen(function* () {
        const linked = yield* cliEffect(["link", "--project-ref", project.ref], {
          env: { SUPABASE_DB_PASSWORD: project.dbPassword },
        });
        requireLiveSuccess(linked, "link setup for storage mv");
        const uploaded = yield* cliEffect(["storage", "cp", local, source, ...storageLiveFlags]);
        requireLiveSuccess(uploaded, "storage cp setup for storage mv");

        const moved = yield* cliEffect(["storage", "mv", source, destination, ...storageLiveFlags]);
        expect(moved.exitCode, moved.stderr).toBe(0);
        expect(moved.stderr, moved.stderr).toContain("Moving object:");

        const listed = yield* cliEffect([
          "storage",
          "ls",
          `ss:///${project.storageBucket}/`,
          ...storageLiveFlags,
        ]);
        requireLiveSuccess(listed, "storage ls proof for storage mv");
        expect(listed.stdout).toContain(`mv-dst-${suffix}.txt`);
        expect(listed.stdout).not.toContain(`mv-src-${suffix}.txt`);
      });

      const targetExit = yield* Effect.exit(target);
      const cleanupErrors: Array<unknown> = [];
      for (const remote of [destination, source]) {
        const cleanupExit = yield* Effect.exit(
          Effect.promise(() => removeStorageLiveObject(cli, remote)),
        );
        if (Exit.isFailure(cleanupExit)) {
          cleanupErrors.push(Cause.squash(cleanupExit.cause));
        }
      }
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors,
      };
    }).pipe(Effect.provide(BunServices.layer)),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
