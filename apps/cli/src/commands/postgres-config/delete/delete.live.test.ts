import { Cause, Effect, Exit, Schema } from "effect";
import { expect } from "vitest";

import {
  experimentalProjectLiveFlags,
  requireLiveSuccess,
  test,
  throwWithCleanup,
} from "../../../../tests/helpers/live.ts";
import { liveFailure, proveOverride, removeOverride } from "../postgres-config.live-helpers.ts";

// Seeds its own override and proves it landed before deleting, so the absence
// assertion cannot be satisfied by the pre-seed state. Teardown removes the
// seeded key only when the test did not already prove it gone.
//
// Not wired to the test `signal`: an interrupt SIGKILLs an in-flight cleanup
// mid-request (the run's scope release kills the process group), so letting the
// bounded cleanup run out is strictly safer.
test("removes the test-seeded override and get proves it is gone", ({ cli, cliEffect, project }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const flags = experimentalProjectLiveFlags(project);

      const target = Effect.gen(function* () {
        const seeded = yield* cliEffect([
          "postgres-config",
          "update",
          "--config",
          "maintenance_work_mem=16MB",
          ...flags,
          "--no-restart",
        ]);
        yield* Effect.try({
          try: () =>
            requireLiveSuccess(seeded, "postgres-config update setup for postgres-config delete"),
          catch: liveFailure,
        });
        yield* proveOverride(
          cli,
          project,
          "maintenance_work_mem",
          "16MB",
          "postgres-config get seed proof for postgres-config delete",
        );

        const removed = yield* cliEffect([
          "postgres-config",
          "delete",
          "--config",
          "maintenance_work_mem",
          ...flags,
          "--no-restart",
          "-o",
          "json",
        ]);
        expect(removed.exitCode, removed.stderr).toBe(0);
        expect(removed.stdout, removed.stderr).not.toBe("");
        const remaining = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
        )(removed.stdout);
        expect(remaining["maintenance_work_mem"], removed.stdout).toBeUndefined();

        yield* proveOverride(
          cli,
          project,
          "maintenance_work_mem",
          undefined,
          "postgres-config get proof for postgres-config delete",
        );
      });

      // A successful target already proved the key gone, so only a failed one needs cleanup.
      const targetExit = yield* Effect.exit(target);
      const cleanupErrors: Array<unknown> = [];
      if (Exit.isFailure(targetExit)) {
        const cleanupExit = yield* Effect.exit(
          removeOverride(cli, project, "maintenance_work_mem"),
        );
        if (Exit.isFailure(cleanupExit)) cleanupErrors.push(Cause.squash(cleanupExit.cause));
      }
      return {
        targetError: Exit.isFailure(targetExit) ? Cause.squash(targetExit.cause) : undefined,
        cleanupErrors,
      };
    }),
  ).then(({ targetError, cleanupErrors }) => throwWithCleanup(targetError, cleanupErrors)));
