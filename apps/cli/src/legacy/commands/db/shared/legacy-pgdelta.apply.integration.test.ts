import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer } from "effect";

import { LegacyDebugFlag } from "../../../../shared/legacy/global-flags.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  type LegacyEdgeRuntimeRunResult,
  LegacyEdgeRuntimeScript,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import { legacyApplyDeclarativePgDelta } from "./legacy-pgdelta.apply.ts";
import type { LegacyPgDeltaContext } from "./legacy-pgdelta.ts";

const CTX: LegacyPgDeltaContext = {
  projectId: "ref",
  cwd: "/proj",
  npmVersion: undefined,
  denoVersion: 2,
};

function fakeEdgeRuntime(outcome: { stdout?: string; stderr?: string; fail?: string } = {}) {
  const calls: Array<LegacyEdgeRuntimeRunOpts> = [];
  const layer = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (opts: LegacyEdgeRuntimeRunOpts) => {
      calls.push(opts);
      if (outcome.fail !== undefined) {
        return Effect.fail(new LegacyEdgeRuntimeScriptError({ message: outcome.fail }));
      }
      return Effect.succeed({
        stdout: outcome.stdout ?? "",
        stderr: outcome.stderr ?? "",
      } satisfies LegacyEdgeRuntimeRunResult);
    },
  });
  return { layer, calls };
}

function makeDeclarativeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "legacy-pgdelta-apply-"));
  mkdirSync(join(dir, "declarative"), { recursive: true });
  writeFileSync(join(dir, "declarative", "public.sql"), "create table t ();");
  return join(dir, "declarative");
}

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("legacyApplyDeclarativePgDelta", () => {
  it.effect("fails with LegacyDeclarativeApplyError when the declarative dir doesn't exist", () => {
    const edge = fakeEdgeRuntime();
    const out = mockOutput();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
        fs,
        declarativeDirAbs: "/does/not/exist",
        target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
      }).pipe(Effect.exit);
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
      expect((failError(exit) as { message: string }).message).toContain(
        "declarative schema directory not found",
      );
      // Never even reaches the edge-runtime — the exists() check runs first.
      expect(edge.calls).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          edge.layer,
          out.layer,
          Layer.succeed(LegacyDebugFlag, false),
        ),
      ),
    );
  });

  it.effect("maps an edge-runtime failure to LegacyDeclarativeApplyError", () => {
    const dir = makeDeclarativeDir();
    const edge = fakeEdgeRuntime({ fail: "error running pg-delta script: boom" });
    const out = mockOutput();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
        fs,
        declarativeDirAbs: dir,
        target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
      }).pipe(Effect.exit);
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
      expect((failError(exit) as { message: string }).message).toBe(
        "error running pg-delta script: boom",
      );
      rmSync(dir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          edge.layer,
          out.layer,
          Layer.succeed(LegacyDebugFlag, false),
        ),
      ),
    );
  });

  it.effect("fails with a parse error WITHOUT the raw stdout when --debug is unset", () => {
    const dir = makeDeclarativeDir();
    const edge = fakeEdgeRuntime({ stdout: "not json{" });
    const out = mockOutput();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
        fs,
        declarativeDirAbs: dir,
        target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
      }).pipe(Effect.exit);
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
      const message = (failError(exit) as { message: string }).message;
      expect(message).toContain("failed to parse pg-delta apply output");
      expect(message).not.toContain("stdout:");
      expect(message).not.toContain("not json{");
      rmSync(dir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          edge.layer,
          out.layer,
          Layer.succeed(LegacyDebugFlag, false),
        ),
      ),
    );
  });

  it.effect("fails with a parse error INCLUDING the raw stdout when --debug is set", () => {
    const dir = makeDeclarativeDir();
    const edge = fakeEdgeRuntime({ stdout: "not json{" });
    const out = mockOutput();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
        fs,
        declarativeDirAbs: dir,
        target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
      }).pipe(Effect.exit);
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
      const message = (failError(exit) as { message: string }).message;
      expect(message).toContain("failed to parse pg-delta apply output");
      expect(message).toContain("stdout: not json{");
      rmSync(dir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          edge.layer,
          out.layer,
          Layer.succeed(LegacyDebugFlag, true),
        ),
      ),
    );
  });

  it.effect(
    "fails with LegacyDeclarativeApplyError (not an unhandled defect) when stdout is syntactically valid but non-object JSON",
    () => {
      // A configured or future pg-delta version emitting `null`/an array is valid JSON, so a
      // bare `JSON.parse(...) as LegacyPgDeltaApplyResult` cast would let `parsed.status` throw
      // an unhandled TypeError instead of failing typed.
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({ stdout: "null" });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
        expect((failError(exit) as { message: string }).message).toContain(
          "failed to parse pg-delta apply output",
        );
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
          ),
        ),
      );
    },
  );

  it.effect("fails with LegacyDeclarativeApplyError when stdout is a JSON array", () => {
    const dir = makeDeclarativeDir();
    const edge = fakeEdgeRuntime({ stdout: "[1,2,3]" });
    const out = mockOutput();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
        fs,
        declarativeDirAbs: dir,
        target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
      expect((failError(exit) as { message: string }).message).toContain(
        "failed to parse pg-delta apply output",
      );
      rmSync(dir, { recursive: true, force: true });
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          BunServices.layer,
          edge.layer,
          out.layer,
          Layer.succeed(LegacyDebugFlag, false),
        ),
      ),
    );
  });

  it.effect(
    "fails with LegacyDeclarativeApplyError (not an unhandled defect) when a field typed as an array arrives as an object",
    () => {
      // A configured or future pg-delta emitting `{"status":"error","errors":{"length":1}}` must
      // not reach `legacyFormatApplyFailure`'s `for (const issue of errors)`, which would throw an
      // unhandled TypeError on a non-iterable object — Go's `json.Unmarshal` rejects this the same
      // way, since `Errors` is declared `[]ApplyIssue` (`apps/cli-go/internal/pgdelta/apply.go:33`).
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({
        stdout: JSON.stringify({ status: "error", errors: { length: 1 } }),
      });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
        expect((failError(exit) as { message: string }).message).toContain(
          "failed to parse pg-delta apply output",
        );
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
          ),
        ),
      );
    },
  );

  it.effect(
    "fails with LegacyDeclarativeApplyError (not treated as a false success) when an errors array element is a number",
    () => {
      // A configured or future pg-delta emitting `{"status":"success","errors":[123]}` must not
      // be accepted as a successful apply. Verified against Go's real `ApplyIssue.UnmarshalJSON`
      // (`apps/cli-go/internal/pgdelta/apply.go:124-142`): a numeric element fails BOTH its
      // string-arm and its object-arm unmarshal, which fails the WHOLE `ApplyResult` decode —
      // Go never reaches a "success" status in this case, so the TS guard must reject it too.
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({
        stdout: JSON.stringify({ status: "success", errors: [123] }),
      });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
        expect((failError(exit) as { message: string }).message).toContain(
          "failed to parse pg-delta apply output",
        );
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
          ),
        ),
      );
    },
  );

  it.effect(
    "fails with LegacyDeclarativeApplyError (not treated as a false success) when a diagnostics array element is a bare string",
    () => {
      // Unlike `ApplyIssue`, Go's `ApplyDiagnosis.UnmarshalJSON` (`apply.go:79-116`) has no
      // bare-string acceptance branch, so `{"diagnostics":["boom"]}` fails Go's whole decode too
      // (verified: unmarshaling a JSON string into `ApplyDiagnosis`'s shadow struct errors).
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({
        stdout: JSON.stringify({ status: "success", diagnostics: ["boom"] }),
      });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
        expect((failError(exit) as { message: string }).message).toContain(
          "failed to parse pg-delta apply output",
        );
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
          ),
        ),
      );
    },
  );

  it.effect(
    "accepts a diagnostics element whose statementId is a mistyped, non-object/non-string value (Go degrades it silently)",
    () => {
      // Unlike a top-level array-element shape mismatch, Go's `ApplyDiagnosis.UnmarshalJSON`
      // decodes `statementId` into a `json.RawMessage` first (accepts ANY valid JSON value), then
      // tries `ApplyStatementLocation`, then a bare string, and silently leaves `StatementID` nil
      // if BOTH fail — never propagating an error. A mistyped `statementId` must NOT fail the
      // whole parse.
      const dir = makeDeclarativeDir();
      const payload = {
        status: "success",
        diagnostics: [{ message: "note", statementId: 42 }],
      };
      const edge = fakeEdgeRuntime({ stdout: JSON.stringify(payload) });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        }).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
          ),
        ),
      );
    },
  );

  it.effect(
    "fails with LegacyDeclarativeApplyError (not an unhandled defect) when a field typed as a number arrives as a string",
    () => {
      // Same reasoning as the array-typed-field test above, for `ApplyResult`'s numeric fields
      // (`TotalApplied int`, etc.) — a malformed counter must fail the parse, not be silently
      // treated as a genuine successful-apply summary.
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({
        stdout: JSON.stringify({ status: "success", totalApplied: "5" }),
      });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
        expect((failError(exit) as { message: string }).message).toContain(
          "failed to parse pg-delta apply output",
        );
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
          ),
        ),
      );
    },
  );

  it.effect(
    "on a non-success status, prints the formatted failure to stderr but not the raw payload when --debug is unset",
    () => {
      const dir = makeDeclarativeDir();
      const payload = {
        status: "error",
        totalApplied: 0,
        totalRounds: 1,
        totalSkipped: 0,
        errors: ["boom"],
      };
      const edge = fakeEdgeRuntime({ stdout: JSON.stringify(payload) });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exit = yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        }).pipe(Effect.exit);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
        expect((failError(exit) as { message: string }).message).toBe(
          "pg-delta declarative apply failed with status: error",
        );
        expect(out.stderrText).toContain('pg-delta apply returned status "error".');
        expect(out.stderrText).toContain("- boom");
        expect(out.stderrText).not.toContain("pg-delta apply result:");
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
          ),
        ),
      );
    },
  );

  it.effect(
    "on a non-success status with --debug set, additionally dumps the pretty-printed raw payload",
    () => {
      const dir = makeDeclarativeDir();
      const payload = {
        status: "error",
        totalApplied: 0,
        totalRounds: 1,
        totalSkipped: 0,
        errors: ["boom"],
      };
      const edge = fakeEdgeRuntime({ stdout: JSON.stringify(payload) });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        }).pipe(Effect.exit);
        expect(out.stderrText).toContain("pg-delta apply result:");
        expect(out.stderrText).toContain(JSON.stringify(payload, null, 2));
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, true),
          ),
        ),
      );
    },
  );

  it.effect(
    "on success, prints the applied-statements summary and forwards SCHEMA_PATH/TARGET/binds",
    () => {
      const dir = makeDeclarativeDir();
      const payload = {
        status: "success",
        totalStatements: 3,
        totalApplied: 3,
        totalRounds: 2,
        totalSkipped: 0,
      };
      const edge = fakeEdgeRuntime({ stdout: JSON.stringify(payload) });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* legacyApplyDeclarativePgDelta(CTX, {
          fs,
          declarativeDirAbs: dir,
          target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        });
        expect(out.stderrText).toContain("Applying declarative schemas via pg-delta...");
        expect(out.stderrText).toContain("Applied 3 statements in 2 round(s).");
        const opts = edge.calls[0]!;
        expect(opts.env["SCHEMA_PATH"]).toBe("/declarative");
        expect(opts.env["TARGET"]).toBe(
          "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
        );
        expect(opts.binds).toEqual([
          "supabase_edge_runtime_ref:/root/.cache/deno:rw",
          `${dir}:/declarative:ro`,
        ]);
        expect(opts.errPrefix).toBe("error running pg-delta script");
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
          ),
        ),
      );
    },
  );
});
