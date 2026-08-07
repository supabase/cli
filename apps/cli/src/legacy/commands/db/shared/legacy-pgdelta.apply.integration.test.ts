import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDebugFlag } from "../../../../shared/legacy/global-flags.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  type LegacyEdgeRuntimeRunOpts,
  type LegacyEdgeRuntimeRunResult,
  LegacyEdgeRuntimeScript,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import { legacyApplyDeclarativePgDelta } from "./legacy-pgdelta.apply.ts";
import type { LegacyPgDeltaContext } from "../../../shared/legacy-pgdelta.ts";

const CTX: LegacyPgDeltaContext = {
  projectId: "ref",
  cwd: "/proj",
  npmVersion: undefined,
  denoVersion: 2,
  projectEnv: {},
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
          Layer.succeed(CliArgs, { args: [] }),
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
          Layer.succeed(CliArgs, { args: [] }),
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
          Layer.succeed(CliArgs, { args: [] }),
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
          Layer.succeed(CliArgs, { args: [] }),
        ),
      ),
    );
  });

  it.effect(
    "fails with a parse error INCLUDING the raw stdout when SUPABASE_DEBUG is set only in the project .env",
    () => {
      // Go's `Config.Load` -> `loadNestedEnv` `os.Setenv`s the project `supabase/.env` into the
      // process before `pgdelta.ApplyDeclarative` ever reads `viper.GetBool("DEBUG")`
      // (review: PRRT_kwDOErm0O86XL_oz) — so a `SUPABASE_DEBUG` set only in `supabase/.env`,
      // never in the shell or via `--debug`, still surfaces the raw stdout. Delete any shell
      // `SUPABASE_DEBUG` first: shell *presence* (even `false`) would otherwise suppress the
      // project value entirely, per `legacyViperEnvBoolWithProjectFallback`'s own semantics.
      const previous = process.env["SUPABASE_DEBUG"];
      delete process.env["SUPABASE_DEBUG"];
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({ stdout: "not json{" });
      const out = mockOutput();
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const exit = yield* legacyApplyDeclarativePgDelta(
          { ...CTX, projectEnv: { SUPABASE_DEBUG: "true" } },
          {
            fs,
            declarativeDirAbs: dir,
            target: "postgresql://postgres:postgres@127.0.0.1:54320/contrib_regression",
          },
        ).pipe(Effect.exit);
        expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeApplyError");
        const message = (failError(exit) as { message: string }).message;
        expect(message).toContain("failed to parse pg-delta apply output");
        expect(message).toContain("stdout: not json{");
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env["SUPABASE_DEBUG"];
            else process.env["SUPABASE_DEBUG"] = previous;
          }),
        ),
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );

  it.effect(
    "fails with a normal status-failure summary (not a parse error) when stdout is a top-level JSON null",
    () => {
      // Go's `json.Unmarshal([]byte("null"), &result)` into the zero-valued (non-pointer)
      // `ApplyResult` struct is a no-op that returns no error (verified empirically) — Go falls
      // through to the normal `result.Status != "success"` branch and prints the usual
      // failed-apply summary with every counter at its zero value, rather than treating `null`
      // as a parse failure. `legacyApplyDeclarativePgDelta` must normalize `null` to `{}` before
      // its own structural guard, matching that behavior (review: PRRT_kwDOErm0O86W8ZYo).
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
        expect((failError(exit) as { message: string }).message).toBe(
          "pg-delta declarative apply failed with status: ",
        );
        expect((failError(exit) as { message: string }).message).not.toContain(
          "failed to parse pg-delta apply output",
        );
        expect(out.stderrText).toContain('pg-delta apply returned status "".');
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );

  it.effect(
    "fails with LegacyDeclarativeApplyError (not an unhandled defect) when stdout is syntactically valid but non-object, non-null JSON",
    () => {
      // Unlike `null` (see the sibling test above), Go's `json.Unmarshal` genuinely rejects an
      // array/string/number/bool payload for a struct destination with an UnmarshalTypeError —
      // so a bare `JSON.parse(...) as LegacyPgDeltaApplyResult` cast would let `parsed.status`
      // throw an unhandled TypeError instead of failing typed.
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({ stdout: "42" });
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
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
          Layer.succeed(CliArgs, { args: [] }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );

  it.effect(
    "drops a diagnostics element's statementId when a nested field is mistyped, instead of rendering a bogus location (Go's nil fallback)",
    () => {
      // Unlike the mistyped-non-object/non-string `statementId` case above, this reproduces a
      // mistyped FIELD INSIDE an otherwise object-shaped `statementId`
      // (`{"filePath":123,...}`). Go's `(d *ApplyDiagnosis) UnmarshalJSON` (`apply.go:100-115`)
      // tries the `ApplyStatementLocation` object shape first — the mistyped `filePath` fails
      // that decode — then falls back to a bare string, which ALSO fails (it's an object, not a
      // string) — so Go silently leaves `StatementID` nil rather than erroring the whole parse,
      // verified empirically. Rendering the raw object anyway would show a bogus `(123#1)`
      // location Go never emits.
      const dir = makeDeclarativeDir();
      const payload = {
        status: "success",
        diagnostics: [{ message: "note", statementId: { filePath: 123, statementIndex: 1 } }],
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );

  it.effect(
    "accepts a null scalar field on an errors/diagnostics element and formats it as absent (Go's encoding/json leaves the zero value)",
    () => {
      // `ApplyIssue`'s non-`Statement` fields (`Code`/`Message`/`IsDependencyError`/`Position`/
      // `Detail`/`Hint`) and `ApplyDiagnosis`'s (`Code`/`Message`/`SuggestedFix`) are all plain,
      // non-pointer Go types decoded via the default `encoding/json` — verified empirically that
      // a JSON `null` for a non-pointer struct field produces NO error and leaves the zero value,
      // so `{"errors":[{"message":null}]}` is a valid, Go-accepted payload, not a parse failure.
      // The formatter's existing `String(issue.message ?? "")` already renders a zero-value
      // message as "unknown pg-delta issue" once the guard lets the `null` through.
      const dir = makeDeclarativeDir();
      const payload = {
        status: "error",
        totalApplied: 0,
        totalRounds: 1,
        totalSkipped: 0,
        errors: [{ message: null, code: null, isDependencyError: null, position: null }],
        diagnostics: [{ message: null, code: null, suggestedFix: null }],
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
        expect(out.stderrText).toContain("- unknown pg-delta issue");
        expect(out.stderrText).toContain("- unknown pg-delta diagnostic");
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, true),
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );

  it.effect(
    "accepts a null top-level counter and formats it as zero (Go's encoding/json leaves the zero value)",
    () => {
      // `ApplyResult` has no custom `UnmarshalJSON` of its own, so its plain, non-pointer `int`
      // counters (`TotalStatements`/`TotalRounds`/`TotalApplied`/`TotalSkipped`) decode via the
      // default `encoding/json` — verified empirically that a JSON `null` for a non-pointer `int`
      // field produces NO error and leaves the zero value, so
      // `{"status":"success","totalApplied":null}` is a valid, Go-accepted payload, not a parse
      // failure — same "null means absent" rule already applied to nested issue/diagnostic
      // scalar fields above.
      const dir = makeDeclarativeDir();
      const payload = { status: "success", totalApplied: null, totalRounds: null };
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
        expect(out.stderrText).toContain("Applied 0 statements in 0 round(s).");
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );

  it.effect(
    "accepts an absent or null top-level status and formats it as the empty-string zero value (Go's encoding/json)",
    () => {
      // `ApplyResult.Status` has no custom `UnmarshalJSON` of its own, so it's a plain,
      // non-pointer `string` field decoded via the default `encoding/json` — verified
      // empirically that `{}` and `{"status":null}` both decode with `err == nil` and
      // `Status == ""`, reaching the normal failed-apply summary (not a parse failure).
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({ stdout: JSON.stringify({}) });
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
        expect((failError(exit) as { message: string }).message).toBe(
          "pg-delta declarative apply failed with status: ",
        );
        expect(out.stderrText).toContain('pg-delta apply returned status "".');
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );

  it.effect(
    "accepts a null errors/stuckStatements/validationErrors/diagnostics array and treats it as empty (Go's encoding/json leaves a nil slice)",
    () => {
      // `ApplyResult`'s array fields have no custom `UnmarshalJSON` of their own, so Go's
      // `encoding/json` accepts a JSON `null` for a `[]T` slice field with no error, leaving a
      // nil (zero-length) slice — verified empirically:
      // `json.Unmarshal([]byte(\`{"status":"error","errors":null}\`), &r)` returns `err == nil`
      // with `len(r.Errors) == 0`. A payload reporting all four as `null` must format as if none
      // were reported at all, not fail the parse.
      const dir = makeDeclarativeDir();
      const payload = {
        status: "error",
        totalApplied: 0,
        totalRounds: 1,
        totalSkipped: 0,
        errors: null,
        stuckStatements: null,
        validationErrors: null,
        diagnostics: null,
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
        expect(out.stderrText).toContain("No per-statement diagnostics were reported by pg-delta.");
        rmSync(dir, { recursive: true, force: true });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            BunServices.layer,
            edge.layer,
            out.layer,
            Layer.succeed(LegacyDebugFlag, false),
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );

  it.effect(
    "fails with LegacyDeclarativeApplyError (not an unhandled defect) when a field typed as an int arrives as a fractional number",
    () => {
      // Go's `TotalApplied int` (and its `int`-typed siblings) reject any JSON number literal
      // with a decimal point via `strconv.ParseInt` on the raw literal text — verified
      // empirically that `json.Unmarshal` on `{"totalApplied":1.5}` errors identically to a
      // string-typed field mismatch, so `1.5` must fail the parse here too, not be treated as a
      // truncated/rounded successful-apply count.
      const dir = makeDeclarativeDir();
      const edge = fakeEdgeRuntime({
        stdout: JSON.stringify({ status: "success", totalApplied: 1.5 }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
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
            Layer.succeed(CliArgs, { args: [] }),
            Layer.succeed(CliArgs, { args: [] }),
          ),
        ),
      );
    },
  );
});
