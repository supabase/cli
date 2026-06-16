import { Effect, FileSystem, Option, Path, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { LegacyCredentials } from "../../../auth/legacy-credentials.service.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  LegacyProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
  PROJECT_REF_PATTERN,
} from "../../../config/legacy-project-ref.service.ts";
import {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
} from "../../../config/legacy-project-ref.errors.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
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
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
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
  ) =>
    Effect.gen(function* () {
      if (format === "table") {
        return yield* output.raw(legacyRenderTablewriter(cols, data));
      }
      if (format === "csv") {
        return yield* output.raw(legacyToCsv(cols, data));
      }
      const boundary = agentMode ? yield* random.randomHex(BOUNDARY_BYTES) : "";
      yield* output.raw(legacyRenderJson(cols, data, agentMode, boundary, advisory));
    });

  const runLocal = (sql: string, format: LegacyResolvedFormat, agentMode: boolean) => {
    const useLocal = Option.isNone(flags.dbUrl) && !flags.linked;
    return Effect.scoped(
      Effect.gen(function* () {
        const { conn, isLocal } = yield* resolver.resolve({
          dbUrl: flags.dbUrl,
          linked: false,
          local: useLocal,
          dnsResolver,
        });
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

        yield* emit(format, result.fields, result.rows, agentMode, advisory);
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
      yield* emit(format, cols, data, agentMode, Option.none());
    });

  yield* Effect.gen(function* () {
    // 0. cobra `MarkFlagsMutuallyExclusive("db-url", "linked", "local")`
    //    (`apps/cli-go/cmd/db.go:526`) runs before RunE, so reject conflicting
    //    targets before resolving any SQL. "Set" follows cobra's `Changed`: an
    //    Option is set when `Some`, a boolean when explicitly `true`.
    const exclusive: Array<string> = [];
    if (Option.isSome(flags.dbUrl)) exclusive.push("db-url");
    if (flags.linked) exclusive.push("linked");
    if (flags.local) exclusive.push("local");
    if (exclusive.length > 1) {
      return yield* Effect.fail(
        new LegacyDbQueryMutuallyExclusiveFlagsError({
          message: `if any flags in the group [db-url linked local] are set none of the others can be; [${exclusive.join(" ")}] were all set`,
        }),
      );
    }

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

    // 3. Linked → Management API (raw HTTP); local / --db-url → direct connection.
    if (flags.linked) {
      const cliConfig = yield* LegacyCliConfig;
      const credentials = yield* LegacyCredentials;
      const projectRef = yield* LegacyProjectRefResolver;

      // PreRunE: require a token (login) before resolving the project ref.
      const tokenOpt = Option.isSome(cliConfig.accessToken)
        ? cliConfig.accessToken
        : yield* credentials.getAccessToken;
      if (Option.isNone(tokenOpt)) {
        return yield* Effect.fail(
          new LegacyDbQueryLoginRequiredError({
            message: MISSING_TOKEN_MESSAGE,
            suggestion: "Run supabase login first.",
          }),
        );
      }
      // PreRun parity: Go's `db query --linked` calls `flags.LoadProjectRef`
      // (`apps/cli-go/cmd/db.go`), which loads flag → env → ref file and fails with
      // ErrNotLinked — it never opens the project-selection prompt. Use the
      // non-prompting `resolveOptional` so an unlinked workdir fails instead of
      // running the query against an interactively-selected project. Validate the
      // resolved ref like Go's `AssertProjectRefIsValid`.
      const refOpt = yield* projectRef.resolveOptional(Option.none());
      if (Option.isNone(refOpt)) {
        return yield* Effect.fail(
          new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }),
        );
      }
      const ref = refOpt.value;
      if (!PROJECT_REF_PATTERN.test(ref)) {
        return yield* Effect.fail(
          new LegacyInvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE }),
        );
      }

      // Mirror Go's `ensureProjectGroupsCached` PersistentPostRun
      // (`apps/cli-go/cmd/root.go:176,214-234`): once a project ref is resolved,
      // write the linked-project cache (`GET /v1/projects/{ref}` →
      // `supabase/.temp/linked-project.json`) whether the query succeeds or fails.
      // The cache layer no-ops when the file already exists, the token is missing,
      // or the GET is non-200 — so a 401 still fires the GET but writes nothing,
      // matching Go. Only the linked path resolves a ref, so `--local` / `--db-url`
      // never trigger this write (Go gates on `flags.ProjectRef != ""`).
      return yield* runLinked(sql, format, agentMode, ref, tokenOpt.value).pipe(
        Effect.ensuring(linkedProjectCache.cache(ref)),
      );
    }
    return yield* runLocal(sql, format, agentMode);
  }).pipe(Effect.ensuring(telemetryState.flush));
});
