import {
  DateTime,
  Effect,
  FileSystem,
  Option,
  Path,
  Predicate,
  Redacted,
  Ref,
  Schema,
} from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { TelemetryOutputFormat } from "../../../telemetry/telemetry-output-format.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import {
  DbConnection,
  type DbSession,
  type PgConnInput,
} from "../../../command-internal/db-connection.service.ts";
import { AgentFlag, DnsResolverFlag, OutputFlag } from "../../../command-internal/global-flags.ts";
import {
  hostedMutationPreapproval,
  requireTargetMutationConsent,
} from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Random } from "../../../shared/runtime/random.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../shared/telemetry/ai-tool.service.ts";
import type { DbQueryFlags } from "./query.command.ts";
import { RLS_CHECK_SQL, buildRlsAdvisory } from "./query.advisory.ts";
import { findReadOnlyViolation } from "./query.read-only.ts";
import {
  DbQueryExecError,
  DbQueryLoginRequiredError,
  DbQueryNoSqlError,
  DbQueryNoStdinSqlError,
  DbQueryReadFileError,
  DbQueryReadOnlyStatementError,
  DbQueryUnexpectedStatusError,
} from "./query.errors.ts";
import {
  type Advisory,
  coerceLocalJsonRows,
  findNonFiniteJsonValue,
  formatLinkedValue,
  makeLocalCellFormatter,
  orderedKeys,
  renderJson,
  renderTablewriter,
  toCsv,
} from "./query.format.ts";
import { resolveAgentMode } from "../../../command-internal/agent-mode.ts";

/** The output formats `db query` selects: `json|table|csv`. */
type ResolvedFormat = "json" | "table" | "csv";

// Established output contract for a missing access token.
const MISSING_TOKEN_MESSAGE =
  "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.";

const BOUNDARY_BYTES = 16;

const SQL_PREVIEW_LENGTH = 120;

const sqlPreview = (sql: string): string => {
  const oneLine = sql.replaceAll(/\s+/gu, " ").trim();
  return oneLine.length > SQL_PREVIEW_LENGTH
    ? `${oneLine.slice(0, SQL_PREVIEW_LENGTH)}...`
    : oneLine;
};

const decodeJsonBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const isRowObject = (element: unknown): element is { readonly [key: string]: unknown } | null =>
  element === null || Predicate.isObject(element);

const toExecError = (cause: { readonly message: string }) =>
  new DbQueryExecError({ message: cause.message });

// `queryRaw` runs every statement on one dedicated connection, so BEGIN/ROLLBACK issued through
// it bracket the user's statement.
const inReadOnlyTransaction = <A, E, R>(session: DbSession, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    session.queryRaw("BEGIN READ ONLY").pipe(Effect.mapError(toExecError)),
    () => body,
    () => session.queryRaw("ROLLBACK").pipe(Effect.ignore),
  );

export const dbQuery = Effect.fn("db.query")(function* (flags: DbQueryFlags) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const telemetryOutputFormat = yield* TelemetryOutputFormat;
  const linkedProjectCache = yield* LinkedProjectCache;
  // Set only when the linked preflight resolves a ref, so the `Effect.ensuring` finalizer at the
  // end of this handler can refresh the linked-project cache even if a later step fails.
  const linkedRefForCache = yield* Ref.make<string | undefined>(undefined);
  const stdin = yield* Stdin;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliSettings = yield* CommandSettings;
  const random = yield* Random;
  const agentFlag = yield* AgentFlag;
  const outputFlag = yield* OutputFlag;
  const aiTool = yield* AiTool;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;
  const dnsResolver = yield* DnsResolverFlag;

  // Writes the resolved payload (json/table/csv) to stdout. There's no `--output-format` for
  // `db query`, so CSV/table ignore agent mode and only JSON carries the agent envelope.
  const emit = (
    format: ResolvedFormat,
    cols: ReadonlyArray<string>,
    data: ReadonlyArray<ReadonlyArray<unknown>>,
    agentMode: boolean,
    advisory: Option.Option<Advisory>,
    // `formatLinkedValue` for the linked path, an OID-aware formatter for local; only used for
    // table/CSV cells since JSON output re-marshals the raw values.
    formatCell?: (value: unknown, columnIndex: number) => string,
    // Local-path column OIDs, used to coerce int8/bigint JSON cells to bare numbers; omitted on
    // the linked path (already raw JSON values).
    fieldTypeIds?: ReadonlyArray<number>,
  ) =>
    Effect.gen(function* () {
      if (format === "table") {
        return yield* output.raw(renderTablewriter(cols, data, formatCell));
      }
      if (format === "csv") {
        return yield* output.raw(toCsv(cols, data, formatCell));
      }
      // The established JSON encoding fails on NaN/±Inf (empty stdout, exit 1); mirror that
      // instead of letting `JSON.stringify` silently emit `null`.
      const nonFinite = findNonFiniteJsonValue(data);
      if (nonFinite !== undefined) {
        return yield* new DbQueryExecError({
          message: `failed to encode JSON: json: unsupported value: ${nonFinite}`,
        });
      }
      const jsonData = fieldTypeIds === undefined ? data : coerceLocalJsonRows(data, fieldTypeIds);
      const boundary = agentMode ? yield* random.randomHex(BOUNDARY_BYTES) : "";
      const rendered = renderJson(cols, jsonData, agentMode, boundary, advisory);
      if (output.format === "stream-json" && Option.getOrUndefined(outputFlag) !== "json") {
        const compactRendered = rendered.trimEnd().replaceAll("\n", "");
        yield* output.raw(
          `{"type":"result","data":${compactRendered},"timestamp":"${DateTime.formatIso(yield* DateTime.now)}"}\n`,
        );
        return;
      }
      yield* output.raw(rendered);
    });

  const runLocal = (
    target: { readonly conn: PgConnInput; readonly isLocal: boolean },
    sql: string,
    format: ResolvedFormat,
    agentMode: boolean,
    readOnly: boolean,
  ) => {
    const { conn, isLocal } = target;
    return Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(conn, { isLocal, dnsResolver });

        const execute = session.queryRaw(sql).pipe(Effect.mapError(toExecError));
        const result = yield* readOnly ? inReadOnlyTransaction(session, execute) : execute;

        yield* Effect.annotateCurrentSpan({
          "query.row_count": result.rows.length,
          "query.column_count": result.fields.length,
        });
        // DDL/DML statements expose no columns → print the command tag.
        if (result.fields.length === 0) {
          return yield* output.raw(`${result.commandTag}\n`);
        }

        // Agent mode runs a best-effort RLS advisory check (only rendered in JSON).
        const advisory = agentMode
          ? yield* session.queryRaw(RLS_CHECK_SQL).pipe(
              Effect.map((rls) => buildRlsAdvisory(rls.rows.map((row) => String(row[0] ?? "")))),
              Effect.orElseSucceed(() => Option.none<Advisory>()),
            )
          : Option.none<Advisory>();

        yield* emit(
          format,
          result.fields,
          result.rows,
          agentMode,
          advisory,
          makeLocalCellFormatter(result.fieldTypeIds ?? []),
          result.fieldTypeIds ?? [],
        );
      }),
    );
  };

  const runLinked = (
    sql: string,
    format: ResolvedFormat,
    agentMode: boolean,
    ref: string,
    token: Redacted.Redacted<string>,
    readOnly: boolean,
  ) =>
    Effect.gen(function* () {
      const cliSettings = yield* CommandSettings;
      const httpClient = yield* HttpClient.HttpClient;

      const request = HttpClientRequest.post(
        `${cliSettings.apiUrl}/v1/projects/${ref}/database/query`,
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(token)}`),
        HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
        HttpClientRequest.bodyJsonUnsafe({ query: sql, ...(readOnly ? { read_only: true } : {}) }),
      );
      const { status, body } = yield* Effect.gen(function* () {
        const response = yield* httpClient.execute(request);
        const text = yield* response.text;
        return { status: response.status, body: text };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new DbQueryExecError({
              message: `failed to execute query: ${cause}`,
              transport: true,
            }),
        ),
      );
      if (status !== 201) {
        return yield* new DbQueryUnexpectedStatusError({
          status,
          message: `unexpected status ${status}: ${body}`,
        });
      }

      // The API returns a JSON array of row objects for SELECT, or a plain command tag for
      // DDL/DML; anything else is printed verbatim.
      const decoded = yield* decodeJsonBody(body).pipe(Effect.option);
      if (Option.isNone(decoded)) {
        return yield* output.raw(`${body}\n`);
      }
      const rows = decoded.value;
      if (!Array.isArray(rows) || !rows.every(isRowObject)) {
        return yield* output.raw(`${body}\n`);
      }
      yield* Effect.annotateCurrentSpan("query.row_count", rows.length);
      if (rows.length === 0) {
        return yield* emit(format, [], [], agentMode, Option.none());
      }
      const orderedCols = orderedKeys(body);
      const cols = orderedCols.length > 0 ? [...orderedCols] : Object.keys(rows[0] ?? {});
      const data = rows.map((row) => cols.map((col) => row?.[col] ?? null));
      yield* emit(format, cols, data, agentMode, Option.none(), formatLinkedValue);
    });

  yield* Effect.gen(function* () {
    const target = yield* resolveTarget({
      local: flags.local,
      linked: flags.linked,
      dbUrl: flags.dbUrl,
      projectRef: flags.projectRef,
    });
    // Recorded now so the cache finalizer still fires if a later step fails.
    if (target.kind === "linked") yield* Ref.set(linkedRefForCache, target.ref);

    // Resolved before the token check and before `--file`/stdin are read, so a bad `--db-url`, an
    // invalid merged config or a connection failure surfaces ahead of a login or missing-file
    // error. A linked query goes through the Management API, so that resolved connection only
    // serves those early failures and is otherwise discarded.
    const connection = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: Option.none(),
      networkBanRemoval: yield* hostedMutationPreapproval,
    });

    let linkedAuth: { readonly token: Redacted.Redacted<string>; readonly ref: string } | undefined;
    if (target.kind === "linked") {
      const credentials = yield* CommandCredentials;
      // Routed through `credentials.getAccessToken`, which validates the `sbp_...` shape, rather
      // than trusting env presence alone and surfacing a confusing status error later.
      const tokenOpt = yield* credentials.getAccessToken;
      if (Option.isNone(tokenOpt)) {
        return yield* new DbQueryLoginRequiredError({
          message: MISSING_TOKEN_MESSAGE,
          suggestion: "Run supabase login first.",
        });
      }
      linkedAuth = { token: tokenOpt.value, ref: target.ref };
    }

    // 1. Resolve SQL: --file > positional arg > piped stdin.
    const sql = yield* Effect.gen(function* () {
      if (Option.isSome(flags.file)) {
        // A relative `--file` path resolves against the workdir, not the
        // original cwd. `path.resolve` leaves absolute paths unchanged.
        const filePath = path.resolve(cliSettings.workdir, flags.file.value);
        return yield* fs.readFileString(filePath).pipe(
          Effect.mapError(
            (cause) =>
              new DbQueryReadFileError({
                message: `failed to read SQL file: ${cause.message}`,
              }),
          ),
        );
      }
      if (Option.isSome(flags.sql)) {
        return flags.sql.value;
      }
      if (!stdin.isTTY) {
        const piped = yield* stdin.readPipedText;
        if (Option.isNone(piped)) {
          return yield* new DbQueryNoStdinSqlError({ message: "no SQL provided via stdin" });
        }
        return piped.value;
      }
      return yield* new DbQueryNoSqlError({
        message: "no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin",
      });
    });

    // 2. Resolve the payload format: an explicit `-o json|table|csv` always wins; otherwise
    //    default to JSON for agents, table for humans. Any other `-o` value (from the global
    //    union, e.g. `pretty|yaml|toml|env`) falls through to that default rather than erroring.
    const agentMode = resolveAgentMode(agentFlag, aiTool.name);
    const explicit = Option.getOrUndefined(outputFlag);
    const format: ResolvedFormat =
      explicit === "json"
        ? "json"
        : explicit === "csv"
          ? "csv"
          : explicit === "table" || explicit === "pretty"
            ? "table"
            : explicit === undefined && (output.format !== "text" || agentMode)
              ? "json"
              : "table";

    // Mirrors the resolved format onto the global telemetry reads, or instrumentation would
    // report the table/human default as `text`.
    yield* telemetryOutputFormat.set(format);
    yield* Effect.annotateCurrentSpan({
      "db.conn_type": target.kind,
      "query.format": format,
      "query.agent_mode": agentMode,
      "query.read_only": flags.readOnly,
    });

    // `--read-only` skips consent only because the statement cannot write, so SQL that ends the
    // transaction or flips its read-only mode is refused before anything connects or prompts.
    if (flags.readOnly) {
      const violation = findReadOnlyViolation(sql);
      if (violation !== undefined) {
        return yield* new DbQueryReadOnlyStatementError({
          message: `--read-only does not allow transaction control or read-only setting changes (found: ${violation})`,
          suggestion:
            "Drop --read-only to run this statement; a hosted database then asks you to confirm the write.",
        });
      }
    }

    // 3. A hosted statement may write, so it needs consent unless `--read-only` confines it.
    if (!flags.readOnly) {
      yield* requireTargetMutationConsent(connection, {
        action: "Run a SQL statement",
        details: [`sql: ${sqlPreview(sql)}`],
      });
    }

    // 4. Linked queries go through the Management API; local/--db-url connect directly.
    if (linkedAuth !== undefined) {
      return yield* runLinked(
        sql,
        format,
        agentMode,
        linkedAuth.ref,
        linkedAuth.token,
        flags.readOnly,
      ).pipe(Effect.withSpan("db.query.runLinked"));
    }
    return yield* runLocal(connection, sql, format, agentMode, flags.readOnly).pipe(
      Effect.withSpan("db.query.runLocal"),
    );
  }).pipe(
    // Writes the linked-project cache whenever a ref was resolved, whether the query succeeds or
    // fails — `linkedRefForCache` is only set on the linked path, so `--local`/`--db-url` never
    // trigger this.
    Effect.ensuring(
      Effect.flatMap(Ref.get(linkedRefForCache), (ref) =>
        ref !== undefined ? linkedProjectCache.cache(ref) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
