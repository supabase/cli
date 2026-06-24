import { Effect, FileSystem, Option, Path, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "../../../auth/legacy-credentials.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyTelemetryOutputFormat } from "../../../telemetry/legacy-telemetry-output-format.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import {
  LegacyAgentFlag,
  LegacyDnsResolverFlag,
  LegacyOutputFlag,
} from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { Random } from "../../../../shared/runtime/random.service.ts";
import { Stdin } from "../../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../../shared/telemetry/ai-tool.service.ts";
import type { LegacyDbQueryFlags } from "./query.command.ts";
import { LEGACY_RLS_CHECK_SQL, legacyBuildRlsAdvisory } from "./query.advisory.ts";
import {
  LegacyDbQueryExecError,
  LegacyDbQueryLoginRequiredError,
  LegacyDbQueryMutuallyExclusiveFlagsError,
  LegacyDbQueryNoSqlError,
  LegacyDbQueryNoStdinSqlError,
  LegacyDbQueryReadFileError,
  LegacyDbQueryUnexpectedStatusError,
} from "./query.errors.ts";
import {
  type LegacyAdvisory,
  legacyCoerceLocalJsonRows,
  legacyFindNonFiniteJsonValue,
  legacyFormatLinkedValue,
  legacyMakeLocalCellFormatter,
  legacyOrderedKeys,
  legacyRenderJson,
  legacyRenderTablewriter,
  legacyResolveAgentMode,
  legacyToCsv,
} from "./query.format.ts";

/** The output formats `db query` selects, mirroring Go's `json|table|csv` enum. */
type LegacyResolvedFormat = "json" | "table" | "csv";

// Go's `utils.ErrMissingToken` (`apps/cli-go/internal/utils/access_token.go:18`).
const MISSING_TOKEN_MESSAGE =
  "Access token not provided. Supply an access token by running `supabase login` or setting the SUPABASE_ACCESS_TOKEN environment variable.";

const BOUNDARY_BYTES = 16;

export const legacyDbQuery = Effect.fn("legacy.db.query")(function* (flags: LegacyDbQueryFlags) {
  const output = yield* Output;
  const telemetryState = yield* LegacyTelemetryState;
  const telemetryOutputFormat = yield* LegacyTelemetryOutputFormat;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  // Go records `flags.ProjectRef` during the linked pre-run (`LoadProjectRef`),
  // before `NewDbConfigWithPassword`'s DB resolution and before `RunE`'s
  // `ResolveSQL` (`flags/db_url.go:88`). `Execute()` then calls
  // `ensureProjectGroupsCached` after the command returns on success AND failure
  // (`cmd/root.go:176`, ahead of the error panic at `:185`), gated on
  // `flags.ProjectRef != ""`. So the linked-project cache must refresh even when a
  // later step (DB resolution, missing `--file`, no-stdin SQL) fails. Captured in the
  // linked preflight; the finalizer on the whole handler body reads it. Declared at
  // handler scope so it is visible to both the preflight and the `.pipe` finalizer.
  let linkedRefForCache: string | undefined;
  const stdin = yield* Stdin;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliConfig = yield* LegacyCliConfig;
  const random = yield* Random;
  const agentFlag = yield* LegacyAgentFlag;
  const outputFlag = yield* LegacyOutputFlag;
  const aiTool = yield* AiTool;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const dnsResolver = yield* LegacyDnsResolverFlag;

  // Emit the resolved payload (json/table/csv) to stdout in every output format —
  // Go has no `--output-format` for `db query`, so there is no machine envelope.
  // Mirrors Go's `formatOutput` (`internal/db/query/query.go:161-170`): the CSV
  // and table writers ignore agent mode / the advisory; only JSON carries the
  // agent envelope.
  const emit = (
    format: LegacyResolvedFormat,
    cols: ReadonlyArray<string>,
    data: ReadonlyArray<ReadonlyArray<unknown>>,
    agentMode: boolean,
    advisory: Option.Option<LegacyAdvisory>,
    // The linked path passes `legacyFormatLinkedValue` (JSON-decoded `float64` cells
    // → Go's `%v`/`%g`); the local path passes an OID-aware formatter (`float4`/`float8`
    // → `%g`, ints plain). JSON output re-marshals the raw values either way.
    formatCell?: (value: unknown, columnIndex: number) => string,
    // Local-path column OIDs: lets JSON output coerce int8/bigint string cells to
    // bare numbers (Go's pgx int64 scan). Omitted on the linked path (raw JSON values).
    fieldTypeIds?: ReadonlyArray<number>,
  ) =>
    Effect.gen(function* () {
      if (format === "table") {
        return yield* output.raw(legacyRenderTablewriter(cols, data, formatCell));
      }
      if (format === "csv") {
        return yield* output.raw(legacyToCsv(cols, data, formatCell));
      }
      // Go's `json.Encoder` fails on NaN/±Inf (empty stdout, exit 1); mirror that
      // instead of letting `JSON.stringify` emit `null`. Checked before any output.
      const nonFinite = legacyFindNonFiniteJsonValue(data);
      if (nonFinite !== undefined) {
        return yield* Effect.fail(
          new LegacyDbQueryExecError({
            message: `failed to encode JSON: json: unsupported value: ${nonFinite}`,
          }),
        );
      }
      const jsonData =
        fieldTypeIds === undefined ? data : legacyCoerceLocalJsonRows(data, fieldTypeIds);
      const boundary = agentMode ? yield* random.randomHex(BOUNDARY_BYTES) : "";
      yield* output.raw(legacyRenderJson(cols, jsonData, agentMode, boundary, advisory));
    });

  const runLocal = (
    target: { readonly conn: LegacyPgConnInput; readonly isLocal: boolean },
    sql: string,
    format: LegacyResolvedFormat,
    agentMode: boolean,
  ) => {
    const { conn, isLocal } = target;
    return Effect.scoped(
      Effect.gen(function* () {
        yield* output.raw(`Connecting to ${isLocal ? "local" : "remote"} database...\n`, "stderr");
        const session = yield* dbConn.connect(conn, { isLocal, dnsResolver });

        const result = yield* session
          .queryRaw(sql)
          .pipe(Effect.mapError((cause) => new LegacyDbQueryExecError({ message: cause.message })));

        // DDL/DML statements expose no columns → print the command tag.
        if (result.fields.length === 0) {
          return yield* output.raw(`${result.commandTag}\n`);
        }

        // Agent mode runs a best-effort RLS advisory check (only rendered in JSON).
        const advisory = agentMode
          ? yield* session.queryRaw(LEGACY_RLS_CHECK_SQL).pipe(
              Effect.map((rls) =>
                legacyBuildRlsAdvisory(rls.rows.map((row) => String(row[0] ?? ""))),
              ),
              Effect.orElseSucceed(() => Option.none<LegacyAdvisory>()),
            )
          : Option.none<LegacyAdvisory>();

        yield* emit(
          format,
          result.fields,
          result.rows,
          agentMode,
          advisory,
          legacyMakeLocalCellFormatter(result.fieldTypeIds ?? []),
          result.fieldTypeIds ?? [],
        );
      }),
    );
  };

  const runLinked = (
    sql: string,
    format: LegacyResolvedFormat,
    agentMode: boolean,
    ref: string,
    token: Redacted.Redacted<string>,
  ) =>
    Effect.gen(function* () {
      const cliConfig = yield* LegacyCliConfig;
      const httpClient = yield* HttpClient.HttpClient;

      const request = HttpClientRequest.post(
        `${cliConfig.apiUrl}/v1/projects/${ref}/database/query`,
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${Redacted.value(token)}`),
        HttpClientRequest.setHeader("User-Agent", cliConfig.userAgent),
        HttpClientRequest.bodyJsonUnsafe({ query: sql }),
      );
      const { status, body } = yield* Effect.gen(function* () {
        const response = yield* httpClient.execute(request);
        const text = yield* response.text;
        return { status: response.status, body: text };
      }).pipe(
        Effect.mapError(
          (cause) => new LegacyDbQueryExecError({ message: `failed to execute query: ${cause}` }),
        ),
      );
      if (status !== 201) {
        return yield* Effect.fail(
          new LegacyDbQueryUnexpectedStatusError({
            message: `unexpected status ${status}: ${body}`,
          }),
        );
      }

      // The API returns a JSON array of row objects for SELECT, or a plain command
      // tag for DDL/DML. Anything that is not a JSON array of objects is printed
      // verbatim (Go's `json.Unmarshal` into `[]map` fails → raw body).
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
      const orderedCols = legacyOrderedKeys(body);
      const cols = orderedCols.length > 0 ? [...orderedCols] : Object.keys(rows[0] ?? {});
      const data = rows.map((row) => cols.map((col) => row?.[col] ?? null));
      yield* emit(format, cols, data, agentMode, Option.none(), legacyFormatLinkedValue);
    });

  yield* Effect.gen(function* () {
    // 0. cobra `MarkFlagsMutuallyExclusive("db-url", "linked", "local")`
    //    (`apps/cli-go/cmd/db.go:526`) runs before RunE, so reject conflicting
    //    targets before resolving any SQL. "Set" follows cobra's `Changed`: an
    //    Option is set when `Some`, a boolean when explicitly `true`.
    const exclusive: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) exclusive.push("db-url");
    if (Option.isSome(flags.linked)) exclusive.push("linked");
    if (Option.isSome(flags.local)) exclusive.push("local");
    if (exclusive.length > 1) {
      return yield* Effect.fail(
        new LegacyDbQueryMutuallyExclusiveFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
        }),
      );
    }

    // PreRun parity: for --linked, Go checks the access token and loads the project
    // ref BEFORE RunE's ResolveSQL (`cmd/db.go`), so a missing `--file` or a blocking
    // stdin pipe must not mask the expected login / not-linked error. Run that
    // preflight here, before resolving SQL.
    let linkedAuth: { readonly token: Redacted.Redacted<string>; readonly ref: string } | undefined;
    if (Option.isSome(flags.linked)) {
      const credentials = yield* LegacyCredentials;
      const projectRef = yield* LegacyProjectRefResolver;
      // Order mirrors cobra: the root `PersistentPreRunE` runs `ParseDatabaseConfig`
      // (`cmd/root.go:118`) BEFORE the query command's own `PreRunE` token check
      // (`cmd/db.go:300-308`). So resolve the ref + DB config FIRST, and only then
      // check the token — otherwise an unlinked-project / invalid-config / IPv6 /
      // pooler / login-role failure is masked behind a generic "supabase login" error.
      //
      // 1. `LoadProjectRef` (flag → env → ref file): the HARD, non-prompting loader
      //    Go's `db query --linked` PreRun uses (`cmd/db.go:307`). It validates the
      //    ref format and fails with `ErrNotLinked` when absent — and, crucially,
      //    surfaces `failed to load project ref` on a real (non-not-exist) ref-file
      //    read error rather than masking it as not-linked (the soft `resolveOptional`
      //    swallows that to None; `cmd/utils/flags/project_ref.go:70-75`).
      const ref = yield* projectRef.loadProjectRef(Option.none());
      // Record the ref now (Go's `LoadProjectRef` sets `flags.ProjectRef` here),
      // so the linked-project cache finalizer fires even if the DB resolution or
      // token check below fails.
      linkedRefForCache = ref;
      // 2. `NewDbConfigWithPassword`: loads + validates the remote-merged config and
      //    resolves the live DB connection (TCP probe, pooler fallback, temp login-role
      //    mint), any of which can fail early. The token is read lazily here only when a
      //    login role must be minted (matching Go), so this stays before the token-only
      //    check. The linked query itself uses the Management API, so the resolved
      //    connection is discarded — this runs purely for Go's pre-run failures.
      yield* resolver.resolve({ dbUrl: Option.none(), connType: "linked", dnsResolver });
      // 3. Command `PreRunE` token check (`cmd/db.go:303`): Go still requires a token
      //    for the Management API query even when config resolved without minting a
      //    login role (e.g. a direct `DB_PASSWORD` was set), so keep this — but after
      //    the config/ref resolution above. Go's `LoadAccessTokenFS` validates the
      //    RESOLVED token (env → keyring → file alike) against `sbp_...` and fails with
      //    `ErrInvalidToken` before any API request (`internal/utils/access_token.go:
      //    24-33`). `credentials.getAccessToken` already applies that env-precedence +
      //    `sbp_` validation on every source, so route through it rather than accepting
      //    the env `SUPABASE_ACCESS_TOKEN` on presence alone — an invalid env token must
      //    fail here, not surface an `unexpected status` from `/database/query`.
      const tokenOpt = yield* credentials.getAccessToken;
      if (Option.isNone(tokenOpt)) {
        return yield* Effect.fail(
          new LegacyDbQueryLoginRequiredError({
            message: MISSING_TOKEN_MESSAGE,
            suggestion: "Run supabase login first.",
          }),
        );
      }
      linkedAuth = { token: tokenOpt.value, ref };
    }

    // PreRun parity (non-linked): Go's root `ParseDatabaseConfig` parses the `--db-url`
    // connection string and loads local config (`cmd/root.go:118`, `flags/db_url.go`)
    // BEFORE the query `RunE` calls `ResolveSQL`. So resolve the direct connection
    // target here — before reading `--file`/stdin — so a bad `--db-url` or config error
    // surfaces ahead of a missing-file error or a blocking stdin read. The actual socket
    // connect still happens later in `runLocal` (Go connects in `RunLocal`).
    const localTarget =
      linkedAuth === undefined
        ? yield* resolver.resolve({
            dbUrl: flags.dbUrl,
            // This branch is the non-linked path (linkedAuth handles `--linked`),
            // so the target is `--db-url` or local.
            connType: Option.isSome(flags.dbUrl) ? "db-url" : "local",
            dnsResolver,
          })
        : undefined;

    // 1. Resolve SQL: --file > positional arg > piped stdin.
    const sql = yield* Effect.gen(function* () {
      if (Option.isSome(flags.file)) {
        // Go chdir's into the workdir before ResolveSQL reads --file
        // (`cmd/root.go:104`), so a relative path resolves against the workdir, not
        // the original cwd. `path.resolve` leaves absolute paths unchanged.
        const filePath = path.resolve(cliConfig.workdir, flags.file.value);
        return yield* fs.readFileString(filePath).pipe(
          Effect.mapError(
            (cause) =>
              new LegacyDbQueryReadFileError({
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
            new LegacyDbQueryNoStdinSqlError({ message: "no SQL provided via stdin" }),
          );
        }
        return piped.value;
      }
      return yield* Effect.fail(
        new LegacyDbQueryNoSqlError({
          message: "no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin",
        }),
      );
    });

    // 2. Agent mode + the resolved payload format, mirroring Go's resolution
    //    (`cmd/db.go:316-325`): an explicit `-o json|table|csv` always wins;
    //    otherwise default to JSON for agents and a table for humans. The global
    //    `-o` choice is a union (see `query.command.ts`), so values outside Go's
    //    `json|table|csv` enum (`pretty|yaml|toml|env`) fall through to the
    //    agent-mode default rather than erroring.
    const agentMode = legacyResolveAgentMode(agentFlag, aiTool.name);
    const explicit = Option.getOrUndefined(outputFlag);
    const format: LegacyResolvedFormat =
      explicit === "json"
        ? "json"
        : explicit === "csv"
          ? "csv"
          : explicit === "table"
            ? "table"
            : agentMode
              ? "json"
              : "table";

    // Mirror Go's `db query`, which mirrors the resolved local `-o` (json|table|csv)
    // onto the global the telemetry event reads (`cmd/db.go:316-328`). Without this
    // the instrumentation reports `table`/human-default as `text`.
    yield* telemetryOutputFormat.set(format);

    // 3. Linked → Management API (raw HTTP); local / --db-url → direct connection.
    // The --linked token/ref preflight already ran above (Go's PreRun order).
    if (linkedAuth !== undefined) {
      return yield* runLinked(sql, format, agentMode, linkedAuth.ref, linkedAuth.token);
    }
    if (localTarget === undefined) {
      // Unreachable: the non-linked branch always resolves a target above.
      return yield* Effect.die(new Error("db query: connection target was not resolved"));
    }
    return yield* runLocal(localTarget, sql, format, agentMode);
  }).pipe(
    // Mirror Go's `ensureProjectGroupsCached` PersistentPostRun
    // (`apps/cli-go/cmd/root.go:176,214-234`): once a project ref is resolved, write
    // the linked-project cache (`GET /v1/projects/{ref}` →
    // `supabase/.temp/linked-project.json`) whether the query succeeds or fails — and
    // even when it fails before `runLinked` (DB resolution, missing `--file`, no-stdin
    // SQL). The cache layer no-ops when the file already exists, the token is missing,
    // or the GET is non-200. Only the linked path sets `linkedRefForCache`, so
    // `--local` / `--db-url` never trigger this (Go gates on `flags.ProjectRef != ""`).
    Effect.ensuring(
      Effect.suspend(() =>
        linkedRefForCache !== undefined ? linkedProjectCache.cache(linkedRefForCache) : Effect.void,
      ),
    ),
    Effect.ensuring(telemetryState.flush),
  );
});
