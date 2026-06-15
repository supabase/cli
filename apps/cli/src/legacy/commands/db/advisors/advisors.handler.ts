import { Effect, Option } from "effect";

import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import { legacyFailsOn } from "../../../shared/legacy-fail-on.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { resolveLegacyAccessToken } from "../../../shared/legacy-resolve-token.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import type { LegacyDbAdvisorsFlags } from "./advisors.command.ts";
import {
  LegacyDbAdvisorsBeginTxError,
  LegacyDbAdvisorsFailOnError,
  LegacyDbAdvisorsMutuallyExclusiveFlagsError,
  LegacyDbAdvisorsNotLoggedInError,
  LegacyDbAdvisorsQueryError,
  LegacyDbAdvisorsSetupError,
} from "./advisors.errors.ts";
import {
  encodeAdvisorLints,
  filterAdvisorLints,
  LEGACY_ADVISORS_LEVEL_ENUM,
  type LegacyAdvisorLint,
  scanAdvisorLintRow,
} from "./advisors.format.ts";
import { fetchPerformanceAdvisors, fetchSecurityAdvisors } from "./advisors.linked.ts";
import { splitLegacyLintsSql } from "./advisors.lints-sql.ts";

/** Go's `utils.ErrMissingToken` (`internal/utils/access_token.go:18`). */
const missingTokenMessage = (): string =>
  `Access token not provided. Supply an access token by running ${legacyAqua("supabase login")} or setting the SUPABASE_ACCESS_TOKEN environment variable.`;

/** Go's advisors PreRunE `utils.CmdSuggestion` (`cmd/db.go`). */
const loginSuggestion = (): string => `Run ${legacyAqua("supabase login")} first.`;

/** Go's `queryLints` body, minus the transaction the caller owns (`advisors.go:102-152`). */
const queryLints = Effect.fnUntraced(function* (session: LegacyDbSession) {
  const [setupSql, querySql] = splitLegacyLintsSql();
  yield* session.exec(setupSql).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyDbAdvisorsSetupError({
          message: `failed to prepare lint session: ${cause.message}`,
        }),
    ),
  );
  const rows = yield* session
    .query(querySql)
    .pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDbAdvisorsQueryError({ message: `failed to query lints: ${cause.message}` }),
      ),
    );
  return rows.map(scanAdvisorLintRow);
});

/** Go's `RunLocal` lint gathering (`advisors.go:63-77`). */
const runLocal = Effect.fnUntraced(function* (
  flags: LegacyDbAdvisorsFlags,
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;

  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    linked: false,
    local: flags.local,
    dnsResolver,
  });

  const lints = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* output.raw(
        `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
        "stderr",
      );
      const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      yield* session.exec("begin").pipe(
        Effect.mapError(
          (cause) =>
            new LegacyDbAdvisorsBeginTxError({
              message: `failed to begin transaction: ${cause.message}`,
            }),
        ),
      );
      return yield* queryLints(session).pipe(
        Effect.ensuring(
          session
            .exec("rollback")
            .pipe(Effect.catch((cause) => output.raw(`${cause.message}\n`, "stderr"))),
        ),
      );
    }),
  );

  return filterAdvisorLints(lints, advisorType, level);
});

/** Go's advisors PreRunE + `RunLinked` (`cmd/db.go`, `advisors.go:79-100`). */
const runLinked = Effect.fnUntraced(function* (advisorType: string, level: string) {
  const projectRefResolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;

  // PreRunE: require an access token before resolving the project ref.
  const tokenOpt = yield* resolveLegacyAccessToken;
  if (Option.isNone(tokenOpt)) {
    return yield* Effect.fail(
      new LegacyDbAdvisorsNotLoggedInError({
        message: missingTokenMessage(),
        suggestion: loginSuggestion(),
      }),
    );
  }
  const ref = yield* projectRefResolver.resolve(Option.none());

  // Write the linked-project cache on success and failure (Go PersistentPostRun).
  return yield* Effect.gen(function* () {
    const lints: Array<LegacyAdvisorLint> = [];
    if (advisorType === "all" || advisorType === "security") {
      lints.push(...(yield* fetchSecurityAdvisors(ref)));
    }
    if (advisorType === "all" || advisorType === "performance") {
      lints.push(...(yield* fetchPerformanceAdvisors(ref)));
    }
    // The endpoint selection already applied the type filter, so filter by "all".
    return filterAdvisorLints(lints, "all", level);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
});

/** Go's `outputAndCheck` (`advisors.go:241-262`). */
const outputAndCheck = Effect.fnUntraced(function* (
  lints: ReadonlyArray<LegacyAdvisorLint>,
  failOn: string,
) {
  const output = yield* Output;
  const processControl = yield* ProcessControl;

  if (lints.length === 0) {
    // The diagnostic goes to stderr in every mode (stdout stays payload-only);
    // machine modes additionally emit the empty result envelope.
    yield* output.raw("No issues found\n", "stderr");
    if (output.format !== "text") {
      yield* output.success("db advisors", { results: [] });
    }
    return;
  }

  if (output.format === "text") {
    yield* output.raw(encodeAdvisorLints(lints));
  } else {
    yield* output.success("db advisors", { results: lints });
  }

  const failOnLevel = LEGACY_ADVISORS_LEVEL_ENUM.toEnum(failOn);
  if (legacyFailsOn(lints, (lint) => lint.level, failOnLevel, LEGACY_ADVISORS_LEVEL_ENUM)) {
    // advisors echoes the raw `--fail-on` flag value (Go `advisors.go:257`).
    const message = `fail-on is set to ${failOn}, non-zero exit`;
    if (output.format === "text") {
      return yield* Effect.fail(new LegacyDbAdvisorsFailOnError({ message }));
    }
    yield* processControl.setExitCode(1);
  }
});

const runAdvisors = Effect.fnUntraced(function* (
  flags: LegacyDbAdvisorsFlags,
  dnsResolver: "native" | "https",
) {
  // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local"), keyed off the
  // explicitly-set flags (cobra's `Changed`), not the `--local` default value.
  const setFlags: Array<string> = [];
  if (Option.isSome(flags.dbUrl)) setFlags.push("db-url");
  if (flags.linked) setFlags.push("linked");
  if (flags.local) setFlags.push("local");
  if (setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyDbAdvisorsMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const advisorType = Option.getOrElse(flags.type, () => "all");
  const level = Option.getOrElse(flags.level, () => "warn");
  const failOn = Option.getOrElse(flags.failOn, () => "none");

  // Go branches on whether `--linked` was explicitly set (`cmd/db.go` RunE):
  // linked → Management API; otherwise local / `--db-url`.
  const filtered = flags.linked
    ? yield* runLinked(advisorType, level)
    : yield* runLocal(flags, dnsResolver, advisorType, level);

  yield* outputAndCheck(filtered, failOn);
});

export const legacyDbAdvisors = Effect.fn("legacy.db.advisors")(function* (
  flags: LegacyDbAdvisorsFlags,
) {
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const telemetryState = yield* LegacyTelemetryState;
  // Flush telemetry on success and failure (Go PersistentPostRun). Command-level
  // instrumentation / JSON error handling are applied by `advisors.command.ts`.
  yield* runAdvisors(flags, dnsResolver).pipe(Effect.ensuring(telemetryState.flush));
});
