import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Layer, Option } from "effect";
import { badArgument } from "effect/PlatformError";
import * as HttpClient from "effect/unstable/http/HttpClient";

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
}

// Wraps the real Bun FileSystem but forces `remove` to fail, so the temp-dir-removal
// error branch is exercised deterministically, independent of filesystem permissions.
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
    ...(opts.removeFails === true ? [failingRemoveFsLayer] : []),
  );
  return { layer, out, telemetry, credentials, workdir: tempRoot.current };
}

describe("unlink integration", () => {
  it.live("unlinks: removes the temp dir, deletes the keyring entry, prints Finished", () => {
    const { layer, out, credentials, workdir } = setup();
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      yield* unlink();
      expect(existsSync(join(workdir, "supabase", ".temp"))).toBe(false);
      expect(credentials.deletedRefs).toEqual([VALID_REF]);
      expect(out.stdoutText).toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.live("writes 'Unlinking project: <ref>' to stderr", () => {
    const { layer, out, workdir } = setup();
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      yield* unlink();
      expect(out.stderrText).toContain(`Unlinking project: ${VALID_REF}`);
    }).pipe(Effect.provide(layer));
  });

  it.live("succeeds when no credential is stored (keyring not-found ignored)", () => {
    // The mock returns true here; a real not-found returns false without erroring —
    // either way unlink succeeds.
    const { layer, out, workdir } = setup();
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      yield* unlink();
      expect(out.stdoutText).toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with ProjectRefNotLinkedError when the project-ref file is absent", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(unlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("ProjectRefNotLinkedError");
        expect(json).toContain("Cannot find project ref");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the keyring delete errors (permission denied)", () => {
    const { layer, workdir } = setup({ deleteFails: true });
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(unlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("CredentialDeleteError");
      }
      expect(existsSync(join(workdir, "supabase", ".temp"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with UnlinkTempRemovalError when the temp dir cannot be removed", () => {
    const { layer, workdir } = setup({ removeFails: true });
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(unlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("UnlinkTempRemovalError");
        expect(json).toContain("failed to remove temp directory");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces both messages when temp removal and keyring delete both fail", () => {
    const { layer, workdir } = setup({ removeFails: true, deleteFails: true });
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(unlink());
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("failed to remove temp directory");
        expect(json).toContain("failed to delete project credential");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring", () => {
    const { layer, telemetry, workdir } = setup();
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      yield* unlink();
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("json output: emits a structured success and suppresses the Finished line", () => {
    const { layer, out, workdir } = setup({ format: "json" });
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      yield* unlink();
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_ref: VALID_REF });
      expect(out.stdoutText).not.toContain("Finished supabase unlink.");
    }).pipe(Effect.provide(layer));
  });

  it.live("stream-json output: emits a structured success", () => {
    const { layer, out, workdir } = setup({ format: "stream-json" });
    seedProjectRef(workdir, VALID_REF);
    return Effect.gen(function* () {
      yield* unlink();
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ project_ref: VALID_REF });
    }).pipe(Effect.provide(layer));
  });
});
