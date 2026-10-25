import { LegacyProjectState } from "../../command-internal/legacy-project-state.service.ts";
import { legacyProjectStateLayer } from "../../command-internal/legacy-project-state.layer.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { holdLock } from "@supabase/stack/effect";
import {
  Cause,
  Clock,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  Queue,
  Scope,
} from "effect";
import { badArgument } from "effect/PlatformError";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/http/HttpClient";

import { mockAnalytics, mockOutput } from "../../../tests/helpers/mocks.ts";
import {
  legacyStateAccesses,
  recordingFileSystem,
  seedLegacyStateDecoys,
} from "../../../tests/helpers/legacy-state-guard.ts";
import {
  VALID_REF,
  buildTestRuntime,
  mockCommandSettings,
  mockCommandCredentialsTracked,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import { writeProjectLink } from "../../command-internal/project-link.ts";
import {
  projectStateMode,
  projectStateModeLayer,
} from "../../command-internal/project-state-mode.ts";
import { unlink } from "./unlink.handler.ts";

const tempRoot = useTempWorkdir("supabase-unlink-int-");

const noopHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("unexpected HttpClient.execute in unlink test")),
);

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  deleteFails?: boolean;
  removeFails?: boolean;
  stack?: boolean;
}

// Wraps the real state service but forces `removeAll` to fail, so the temp-dir-removal
// error branch is exercised deterministically, independent of filesystem permissions.
const failingRemoveStateLayer = Layer.effect(
  LegacyProjectState,
  Effect.gen(function* () {
    const real = yield* LegacyProjectState;
    return LegacyProjectState.of({
      ...real,
      removeAll: () =>
        Effect.fail(
          badArgument({
            module: "FileSystem",
            method: "remove",
            description: "permission denied",
          }),
        ),
    });
  }),
).pipe(Layer.provide(legacyProjectStateLayer), Layer.provide(BunServices.layer));

const seedProjectRef = (workdir: string, ref: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = path.join(workdir, "supabase", ".temp");
    yield* fs.makeDirectory(tempDir, { recursive: true });
    yield* fs.writeFileString(path.join(tempDir, "project-ref"), ref);
  });

const tempDirExists = (workdir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(path.join(workdir, "supabase", ".temp"));
  });

function setup(opts: SetupOpts = {}) {
  const recorder = recordingFileSystem();
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const credentials = mockCommandCredentialsTracked({ deleteFails: opts.deleteFails });
  const apiMock = mockCommandPlatformApiService({ v1: {} });
  const cliSettings = mockCommandSettings({
    workdir: tempRoot.current,
    projectId: Option.none(),
  });
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: noopHttpClient },
      cliSettings,
      analytics: mockAnalytics(),
      telemetry: telemetry.layer,
      fileSystem: recorder.layer,
    }),
    credentials.layer,
    ...(opts.removeFails === true ? [failingRemoveStateLayer] : []),
    ...(opts.stack === true ? [projectStateModeLayer("stack")] : []),
  );
  return {
    layer,
    out,
    telemetry,
    credentials,
    workdir: tempRoot.current,
    accessed: recorder.accessed,
  };
}

describe("unlink integration", () => {
  it.effect("unlinks: removes the temp dir, deletes the keyring entry, prints Finished", () => {
    const { layer, out, credentials, workdir } = setup();
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      yield* unlink();
      const stillExists = yield* tempDirExists(workdir);
      expect(stillExists).toBe(false);
      expect(credentials.deletedRefs).toEqual([VALID_REF]);
      expect(out.stdoutText).toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes 'Unlinking project: <ref>' to stderr", () => {
    const { layer, out, workdir } = setup();
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      yield* unlink();
      expect(out.stderrText).toContain(`Unlinking project: ${VALID_REF}`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("succeeds when no credential is stored (keyring not-found ignored)", () => {
    // The mock returns true here; a real not-found returns false without erroring —
    // either way unlink succeeds.
    const { layer, out, workdir } = setup();
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      yield* unlink();
      expect(out.stdoutText).toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ProjectRefNotLinkedError when the project-ref file is absent", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(unlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Cause.pretty(exit.cause);
        expect(json).toContain("ProjectRefNotLinkedError");
        expect(json).toContain("Cannot find project ref");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the keyring delete errors (permission denied)", () => {
    const { layer, workdir } = setup({ deleteFails: true });
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      const exit = yield* Effect.exit(unlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("CredentialDeleteError");
      }
      const stillExists = yield* tempDirExists(workdir);
      expect(stillExists).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with UnlinkTempRemovalError when the temp dir cannot be removed", () => {
    const { layer, workdir } = setup({ removeFails: true });
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      const exit = yield* Effect.exit(unlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Cause.pretty(exit.cause);
        expect(json).toContain("UnlinkTempRemovalError");
        expect(json).toContain("failed to remove temp directory");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces both messages when temp removal and keyring delete both fail", () => {
    const { layer, workdir } = setup({ removeFails: true, deleteFails: true });
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      const exit = yield* Effect.exit(unlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = Cause.pretty(exit.cause);
        expect(json).toContain("failed to remove temp directory");
        expect(json).toContain("failed to delete project credential");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry via ensuring", () => {
    const { layer, telemetry, workdir } = setup();
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      yield* unlink();
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("json output: emits a structured success and suppresses the Finished line", () => {
    const { layer, out, workdir } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      yield* unlink();
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_ref: VALID_REF });
      expect(out.stdoutText).not.toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("stream-json output: emits a structured success", () => {
    const { layer, out, workdir } = setup({ format: "stream-json" });
    return Effect.gen(function* () {
      yield* seedProjectRef(workdir, VALID_REF);
      yield* unlink();
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_ref: VALID_REF });
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when SUPABASE_EXPERIMENTAL_STACK is not 0 or 1, removing nothing", () => {
    const { layer, credentials, workdir } = setup();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const mode = yield* projectStateMode({
        cwd: workdir,
        env: { SUPABASE_EXPERIMENTAL_STACK: "maybe" },
      }).pipe(Effect.exit);
      yield* seedProjectRef(workdir, VALID_REF);
      yield* writeProjectLink(workdir, {
        project: { ref: VALID_REF },
        active_branch: { ref: VALID_REF },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

      const error = yield* unlink().pipe(Effect.provide(projectStateModeLayer(mode)), Effect.flip);

      expect(error).toMatchObject({
        _tag: "ExperimentalFeatureFlagError",
        message: "SUPABASE_EXPERIMENTAL_STACK must be 0 or 1 when set",
      });
      expect(yield* tempDirExists(workdir)).toBe(true);
      expect(yield* fs.exists(path.join(workdir, "supabase", ".link.json"))).toBe(true);
      expect(credentials.deletedRefs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  describe("in stack mode", () => {
    const seedLinkDocument = (workdir: string, ref: string) =>
      writeProjectLink(workdir, {
        project: { ref: VALID_REF },
        active_branch: { ref },
        fetchedAt: "2026-01-01T00:00:00.000Z",
      });

    const linkDocumentExists = (workdir: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        return yield* fs.exists(path.join(workdir, "supabase", ".link.json"));
      });

    it.effect("removes the link document and the credential of the active branch", () => {
      const { layer, out, credentials, workdir } = setup({ stack: true });
      return Effect.gen(function* () {
        yield* seedLinkDocument(workdir, "branchprojectrefabcd");
        yield* unlink();
        expect(yield* linkDocumentExists(workdir)).toBe(false);
        expect(credentials.deletedRefs).toEqual(["branchprojectrefabcd"]);
        expect(out.stdoutText).toContain("Finished supabase unlink.");
      }).pipe(Effect.provide(layer));
    });

    it.effect("reports not linked without creating supabase/ when the project has none", () => {
      const { layer, credentials, workdir } = setup({ stack: true });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const error = yield* unlink().pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "ProjectRefNotLinkedError" });
        expect(yield* fs.exists(path.join(workdir, "supabase"))).toBe(false);
        expect(credentials.deletedRefs).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("fails on a busy project lease before removing the link or its credential", () => {
      const { layer, credentials, workdir } = setup({ stack: true });
      return Effect.gen(function* () {
        yield* seedLinkDocument(workdir, VALID_REF);
        yield* holdLock(`${workdir}/supabase/.supabase.lock.lease`, "1 hour", "supabase.lock");
        // The lease wait runs on the test clock; the lock stays held, so the outcome is fixed.
        yield* TestClock.adjust("1 second").pipe(
          Effect.andThen(Effect.yieldNow),
          Effect.forever,
          Effect.forkScoped,
        );

        const error = yield* unlink().pipe(Effect.flip);

        expect(error).toMatchObject({ _tag: "LockResolutionError", reason: "lease-busy" });
        expect(yield* linkDocumentExists(workdir)).toBe(true);
        expect(credentials.deletedRefs).toEqual([]);
      }).pipe(Effect.provide(layer));
    });

    it.effect("acts on the link document it reads under the lease, not one read before it", () => {
      const { layer, out, credentials, workdir } = setup({ stack: true });
      return Effect.gen(function* () {
        const concurrentLink = yield* Scope.make();
        yield* seedLinkDocument(workdir, "firstprojectrefabcdef");
        yield* holdLock(`${workdir}/supabase/.supabase.lock.lease`, "1 hour", "supabase.lock").pipe(
          Scope.provide(concurrentLink),
        );
        // Each sleep the lease wait registers on the test clock is announced here.
        const sleeps = yield* Queue.unbounded<void>();
        const unlinking = yield* Clock.clockWith((clock) =>
          unlink().pipe(
            Effect.provideService(Clock.Clock, {
              currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
              currentTimeMillis: clock.currentTimeMillis,
              currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
              currentTimeNanos: clock.currentTimeNanos,
              monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
              monotonicTimeNanos: clock.monotonicTimeNanos,
              sleep: (duration) =>
                Queue.offer(sleeps, undefined).pipe(Effect.andThen(clock.sleep(duration))),
            }),
            Effect.forkScoped,
          ),
        );

        yield* Queue.take(sleeps);

        yield* seedLinkDocument(workdir, "secondprojectrefabcde");
        yield* Scope.close(concurrentLink, Exit.void);
        const wakeOnEachSleep = TestClock.adjust("50 millis").pipe(
          Effect.andThen(Queue.take(sleeps)),
          Effect.forever,
        );
        yield* Effect.race(Fiber.join(unlinking), wakeOnEachSleep);

        expect(out.stderrText).toContain("Unlinking project: secondprojectrefabcde");
        expect(credentials.deletedRefs).toEqual(["secondprojectrefabcde"]);
        expect(yield* linkDocumentExists(workdir)).toBe(false);
      }).pipe(Effect.provide(layer));
    });

    it.effect("leaves supabase/supabase.lock untouched", () => {
      const { layer, workdir } = setup({ stack: true });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lock = path.join(workdir, "supabase", "supabase.lock");
        yield* seedLinkDocument(workdir, VALID_REF);
        yield* fs.writeFileString(lock, '{"linked":"kept"}\n');
        yield* unlink();
        expect(yield* fs.readFileString(lock)).toBe('{"linked":"kept"}\n');
      }).pipe(Effect.provide(layer));
    });

    it.effect("leaves the legacy temp dir alone without reading or writing it", () => {
      const { layer, workdir, accessed } = setup({ stack: true });
      return Effect.andThen(
        seedLegacyStateDecoys(workdir),
        Effect.gen(function* () {
          yield* seedLinkDocument(workdir, VALID_REF);
          yield* unlink();
          expect(accessed.some((entry) => entry.includes(".link.json"))).toBe(true);
          expect(legacyStateAccesses(accessed)).toEqual([]);
          expect(yield* tempDirExists(workdir)).toBe(true);
        }).pipe(Effect.provide(layer)),
      );
    });

    it.effect("fails with ProjectRefNotLinkedError when only legacy state exists", () => {
      const { layer, workdir } = setup({ stack: true });
      return Effect.gen(function* () {
        yield* seedProjectRef(workdir, VALID_REF);
        const error = yield* unlink().pipe(Effect.flip);
        expect(error._tag).toBe("ProjectRefNotLinkedError");
      }).pipe(Effect.provide(layer));
    });

    it.effect("removes a malformed link document and leaves credentials alone", () => {
      const { layer, credentials, out, workdir } = setup({ stack: true });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
        yield* fs.writeFileString(path.join(workdir, "supabase", ".link.json"), "{not json");
        yield* unlink();
        expect(yield* linkDocumentExists(workdir)).toBe(false);
        expect(credentials.deletedRefs).toEqual([]);
        expect(out.stdoutText).toContain("Finished supabase unlink.");
      }).pipe(Effect.provide(layer));
    });
  });
});
