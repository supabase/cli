import { operationDefinitions } from "@supabase/api/effect";
import { Effect, FileSystem, Option, Path, Ref } from "effect";
import * as HttpClientError from "effect/http/HttpClientError";

import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { TelemetryOutputFormat } from "../../../telemetry/telemetry-output-format.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  ResolvedDbConfig,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import {
  sanitizeErrorBody,
  unexpectedStatusMessage,
} from "../../../command-internal/http-errors.ts";
import { DbConnection, type DbSession } from "../../../command-internal/db-connection.service.ts";
import { AgentFlag, DnsResolverFlag, OutputFlag } from "../../../command-internal/global-flags.ts";
import {
  hostedMutationPreapproval,
  requireTargetMutationConsent,
} from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../shared/telemetry/ai-tool.service.ts";
import type { DbQueryFlags } from "./query.command.ts";
import { RLS_CHECK_SQL, buildRlsAdvisory } from "./query.advisory.ts";
import { findReadOnlyViolation, READ_ONLY_STATEMENT_KEYWORDS } from "./query.read-only.ts";
import {
  DbQueryExecError,
  DbQueryLoginRequiredError,
  DbQueryNoSqlError,
  DbQueryNoStdinSqlError,
  DbQueryReadFileError,
  DbQueryReadOnlyStatementError,
  DbQuerySqlSourceConflictError,
  DbQueryUnexpectedStatusError,
} from "./query.errors.ts";
import {
  type Advisory,
  makeLocalCellFormatter,
  type QueryFormat,
  resolveQueryFormat,
  sqlPreview,
} from "../../../command-internal/db/query.format.ts";
import {
  emitManagementApiRows,
  emitQueryResult,
} from "../../../command-internal/db/query-output.ts";
import { resolveAgentMode } from "../../../command-internal/agent-mode.ts";

// Established output contract for a missing access token.
const MISSING_TOKEN_MESSAGE =
  "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.";

const toExecError = (cause: { readonly message: string }) =>
  new DbQueryExecError({ message: cause.message });

const READ_ONLY_LOCK_TIMEOUT = "5s";

// `queryRaw` runs every statement on one dedicated connection, so BEGIN/ROLLBACK issued through
// it bracket the user's statement. The lock timeout keeps a read from queuing behind heavy locks.
const inReadOnlyTransaction = <A, E, R>(session: DbSession, body: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    session.queryRaw("BEGIN READ ONLY").pipe(Effect.mapError(toExecError)),
    () =>
      session
        .queryRaw(`SET LOCAL lock_timeout = '${READ_ONLY_LOCK_TIMEOUT}'`)
        .pipe(Effect.mapError(toExecError), Effect.andThen(body)),
    () => session.queryRaw("ROLLBACK").pipe(Effect.ignore),
  );

type QueryRoute =
  | { readonly kind: "linked"; readonly ref: string }
  | { readonly kind: "direct"; readonly connection: ResolvedDbConnection };

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
  const agentFlag = yield* AgentFlag;
  const outputFlag = yield* OutputFlag;
  const aiTool = yield* AiTool;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;
  const dnsResolver = yield* DnsResolverFlag;

  const encodeError = (message: string) => new DbQueryExecError({ message });

  const runLocal = (
    target: Pick<ResolvedDbConfig, "conn" | "isLocal" | "exposedSchemas">,
    sql: string,
    format: QueryFormat,
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
        const schemas = target.exposedSchemas;
        const advisory =
          agentMode && schemas !== undefined && schemas.length > 0
            ? yield* session.query(RLS_CHECK_SQL, [schemas]).pipe(
                Effect.map((rows) =>
                  buildRlsAdvisory(rows.map((row) => String(row["table_name"] ?? ""))),
                ),
                Effect.orElseSucceed(() => Option.none<Advisory>()),
              )
            : Option.none<Advisory>();

        yield* emitQueryResult({
          encodeError,
          format,
          cols: result.fields,
          data: result.rows,
          agentMode,
          advisory,
          formatCell: makeLocalCellFormatter(result.fieldTypeIds ?? []),
          fieldTypeIds: result.fieldTypeIds ?? [],
        });
      }),
    );
  };

  const runLinked = (
    sql: string,
    format: QueryFormat,
    agentMode: boolean,
    ref: string,
    readOnly: boolean,
  ) =>
    Effect.gen(function* () {
      const apiFactory = yield* CommandPlatformApiFactory;
      const api = yield* apiFactory.make;

      // `v1RunAQuery` declares no response body, so `executeRaw` keeps the row JSON text intact
      // (column order, number formatting) for rendering.
      const response = yield* api
        .executeRaw(
          operationDefinitions.v1RunAQuery,
          { ref, query: sql, ...(readOnly ? { read_only: true } : {}) },
          { retry: { requestTimeoutMs: Number.POSITIVE_INFINITY } },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new DbQueryExecError({
                message: `failed to execute query: ${cause}`,
                transport: HttpClientError.isHttpClientError(cause),
              }),
          ),
        );
      const body = yield* response.text.pipe(
        Effect.mapError(
          (cause) =>
            new DbQueryExecError({ message: `failed to execute query: ${cause}`, transport: true }),
        ),
      );
      if (response.status !== 201) {
        return yield* new DbQueryUnexpectedStatusError({
          status: response.status,
          message: unexpectedStatusMessage(response.status, sanitizeErrorBody(body)),
        });
      }

      yield* emitManagementApiRows(body, format, agentMode, encodeError);
    });

  yield* Effect.gen(function* () {
    // Checked before the target resolves: `--file` would silently override the positional SQL,
    // which is how `-f x.sql --remote <branch>` would otherwise target the linked project.
    if (Option.isSome(flags.file) && Option.isSome(flags.sql)) {
      const bareRemote = Option.exists(flags.remote, (remote) => remote._tag === "Linked");
      return yield* new DbQuerySqlSourceConflictError({
        message: "Pass SQL as an argument or with --file, not both.",
        ...(bareRemote
          ? { suggestion: "To select a branch or project with --remote, write --remote=<value>." }
          : {}),
      });
    }
    const target = yield* resolveTarget(flags);
    // Recorded now so the cache finalizer still fires if a later step fails.
    if (target.kind === "linked") yield* Ref.set(linkedRefForCache, target.ref);

    // Resolved before `--file`/stdin are read, so a bad `--db-url`, an invalid merged config, a
    // connection failure or a missing login surfaces ahead of a missing-file error. A linked query
    // goes through the Management API and never opens a database connection.
    const route: QueryRoute = yield* Effect.gen(function* () {
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
        return { kind: "linked", ref: target.ref } satisfies QueryRoute;
      }
      const connection = yield* resolver.resolveConnection({
        target,
        dnsResolver,
        password: Option.none(),
        networkBanRemoval: yield* hostedMutationPreapproval,
      });
      return { kind: "direct", connection } satisfies QueryRoute;
    });

    // 1. Resolve SQL: --file or the positional arg (never both), else piped stdin.
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

    // 2. Resolve the payload format; see `resolveQueryFormat`.
    const agentMode = resolveAgentMode(agentFlag, aiTool.name);
    const format = resolveQueryFormat(Option.getOrUndefined(outputFlag), output.format, agentMode);

    // Mirrors the resolved format onto the global telemetry reads, or instrumentation would
    // report the table/human default as `text`.
    yield* telemetryOutputFormat.set(format);
    yield* Effect.annotateCurrentSpan({
      "db.conn_type": target.kind,
      "query.format": format,
      "query.agent_mode": agentMode,
      "query.read_only": flags.readOnly,
    });

    // `--read-only` skips consent only because the statement cannot write, so anything but a read
    // statement is refused before anything connects or prompts.
    if (flags.readOnly) {
      const violation = findReadOnlyViolation(sql);
      if (violation !== undefined) {
        return yield* new DbQueryReadOnlyStatementError({
          message: `--read-only only allows ${READ_ONLY_STATEMENT_KEYWORDS.join(", ")} statements (found: ${violation})`,
          suggestion:
            "Drop --read-only to run this statement; a hosted database then asks you to confirm the write.",
        });
      }
    }

    // 3. A hosted statement may write, so it needs consent unless `--read-only` confines it.
    if (!flags.readOnly) {
      yield* requireTargetMutationConsent(route.kind === "direct" ? route.connection : target, {
        action: "Run a SQL statement",
        readOnlyAlternative: true,
        details: [`sql: ${sqlPreview(sql)}`],
      });
    }

    // 4. Linked queries go through the Management API; local/--db-url connect directly.
    if (route.kind === "linked") {
      return yield* runLinked(sql, format, agentMode, route.ref, flags.readOnly).pipe(
        Effect.withSpan("db.query.runLinked"),
      );
    }
    return yield* runLocal(route.connection, sql, format, agentMode, flags.readOnly).pipe(
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
