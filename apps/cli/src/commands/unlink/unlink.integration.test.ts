import { LegacyProjectState } from "../../command-internal/legacy-project-state.service.ts";
import { legacyProjectStateLayer } from "../../command-internal/legacy-project-state.layer.ts";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { badArgument } from "effect/PlatformError";
import * as HttpClient from "effect/http/HttpClient";

import { mockAnalytics, mockOutput } from "../../../tests/helpers/mocks.ts";
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
import { projectStateModeLayer } from "../../command-internal/project-state-mode.ts";
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
    }),
    credentials.layer,
    ...(opts.removeFails === true ? [failingRemoveStateLayer] : []),
    ...(opts.stack === true ? [projectStateModeLayer("stack")] : []),
  );
  return { layer, out, telemetry, credentials, workdir: tempRoot.current };
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

    it.effect("leaves the legacy temp dir alone", () => {
      const { layer, workdir } = setup({ stack: true });
      return Effect.gen(function* () {
        yield* seedLinkDocument(workdir, VALID_REF);
        yield* seedProjectRef(workdir, VALID_REF);
        yield* unlink();
        expect(yield* tempDirExists(workdir)).toBe(true);
      }).pipe(Effect.provide(layer));
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
