/**
 * Port of Go's `pgdelta.ApplyDeclarative` (`apps/cli-go/internal/pgdelta/apply.go:299-360`) —
 * CLI-1956's declarative-apply runner: applies `supabase/database` (or the configured
 * declarative dir) to the shadow's `contrib_regression` override database via pg-delta's
 * declarative apply engine, run inside the edge-runtime container.
 *
 * This is genuinely NEW work, not a seam removal: the Deno script template itself
 * (`legacyPgDeltaDeclarativeApplyScript`) already existed (ported for a different, now-dead
 * seam), but nothing in TS ever invoked it — every declarative apply ran through the bundled
 * Go binary until now.
 */

import { Data, Effect, type FileSystem } from "effect";

import { LegacyDebugFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { LegacyEdgeRuntimeScript } from "../../../shared/legacy-edge-runtime-script.service.ts";
import {
  legacyInterpolatePgDeltaScript,
  legacyPgDeltaDeclarativeApplyScript,
} from "./legacy-pgdelta.deno-templates.ts";
import {
  legacyEdgeRuntimeId,
  legacyPgDeltaNpmRegistryOption,
  type LegacyPgDeltaContext,
} from "./legacy-pgdelta.ts";

const errMessage = (e: unknown): string =>
  typeof e === "object" && e !== null && "message" in e && typeof e.message === "string"
    ? e.message
    : String(e);

/** `pgdelta.ApplyDeclarative` failed — Go's own error messages at each step (see call sites below). */
export class LegacyDeclarativeApplyError extends Data.TaggedError("LegacyDeclarativeApplyError")<{
  readonly message: string;
}> {}

/** Go's `containerSchemaPath` (`apply.go:311`). */
const LEGACY_PG_DELTA_APPLY_CONTAINER_SCHEMA_PATH = "/declarative";

/** One statement/error entry — Go's `ApplyIssue`, which may arrive as a bare string or an object. */
export interface LegacyPgDeltaApplyIssue {
  readonly statement?: {
    // Optional (not required): this whole interface types an untrusted `JSON.parse` of a
    // pg-delta subprocess's stdout — `legacyApplyDeclarativePgDelta` only structurally
    // validates the top-level shape (`{status: string}`), not nested fields — so a
    // partially-populated `statement` object (e.g. a future pg-delta release that only
    // reports `id`) must render, not throw — see `legacyFormatApplyIssue`'s defensive
    // `?? ""` handling below. Go's own `(i *ApplyIssue) UnmarshalJSON` is deliberately just
    // as defensive, for the same reason.
    readonly id?: string;
    readonly sql?: string;
    readonly statementClass?: string;
  };
  readonly code?: string;
  readonly message?: string;
  readonly isDependencyError?: boolean;
  readonly position?: number;
  readonly detail?: string;
  readonly hint?: string;
}

/** Go's `ApplyStatementLocation` (pg-topo's `StatementId` shape). */
export interface LegacyPgDeltaApplyStatementLocation {
  readonly filePath?: string;
  readonly statementIndex?: number;
}

/** Go's `ApplyDiagnosis` — a pg-topo static-analysis diagnostic. */
export interface LegacyPgDeltaApplyDiagnosis {
  readonly code?: string;
  readonly message?: string;
  readonly statementId?: LegacyPgDeltaApplyStatementLocation | string;
  readonly suggestedFix?: string;
}

/** The JSON payload `pgdelta_declarative_apply.ts` prints on stdout. Go's `ApplyResult`. */
export interface LegacyPgDeltaApplyResult {
  readonly status: string;
  readonly totalStatements?: number;
  readonly totalRounds?: number;
  readonly totalApplied?: number;
  readonly totalSkipped?: number;
  readonly errors?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null>;
  readonly stuckStatements?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null>;
  readonly validationErrors?: ReadonlyArray<LegacyPgDeltaApplyIssue | string | null>;
  readonly diagnostics?: ReadonlyArray<LegacyPgDeltaApplyDiagnosis | null>;
}

/**
 * Structural guard for Go's `ApplyResult` JSON shape, applied to an untrusted
 * `JSON.parse` of the pg-delta subprocess's stdout. A syntactically valid but non-object
 * payload (`null`, an array, a bare string/number — e.g. a future pg-delta release that
 * changes its output shape) must fail typed as {@link LegacyDeclarativeApplyError}, not
 * crash `parsed.status` with an unhandled `TypeError`.
 *
 * Every field `ApplyResult` itself declares a type for is checked when present — Go's
 * `json.Unmarshal` rejects the whole payload with an `UnmarshalTypeError` the moment any of
 * these doesn't match its struct field's declared type (`Errors []ApplyIssue`, `TotalApplied
 * int`, etc., `apps/cli-go/internal/pgdelta/apply.go:27-44`), so e.g. an `errors` field that
 * arrives as an object (`{"length":1}`) instead of an array must fail here too, not reach
 * `legacyFormatApplyFailure`'s `for (const issue of errors)` and throw an unhandled
 * `TypeError` defect. Only each field's OWN declared type is checked (not the shape of
 * elements inside `errors`/`stuckStatements`/`validationErrors`/`diagnostics`) — everything
 * downstream already treats a malformed element as optional/malformed-tolerant (see this
 * module's other `String(x ?? "")` doc comments and `ApplyIssue`'s own dual string/object
 * `UnmarshalJSON`), so per-element validation stays there. This is also the AGENTS.md-mandated
 * way to narrow `unknown` without an `as` cast.
 */
function legacyIsPgDeltaApplyResult(value: unknown): value is LegacyPgDeltaApplyResult {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("status" in value) ||
    typeof value.status !== "string"
  ) {
    return false;
  }
  if ("totalStatements" in value && typeof value.totalStatements !== "number") return false;
  if ("totalRounds" in value && typeof value.totalRounds !== "number") return false;
  if ("totalApplied" in value && typeof value.totalApplied !== "number") return false;
  if ("totalSkipped" in value && typeof value.totalSkipped !== "number") return false;
  if ("errors" in value && !Array.isArray(value.errors)) return false;
  if ("stuckStatements" in value && !Array.isArray(value.stuckStatements)) return false;
  if ("validationErrors" in value && !Array.isArray(value.validationErrors)) return false;
  if ("diagnostics" in value && !Array.isArray(value.diagnostics)) return false;
  return true;
}

/** Go's `(i *ApplyIssue) UnmarshalJSON` string/object dual shape, applied post-`JSON.parse`. */
function legacyNormalizeApplyIssue(
  raw: LegacyPgDeltaApplyIssue | string | null | undefined,
): LegacyPgDeltaApplyIssue {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === "string") return { message: raw };
  return raw;
}

/** Go's `(d *ApplyDiagnosis) UnmarshalJSON` defensive `statementId` handling. */
function legacyNormalizeApplyDiagnosis(
  raw: LegacyPgDeltaApplyDiagnosis | null | undefined,
): LegacyPgDeltaApplyDiagnosis {
  if (raw === null || raw === undefined) return {};
  if (typeof raw.statementId === "string") {
    return { ...raw, statementId: { filePath: raw.statementId } };
  }
  return raw;
}

/**
 * Go's `formatStatementLocation` (`apply.go:262-275`). `String(... ?? "")` rather than a bare
 * `?? ""` before `.trim()`: `filePath` is typed as `string | undefined`, but this whole module
 * types an untrusted `JSON.parse` of subprocess output, so a malformed payload can hand this a
 * non-string value (e.g. a number) at runtime — `?? ""` alone only substitutes `null`/
 * `undefined`, so a non-string, non-nullish value would still reach `.trim()` and throw.
 */
function legacyFormatStatementLocation(
  loc: LegacyPgDeltaApplyStatementLocation | string | undefined,
): string {
  const resolved = typeof loc === "string" ? { filePath: loc } : loc;
  if (resolved === undefined) return "";
  const path = String(resolved.filePath ?? "").trim();
  if (path.length === 0) return "";
  if ((resolved.statementIndex ?? 0) > 0) return `${path}#${resolved.statementIndex}`;
  return path;
}

/** Go's `formatStatementSQL` (`apply.go:277-283`): collapse whitespace, then truncate at 120 chars. */
function legacyFormatStatementSql(sql: string): string {
  const normalized = sql
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(" ");
  const maxLen = 120;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 3)}...`;
}

/** Go's `formatDebugJSON` (`apply.go:285-294`): pretty-print if parseable, else the trimmed raw bytes. */
export function legacyFormatDebugJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

/** Go's `formatApplyIssueMessage` (`apply.go:222-238`). `String(x ?? "")` throughout — see {@link legacyFormatApplyIssue}'s own doc comment for why. */
function legacyFormatApplyIssueMessage(issue: LegacyPgDeltaApplyIssue): string {
  const trimmed = String(issue.message ?? "").trim();
  const message = trimmed.length > 0 ? trimmed : "unknown pg-delta issue";
  const metadata: Array<string> = [];
  const code = String(issue.code ?? "");
  if (code.length > 0) metadata.push(`SQLSTATE ${code}`);
  if ((issue.position ?? 0) > 0) metadata.push(`position ${issue.position}`);
  if (issue.isDependencyError === true) metadata.push("dependency error");
  if (metadata.length === 0) return message;
  return `${message} (${metadata.join(", ")})`;
}

/**
 * Go's `formatApplyIssue` (`apply.go:202-221`). Every `issue.statement.*`/`issue.*` field is
 * defaulted with `String(x ?? "")` before use — not a bare `?? ""`: a malformed subprocess
 * payload (e.g. a pg-delta release that reports `detail`/`hint`/`sql` as a number) can hand any
 * of these a non-string value, which `?? ""` alone does not catch (it only substitutes
 * `null`/`undefined`), and the very next call on several of these fields is a string-only
 * method (`.trim()`, `legacyFormatStatementSql`'s `.split()`) that throws a `TypeError` on
 * anything else — turning an actionable SQL error into an unhandled defect, the worst place for
 * a rendering bug to exist, since this only ever runs on an ALREADY-FAILED apply.
 */
function legacyFormatApplyIssue(rawIssue: LegacyPgDeltaApplyIssue | string | null): string {
  const issue = legacyNormalizeApplyIssue(rawIssue);
  if (issue.statement === undefined) return `- ${legacyFormatApplyIssueMessage(issue)}`;
  const statementClass = String(issue.statement.statementClass ?? "");
  const classSuffix = statementClass.length > 0 ? ` [${statementClass}]` : "";
  const lines: Array<string> = [
    `- ${String(issue.statement.id ?? "")}${classSuffix}`,
    `  ${legacyFormatApplyIssueMessage(issue)}`,
  ];
  const detail = String(issue.detail ?? "").trim();
  if (detail.length > 0) lines.push(`  Detail: ${detail}`);
  const hint = String(issue.hint ?? "").trim();
  if (hint.length > 0) lines.push(`  Hint: ${hint}`);
  const sql = legacyFormatStatementSql(String(issue.statement.sql ?? ""));
  if (sql.length > 0) lines.push(`  SQL: ${sql}`);
  return lines.join("\n");
}

/** Go's `formatApplyDiagnosis` (`apply.go:240-258`). `String(x ?? "")` throughout — see {@link legacyFormatApplyIssue}'s own doc comment for why. */
function legacyFormatApplyDiagnosis(rawDiagnosis: LegacyPgDeltaApplyDiagnosis | null): string {
  const diagnosis = legacyNormalizeApplyDiagnosis(rawDiagnosis);
  const trimmed = String(diagnosis.message ?? "").trim();
  const message = trimmed.length > 0 ? trimmed : "unknown pg-delta diagnostic";
  let out = "- ";
  const code = String(diagnosis.code ?? "").trim();
  if (code.length > 0) out += `[${code}] `;
  out += message;
  const loc = legacyFormatStatementLocation(diagnosis.statementId);
  if (loc.length > 0) out += ` (${loc})`;
  const fix = String(diagnosis.suggestedFix ?? "").trim();
  if (fix.length > 0) out += `\n  Suggested fix: ${fix}`;
  return out;
}

/**
 * Port of Go's `formatApplyFailure` (`apply.go:145-183`): a human-readable summary of an
 * unsuccessful pg-delta apply, rendered on failure regardless of `--debug`. `verbose`
 * (Go's `viper.GetBool("DEBUG")`) only expands pg-topo diagnostics inline — collapsed to a
 * one-line count by default since a large schema can produce hundreds of them.
 */
export function legacyFormatApplyFailure(
  result: LegacyPgDeltaApplyResult,
  verbose: boolean,
): string {
  const errors = result.errors ?? [];
  const stuckStatements = result.stuckStatements ?? [];
  const validationErrors = result.validationErrors ?? [];
  const diagnostics = result.diagnostics ?? [];

  let totalStatements = result.totalStatements ?? 0;
  if (totalStatements === 0) {
    totalStatements =
      (result.totalApplied ?? 0) + (result.totalSkipped ?? 0) + stuckStatements.length;
  }

  const lines: Array<string> = [
    `pg-delta apply returned status "${result.status}".`,
    `${result.totalApplied ?? 0}/${totalStatements} statements applied in ${
      result.totalRounds ?? 0
    } round(s); ${result.totalSkipped ?? 0} skipped.`,
  ];
  if (errors.length > 0) {
    lines.push("Errors:");
    for (const issue of errors) lines.push(legacyFormatApplyIssue(issue));
  }
  if (stuckStatements.length > 0) {
    lines.push("Stuck statements:");
    for (const issue of stuckStatements) lines.push(legacyFormatApplyIssue(issue));
  }
  if (validationErrors.length > 0) {
    lines.push("Validation errors (from check_function_bodies=on pass):");
    for (const issue of validationErrors) lines.push(legacyFormatApplyIssue(issue));
  }
  if (diagnostics.length > 0) {
    if (verbose) {
      lines.push("Diagnostics:");
      for (const diagnosis of diagnostics) lines.push(legacyFormatApplyDiagnosis(diagnosis));
    } else {
      lines.push(
        `${diagnostics.length} pg-topo diagnostic(s) omitted (re-run with --debug to view).`,
      );
    }
  }
  // pg-delta may report status "error" without populating any issue arrays (e.g. an internal
  // assertion in a future pg-delta release) — point the user at how to get more information
  // rather than leaving them with just the bare status line.
  if (errors.length === 0 && stuckStatements.length === 0 && validationErrors.length === 0) {
    lines.push(
      "No per-statement diagnostics were reported by pg-delta.",
      "Re-run with --debug to print the raw pg-delta payload, or open an issue at",
      "https://github.com/supabase/pg-toolbelt/issues with the debug bundle attached.",
    );
  }
  return lines.join("\n");
}

/**
 * Port of Go's `pgdelta.ApplyDeclarative` (`apps/cli-go/internal/pgdelta/apply.go:299-360`):
 * applies `declarativeDirAbs` to `target` (the shadow's `contrib_regression` override
 * database) via pg-delta's declarative apply engine. Unlike the diff/export/catalog scripts
 * (`legacy-pgdelta.ts`), this binds the declarative directory itself read-only at
 * `/declarative` rather than mounting the whole project at `/workspace` — Go's own
 * `ApplyDeclarative` never needs the wider project tree, only the schema files. `target` is
 * always a LOCAL shadow connection (never a remote/Supabase-hosted endpoint), so — unlike
 * `legacyDiffPgDelta`'s SOURCE/TARGET — no SSL/CA-bundle preparation applies here, matching
 * Go's own plain `"TARGET="+utils.ToPostgresURL(config)` (no TLS handling at all).
 */
export const legacyApplyDeclarativePgDelta = Effect.fnUntraced(function* (
  ctx: LegacyPgDeltaContext,
  params: {
    readonly fs: FileSystem.FileSystem;
    /** Absolute host path to the declarative schema directory. */
    readonly declarativeDirAbs: string;
    /** The shadow override database's Postgres URL. */
    readonly target: string;
  },
) {
  const exists = yield* params.fs
    .exists(params.declarativeDirAbs)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* Effect.fail(
      new LegacyDeclarativeApplyError({
        message: `declarative schema directory not found: ${params.declarativeDirAbs}`,
      }),
    );
  }

  const output = yield* Output;
  const edgeRuntime = yield* LegacyEdgeRuntimeScript;
  const debug = yield* LegacyDebugFlag;

  yield* output.raw("Applying declarative schemas via pg-delta...\n", "stderr");

  const env: Record<string, string> = {
    SCHEMA_PATH: LEGACY_PG_DELTA_APPLY_CONTAINER_SCHEMA_PATH,
    TARGET: params.target,
  };
  const binds = [
    `${legacyEdgeRuntimeId(ctx.projectId)}:/root/.cache/deno:rw`,
    `${params.declarativeDirAbs}:${LEGACY_PG_DELTA_APPLY_CONTAINER_SCHEMA_PATH}:ro`,
  ];
  const npm = legacyPgDeltaNpmRegistryOption();
  const result = yield* edgeRuntime
    .run({
      script: legacyInterpolatePgDeltaScript(legacyPgDeltaDeclarativeApplyScript, ctx.npmVersion),
      env,
      binds,
      errPrefix: "error running pg-delta script",
      extraFiles: npm.extraFiles,
      extraEnv: npm.extraEnv,
      denoVersion: ctx.denoVersion,
    })
    .pipe(Effect.mapError((cause) => new LegacyDeclarativeApplyError({ message: cause.message })));

  const parsed = yield* Effect.try({
    try: () => {
      const raw: unknown = JSON.parse(result.stdout);
      if (!legacyIsPgDeltaApplyResult(raw)) {
        throw new Error("pg-delta apply output was not a JSON object");
      }
      return raw;
    },
    catch: (cause) =>
      new LegacyDeclarativeApplyError({
        message: debug
          ? `failed to parse pg-delta apply output: ${errMessage(cause)}\nstdout: ${result.stdout}`
          : `failed to parse pg-delta apply output: ${errMessage(cause)}`,
      }),
  });

  if (parsed.status !== "success") {
    yield* output.raw(`${legacyFormatApplyFailure(parsed, debug)}\n`, "stderr");
    if (debug) {
      const debugJson = legacyFormatDebugJson(result.stdout);
      if (debugJson.length > 0) {
        yield* output.raw("pg-delta apply result:\n", "stderr");
        yield* output.raw(`${debugJson}\n`, "stderr");
      }
    }
    return yield* Effect.fail(
      new LegacyDeclarativeApplyError({
        message: `pg-delta declarative apply failed with status: ${parsed.status}`,
      }),
    );
  }
  yield* output.raw(
    `Applied ${parsed.totalApplied ?? 0} statements in ${parsed.totalRounds ?? 0} round(s).\n`,
    "stderr",
  );
});
