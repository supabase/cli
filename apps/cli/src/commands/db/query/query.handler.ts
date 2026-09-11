import { Effect, FileSystem, Option, Path, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { TelemetryOutputFormat } from "../../../telemetry/telemetry-output-format.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection, type PgConnInput } from "../../../command-internal/db-connection.service.ts";
import { AgentFlag, DnsResolverFlag, OutputFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { Random } from "../../../shared/runtime/random.service.ts";
import { Stdin } from "../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../shared/telemetry/ai-tool.service.ts";
import type { DbQueryFlags } from "./query.command.ts";
import { RLS_CHECK_SQL, buildRlsAdvisory } from "./query.advisory.ts";
import {
  DbQueryExecError,
  DbQueryLoginRequiredError,
  DbQueryMutuallyExclusiveFlagsError,
  DbQueryNoSqlError,
  DbQueryNoStdinSqlError,
  DbQueryReadFileError,
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

export const dbQuery = Effect.fn("db.query")(function* (flags: DbQueryFlags) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const telemetryOutputFormat = yield* TelemetryOutputFormat;
  const linkedProjectCache = yield* LinkedProjectCache;
  // Set only when the linked preflight resolves a ref, so the `Effect.ensuring` finalizer at the
  // end of this handler can refresh the linked-project cache even if a later step fails.
  let linkedRefForCache: string | undefined;
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
        return yield* Effect.fail(
          new DbQueryExecError({
            message: `failed to encode JSON: json: unsupported value: ${nonFinite}`,
          }),
        );
      }
      const jsonData = fieldTypeIds === undefined ? data : coerceLocalJsonRows(data, fieldTypeIds);
      const boundary = agentMode ? yield* random.randomHex(BOUNDARY_BYTES) : "";
      const rendered = renderJson(cols, jsonData, agentMode, boundary, advisory);
      if (output.format === "stream-json" && Option.getOrUndefined(outputFlag) !== "json") {
        const compactRendered = rendered.trimEnd().replaceAll("\n", "");
        yield* output.raw(
          `{"type":"result","data":${compactRendered},"timestamp":${JSON.stringify(new Date().toISOString())}}\n`,
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
  ) => {
    const { conn, isLocal } = target;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* output.raw(`Connecting to ${isLocal ? "local" : "remote"} database...\n`, "stderr");
        const session = yield* dbConn.connect(conn, { isLocal, dnsResolver });

        const result = yield* session
          .queryRaw(sql)
          .pipe(Effect.mapError((cause) => new DbQueryExecError({ message: cause.message })));

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
  ) =>
    Effect.gen(function* () {
      const cliSettings = yield* CommandSettings;
      const httpClient = yield* HttpClient.HttpClient;

      const request = HttpClientRequest.post(
        `${cliSettings.apiUrl}/v1/projects/${ref}/database/query`,
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(token)}`),
        HttpClientRequest.setHeader("User-Agent", cliSettings.userAgent),
        HttpClientRequest.bodyJsonUnsafe({ query: sql }),
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
        return yield* Effect.fail(
          new DbQueryUnexpectedStatusError({
            status,
            message: `unexpected status ${status}: ${body}`,
          }),
        );
      }

      // The API returns a JSON array of row objects for SELECT, or a plain command tag for
      // DDL/DML; anything else is printed verbatim.
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return yield* output.raw(`${body}\n`);
      }
      const isRowArray =
        Array.isArray(parsed) &&
        parsed.every(
          (element) => element === null || (typeof element === "object" && !Array.isArray(element)),
        );
      if (!isRowArray) {
        return yield* output.raw(`${body}\n`);
      }
      const rows = parsed as ReadonlyArray<Record<string, unknown> | null>;
      if (rows.length === 0) {
        return yield* emit(format, [], [], agentMode, Option.none());
      }
      const orderedCols = orderedKeys(body);
      const cols = orderedCols.length > 0 ? [...orderedCols] : Object.keys(rows[0] ?? {});
      const data = rows.map((row) => cols.map((col) => row?.[col] ?? null));
      yield* emit(format, cols, data, agentMode, Option.none(), formatLinkedValue);
    });

  yield* Effect.gen(function* () {
    // 0. The db-url/linked/local group is mutually exclusive, checked before resolving SQL.
    //    "Set" means explicitly set (Option `Some`, or boolean literally `true`).
    const exclusive: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) exclusive.push("db-url");
    if (Option.isSome(flags.linked)) exclusive.push("linked");
    if (Option.isSome(flags.local)) exclusive.push("local");
    if (exclusive.length > 1) {
      return yield* Effect.fail(
        new DbQueryMutuallyExclusiveFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
        }),
      );
    }

    // `--project-ref` only applies to the linked target; it must not be silently ignored when
    // targeting `--local`/`--db-url`.
    if (Option.isSome(flags.projectRef) && Option.isNone(flags.linked)) {
      return yield* Effect.fail(
        new DbQueryMutuallyExclusiveFlagsError({
          message:
            "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
        }),
      );
    }

    // For `--linked`, the access token is checked and the project ref is loaded before SQL is
    // resolved, so a missing `--file` or a blocking stdin pipe doesn't mask a login/not-linked
    // error.
    let linkedAuth: { readonly token: Redacted.Redacted<string>; readonly ref: string } | undefined;
    if (Option.isSome(flags.linked)) {
      const credentials = yield* CommandCredentials;
      const projectRef = yield* ProjectRefResolver;
      // Config is resolved before the token check, so an unlinked-project/invalid-config/pooler
      // failure isn't masked behind a generic "supabase login" error. `loadProjectRef` is the
      // strict loader: a real ref-file read error surfaces instead of being treated as not-linked.
      const ref = yield* projectRef.loadProjectRef(flags.projectRef);
      // Recorded now so the cache finalizer still fires if a later step fails.
      linkedRefForCache = ref;
      // Loads and validates the remote-merged config and resolves the live DB connection (TCP
      // probe, pooler fallback, temp login-role mint) purely to surface early failures — the
      // linked query itself uses the Management API, so this resolved connection is discarded.
      yield* resolver.resolve({
        dbUrl: Option.none(),
        connType: "linked",
        dnsResolver,
        linkedProjectRef: flags.projectRef,
      });
      // The Management API still needs a token even when config resolved without minting a login
      // role. Route through `credentials.getAccessToken`, which validates it against `sbp_...`,
      // rather than trusting env presence alone and surfacing a confusing status error later.
      const tokenOpt = yield* credentials.getAccessToken;
      if (Option.isNone(tokenOpt)) {
        return yield* Effect.fail(
          new DbQueryLoginRequiredError({
            message: MISSING_TOKEN_MESSAGE,
            suggestion: "Run supabase login first.",
          }),
        );
      }
      linkedAuth = { token: tokenOpt.value, ref };
    }

    // Resolves the `--db-url`/local connection target before reading `--file`/stdin, so a bad
    // `--db-url` or config error surfaces ahead of a missing-file error or a blocking stdin read.
    const localTarget =
      linkedAuth === undefined
        ? yield* resolver.resolve({
            dbUrl: flags.dbUrl,
            // linkedAuth handles `--linked`, so this branch's target is `--db-url` or local.
            connType: Option.isSome(flags.dbUrl) ? "db-url" : "local",
            dnsResolver,
          })
        : undefined;

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
          return yield* Effect.fail(
            new DbQueryNoStdinSqlError({ message: "no SQL provided via stdin" }),
          );
        }
        return piped.value;
      }
      return yield* Effect.fail(
        new DbQueryNoSqlError({
          message: "no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin",
        }),
      );
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

    // 3. Linked queries go through the Management API; local/--db-url connect directly.
    if (linkedAuth !== undefined) {
      return yield* runLinked(sql, format, agentMode, linkedAuth.ref, linkedAuth.token);
    }
    if (localTarget === undefined) {
      // Unreachable: the non-linked branch always resolves a target above.
      return yield* Effect.die(new Error("db query: connection target was not resolved"));
    }
    return yield* runLocal(localTarget, sql, format, agentMode);
  }).pipe(
    // Writes the linked-project cache whenever a ref was resolved, whether the query succeeds or
    // fails — `linkedRefForCache` is only set on the linked path, so `--local`/`--db-url` never
    // trigger this.
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined ? linkedProjectCache.cache(linkedRefForCache) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
