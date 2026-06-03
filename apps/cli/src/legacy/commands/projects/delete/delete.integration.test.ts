import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { V1ListAllProjectsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  type LegacyApiResponse,
  type LegacyHttpMethod,
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import { legacyProjectsDelete } from "./delete.handler.ts";

const OTHER_REF = "qrstuvwxyzabcdefghij";

const DELETED = { id: 1, ref: LEGACY_VALID_REF, name: "alpha" };

const SAMPLE_PROJECT: (typeof V1ListAllProjectsOutput.Type)[number] = {
  id: LEGACY_VALID_REF,
  ref: LEGACY_VALID_REF,
  organization_id: "org-123",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: "db.alpha.supabase.co",
    version: "15.1",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

const tempRoot = useLegacyTempWorkdir("supabase-projects-delete-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly stdinIsTty?: boolean;
  readonly yes?: boolean;
  readonly byMethod?: Partial<Record<LegacyHttpMethod, LegacyApiResponse>>;
  readonly network?: "fail";
  readonly promptConfirmResponses?: ReadonlyArray<boolean>;
  readonly promptSelectResponses?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.promptConfirmResponses,
    promptSelectResponses: opts.promptSelectResponses,
  });
  const api = mockLegacyPlatformApi({
    network: opts.network,
    byMethod: opts.byMethod ?? { DELETE: { status: 200, body: DELETED } },
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current, projectId: Option.none() });
  const tty = mockTty({
    stdinIsTty: opts.stdinIsTty ?? false,
    stdoutIsTty: opts.stdinIsTty ?? false,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    buildLegacyTestRuntime({
      out,
      api,
      cliConfig,
      tty,
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
    }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );
  return { layer, out, api, telemetry, cache };
}

function writeRefFile(content: string) {
  const tempDir = join(tempRoot.current, "supabase", ".temp");
  mkdirSync(tempDir, { recursive: true });
  writeFileSync(join(tempDir, "project-ref"), content);
}

function hasMethod(
  api: { requests: ReadonlyArray<{ method: string }> },
  method: LegacyHttpMethod,
): boolean {
  return api.requests.some((r) => r.method === method);
}

describe("legacy projects delete integration", () => {
  it.live("deletes a project by positional ref after confirmation", () => {
    const { layer, out, api } = setup({ stdinIsTty: true, promptConfirmResponses: [true] });
    return Effect.gen(function* () {
      yield* legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) });
      expect(hasMethod(api, "DELETE")).toBe(true);
      expect(out.stdoutText).toContain("Deleted project: alpha");
    }).pipe(Effect.provide(layer));
  });

  it.live("respects --yes and skips the confirmation prompt", () => {
    const { layer, out, api } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) });
      expect(out.stderrText).toContain("[y/N] y");
      expect(hasMethod(api, "DELETE")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("cancels without deleting when the user declines confirmation", () => {
    const { layer, api } = setup({ stdinIsTty: true, promptConfirmResponses: [false] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectsDeleteCancelledError");
      }
      expect(hasMethod(api, "DELETE")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("prompts to select a project when no ref is given on a TTY", () => {
    const { layer, api } = setup({
      stdinIsTty: true,
      promptSelectResponses: [LEGACY_VALID_REF],
      byMethod: {
        GET: { status: 200, body: [SAMPLE_PROJECT] },
        DELETE: { status: 200, body: DELETED },
      },
    });
    return Effect.gen(function* () {
      yield* legacyProjectsDelete({ ref: Option.none() });
      expect(api.requests.find((r) => r.method === "DELETE")?.url).toContain(
        `/v1/projects/${LEGACY_VALID_REF}`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when no ref is given on a non-TTY", () => {
    const { layer, cache } = setup({ stdinIsTty: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsDelete({ ref: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectsDeleteRefRequiredError");
      }
      // No ref resolved → no linked-project cache write.
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("cancels on a non-TTY when a ref is provided but --yes is unset", () => {
    const { layer, api } = setup({ stdinIsTty: false, yes: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectsDeleteCancelledError");
      }
      expect(hasMethod(api, "DELETE")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result for --output-format stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", yes: true });
    return Effect.gen(function* () {
      yield* legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Deleted project");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on an invalid project-ref format", () => {
    const { layer } = setup({ yes: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsDelete({ ref: Option.some("BADREF") }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("removes the linked supabase/.temp dir when the deleted ref matches", () => {
    writeRefFile(LEGACY_VALID_REF);
    const { layer } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) });
      expect(existsSync(join(tempRoot.current, "supabase", ".temp"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("leaves the linked dir intact when the deleted ref differs", () => {
    writeRefFile(OTHER_REF);
    const { layer } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) });
      expect(existsSync(join(tempRoot.current, "supabase", ".temp", "project-ref"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("maps HTTP 404 to project-does-not-exist", () => {
    const { layer } = setup({ yes: true, byMethod: { DELETE: { status: 404, body: {} } } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectsDeleteNotFoundError");
        expect(json).toContain(`Project does not exist:${LEGACY_VALID_REF}`);
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("maps HTTP 503 to delete-failed", () => {
    const { layer } = setup({ yes: true, byMethod: { DELETE: { status: 503, body: {} } } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectsDeleteUnexpectedStatusError");
        expect(json).toContain(`Failed to delete project ${LEGACY_VALID_REF}`);
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsDeleteNetworkError on transport failure", () => {
    const { layer } = setup({ yes: true, network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectsDeleteNetworkError");
        expect(json).toContain("failed to delete project");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format json", () => {
    const { layer, out } = setup({ format: "json", yes: true });
    return Effect.gen(function* () {
      yield* legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Deleted project");
      expect(success?.data).toMatchObject({ name: "alpha" });
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setup({ yes: true });
    return Effect.gen(function* () {
      yield* legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry even when the delete fails", () => {
    const { layer, telemetry } = setup({ yes: true, network: "fail" });
    return Effect.gen(function* () {
      yield* Effect.exit(legacyProjectsDelete({ ref: Option.some(LEGACY_VALID_REF) }));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
