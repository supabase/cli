import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput } from "../../../../../../../tests/helpers/mocks.ts";
import {
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyDebugFlag,
  LegacyExperimentalFlag,
} from "../../../../../../shared/legacy/global-flags.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyDeclarativeSeam } from "../../../shared/legacy-pgdelta.seam.service.ts";
import type { LegacyDbSchemaDeclarativeApplyFlags } from "./apply.command.ts";
import { legacyDbSchemaDeclarativeApply } from "./apply.handler.ts";

const APPLY_SUCCESS_JSON = JSON.stringify({
  status: "success",
  totalStatements: 2,
  totalRounds: 1,
  totalApplied: 2,
  totalSkipped: 0,
  errors: [],
  stuckStatements: [],
  validationErrors: [],
  diagnostics: [],
});

const APPLY_ERROR_JSON = JSON.stringify({
  status: "error",
  totalStatements: 2,
  totalRounds: 1,
  totalApplied: 1,
  totalSkipped: 0,
  errors: [{ message: "boom" }],
  stuckStatements: [],
  validationErrors: [],
  diagnostics: [{ message: "diagnostic" }],
});

interface SetupOpts {
  experimental?: boolean;
  debug?: boolean;
  applyJson?: string;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput();
  const telemetry = mockLegacyTelemetryStateTracked();
  const edgeCalls: LegacyEdgeRuntimeRunOpts[] = [];
  const edge = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (runOpts: LegacyEdgeRuntimeRunOpts) =>
      Effect.sync(() => {
        edgeCalls.push(runOpts);
        return { stdout: opts.applyJson ?? APPLY_SUCCESS_JSON, stderr: "" };
      }),
  });
  let ensureStartedCalls = 0;
  const seam = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: () => Effect.die("exportCatalog not used in declarative apply tests"),
    execInherit: () => Effect.die("execInherit not used in declarative apply tests"),
    ensureLocalDatabaseStarted: () =>
      Effect.sync(() => {
        ensureStartedCalls += 1;
      }),
    provisionShadow: () => Effect.die("provisionShadow not used in declarative apply tests"),
    removeShadowContainer: () => Effect.void,
  });
  const layer = Layer.mergeAll(
    out.layer,
    edge,
    seam,
    telemetry.layer,
    mockLegacyCliConfig({ workdir, projectId: Option.some("test") }),
    Layer.succeed(LegacyExperimentalFlag, opts.experimental ?? true),
    Layer.succeed(LegacyDebugFlag, opts.debug ?? false),
    BunServices.layer,
  );
  return {
    layer,
    out,
    telemetry,
    edgeCalls,
    get ensureStartedCalls() {
      return ensureStartedCalls;
    },
  };
}

const flags = (
  over: Partial<LegacyDbSchemaDeclarativeApplyFlags> = {},
): LegacyDbSchemaDeclarativeApplyFlags => ({
  noCache: over.noCache ?? false,
});

const seedDeclarative = (workdir: string) => {
  const dir = join(workdir, "supabase", "database");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "public.sql"), "create table players ();");
};

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("legacy db schema declarative apply integration", () => {
  const tmp = useLegacyTempWorkdir();

  it.effect("gate: fails when pg-delta is not enabled", () => {
    seedDeclarative(tmp.current);
    const { layer } = setup(tmp.current, { experimental: false });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeApply(flags()));
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeNotEnabledError");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when there are no declarative files", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeApply(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect((failError(exit) as { message: string }).message).toContain(
        "no declarative schema found",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("applies declarative files directly to the local database", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current);
    return Effect.gen(function* () {
      yield* legacyDbSchemaDeclarativeApply(flags());

      expect(s.ensureStartedCalls).toBe(1);
      expect(s.edgeCalls).toHaveLength(1);
      const call = s.edgeCalls[0]!;
      expect(call.env["SCHEMA_PATH"]).toBe("/declarative");
      expect(call.env["TARGET"]).toContain("postgresql://postgres:postgres@127.0.0.1:54322");
      expect(call.binds).toContain(`${join(tmp.current, "supabase", "database")}:/declarative:ro`);
      expect(existsSync(join(tmp.current, "supabase", "migrations"))).toBe(false);
      expect(s.out.stderrText).toContain("Applying declarative schemas via pg-delta");
      expect(s.out.stderrText).toContain("Applied 2 statements in 1 round(s).");
      expect(s.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });

  it.effect("surfaces unsuccessful pg-delta apply results", () => {
    seedDeclarative(tmp.current);
    const s = setup(tmp.current, { applyJson: APPLY_ERROR_JSON });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbSchemaDeclarativeApply(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)).toMatchObject({
        _tag: "LegacyDeclarativeApplyError",
        message: "pg-delta declarative apply failed with status: error",
      });
      expect(s.out.stderrText).toContain('pg-delta apply returned status "error"');
      expect(s.out.stderrText).toContain("1 pg-topo diagnostic(s) omitted");
      expect(s.telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(s.layer));
  });
});
