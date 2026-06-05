import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option } from "effect";
import { badArgument } from "effect/PlatformError";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { mockAnalytics, mockOutput } from "../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyCredentialsTracked,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import { legacyUnlink } from "./unlink.handler.ts";

const tempRoot = useLegacyTempWorkdir("supabase-unlink-int-");

const noopHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die("unexpected HttpClient.execute in unlink test")),
);

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  deleteFails?: boolean;
  removeFails?: boolean;
}

// Wraps the real Bun FileSystem but forces `remove` to fail, so the
// temp-dir-removal error branch can be exercised deterministically (cross-platform,
// independent of filesystem permissions).
const failingRemoveFsLayer = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const real = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...real,
      remove: () =>
        Effect.fail(
          badArgument({
            module: "FileSystem",
            method: "remove",
            description: "permission denied",
          }),
        ),
    });
  }),
).pipe(Layer.provide(BunServices.layer));

function seedProjectRef(workdir: string, ref: string) {
  mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
  writeFileSync(join(workdir, "supabase", ".temp", "project-ref"), ref);
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockLegacyTelemetryStateTracked();
  const credentials = mockLegacyCredentialsTracked({ deleteFails: opts.deleteFails });
  const apiMock = mockLegacyPlatformApiService({ v1: {} });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current, projectId: Option.none() });
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api: { layer: apiMock.layer, httpClientLayer: noopHttpClient },
      cliConfig,
      analytics: mockAnalytics(),
      telemetry: telemetry.layer,
    }),
    credentials.layer,
    ...(opts.removeFails === true ? [failingRemoveFsLayer] : []),
  );
  return { layer, out, telemetry, credentials, workdir: tempRoot.current };
}

describe("legacy unlink integration", () => {
  it.live("unlinks: removes the temp dir, deletes the keyring entry, prints Finished", () => {
    const { layer, out, credentials, workdir } = setup();
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyUnlink();
      expect(existsSync(join(workdir, "supabase", ".temp"))).toBe(false);
      expect(credentials.deletedRefs).toEqual([LEGACY_VALID_REF]);
      expect(out.stdoutText).toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.live("writes 'Unlinking project: <ref>' to stderr", () => {
    const { layer, out, workdir } = setup();
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyUnlink();
      expect(out.stderrText).toContain(`Unlinking project: ${LEGACY_VALID_REF}`);
    }).pipe(Effect.provide(layer));
  });

  it.live("succeeds when no credential is stored (keyring not-found ignored)", () => {
    // The tracked credentials mock returns `true`; a real not-found returns
    // `false` without erroring — either way unlink succeeds.
    const { layer, out, workdir } = setup();
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyUnlink();
      expect(out.stdoutText).toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectNotLinkedError when the project-ref file is absent", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyUnlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectNotLinkedError");
        expect(json).toContain("Cannot find project ref");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the keyring delete errors (permission denied)", () => {
    const { layer, workdir } = setup({ deleteFails: true });
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyUnlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyCredentialDeleteError");
      }
      // The temp dir is still removed before the credential delete is attempted.
      expect(existsSync(join(workdir, "supabase", ".temp"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyUnlinkTempRemovalError when the temp dir cannot be removed", () => {
    const { layer, workdir } = setup({ removeFails: true });
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyUnlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyUnlinkTempRemovalError");
        expect(json).toContain("failed to remove temp directory");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces both messages when temp removal and keyring delete both fail", () => {
    const { layer, workdir } = setup({ removeFails: true, deleteFails: true });
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyUnlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        // errors.Join parity — both failure messages are surfaced, not just the first.
        expect(json).toContain("failed to remove temp directory");
        expect(json).toContain("failed to delete project credential");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring", () => {
    const { layer, telemetry, workdir } = setup();
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyUnlink();
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("json output: emits a structured success and suppresses the Finished line", () => {
    const { layer, out, workdir } = setup({ format: "json" });
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyUnlink();
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_ref: LEGACY_VALID_REF });
      expect(out.stdoutText).not.toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.live("stream-json output: emits a structured success", () => {
    const { layer, out, workdir } = setup({ format: "stream-json" });
    seedProjectRef(workdir, LEGACY_VALID_REF);
    return Effect.gen(function* () {
      yield* legacyUnlink();
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_ref: LEGACY_VALID_REF });
    }).pipe(Effect.provide(layer));
  });
});
