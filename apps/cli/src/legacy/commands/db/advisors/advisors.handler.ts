import { Effect, Option } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { LegacyCredentials } from "../../../auth/legacy-credentials.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import { legacyFailsOn } from "../../../shared/legacy-fail-on.ts";
import { LegacyIdentityStitch } from "../../../shared/legacy-identity-stitch.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import type { LegacyDbTargetSelection } from "../../../shared/legacy-db-target-flags.ts";
import type { LegacyDbAdvisorsFlags } from "./advisors.command.ts";
import {
  LegacyDbAdvisorsBeginTxError,
  LegacyDbAdvisorsFailOnError,
  LegacyDbAdvisorsInvalidTokenError,
  LegacyDbAdvisorsMutuallyExclusiveFlagsError,
  LegacyDbAdvisorsNotLoggedInError,
  LegacyDbAdvisorsQueryError,
  LegacyDbAdvisorsSetupError,
} from "./advisors.errors.ts";
import {
  encodeLegacyAdvisorLints,
  filterLegacyAdvisorLints,
  LEGACY_ADVISORS_LEVEL_ENUM,
  type LegacyAdvisorLint,
  scanLegacyAdvisorLintRow,
} from "./advisors.format.ts";
import { legacyFetchPerformanceAdvisors, legacyFetchSecurityAdvisors } from "./advisors.linked.ts";
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
  return rows.map(scanLegacyAdvisorLintRow);
});

/** Go's `RunLocal` lint gathering (`advisors.go:63-77`). */
const runLocal = Effect.fnUntraced(function* (
  flags: LegacyDbAdvisorsFlags,
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
  target: LegacyDbTargetSelection,
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;

  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType: target.connType === "db-url" ? "db-url" : "local",
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

  return filterLegacyAdvisorLints(lints, advisorType, level);
});

/** Go's root `PersistentPreRunE` (`cmd/root.go:118`) + advisors `PreRunE` +
 *  `RunLinked` (`cmd/db.go:355-371`, `advisors.go:79-100`). */
const runLinked = Effect.fnUntraced(function* (
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
) {
  const resolver = yield* LegacyDbConfigResolver;
  const credentials = yield* LegacyCredentials;
  const projectRefResolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  // Go wraps every Management API response in identityTransport for session
  // identity stitching (`internal/utils/api.go:128`); the raw-HTTP advisor GETs
  // run the same stitch. One stitcher shared across both endpoint calls so it
  // fires at most once per session, matching Go's NeedsIdentityStitch gate.
  const { stitch } = yield* LegacyIdentityStitch;

  // Go's `ParseDatabaseConfig` linked branch loads the project ref
  // (`internal/utils/flags/db_url.go:88`) BEFORE the host probe (`:95`), and
  // `Execute` runs `ensureProjectGroupsCached` after the command — INCLUDING the
  // error path (`cmd/root.go:176`, before the `err != nil` panic at `:185`) — so
  // the linked-project cache is written whenever `flags.ProjectRef` was set, even
  // when the DB-config resolve below fails (e.g. the IPv6 error). Load the ref
  // first (non-prompting `LoadProjectRef`; ErrNotLinked → empty ref → nothing to
  // cache, matching Go) and wrap everything after it in the cache finalizer.
  const ref = yield* projectRefResolver.loadProjectRef(Option.none());

  return yield* Effect.gen(function* () {
    // Root PersistentPreRunE's `ParseDatabaseConfig` host probe / login-role mint
    // ("Initialising login role...") / pooler / IPv6 fallback. `RunLinked` ignores
    // the resolved config (`advisors.go:79-100`), so resolve-and-discard — purely
    // for the side effects and early-failure ordering (before the token gate,
    // matching root PersistentPreRunE → advisors PreRunE).
    yield* resolver.resolve({ dbUrl: Option.none(), connType: "linked", dnsResolver });

    // PreRunE: Go calls `utils.LoadAccessTokenFS` (`cmd/db.go:358`), which VALIDATES
    // the token (env/keyring/file) against the `sbp_` pattern and fails with
    // `ErrInvalidToken` before calling the API (`internal/utils/access_token.go:24-33`).
    // `LegacyCredentials.getAccessToken` is the validating equivalent: map a
    // malformed token to the invalid-token error and an absent token to missing.
    const tokenOpt = yield* credentials.getAccessToken.pipe(
      Effect.catchTag("LegacyInvalidAccessTokenError", (cause) =>
        Effect.fail(
          new LegacyDbAdvisorsInvalidTokenError({
            message: cause.message,
            suggestion: loginSuggestion(),
          }),
        ),
      ),
    );
    if (Option.isNone(tokenOpt)) {
      return yield* Effect.fail(
        new LegacyDbAdvisorsNotLoggedInError({
          message: missingTokenMessage(),
          suggestion: loginSuggestion(),
        }),
      );
    }

    const lints: Array<LegacyAdvisorLint> = [];
    if (advisorType === "all" || advisorType === "security") {
      lints.push(...(yield* legacyFetchSecurityAdvisors(ref, stitch)));
    }
    if (advisorType === "all" || advisorType === "performance") {
      lints.push(...(yield* legacyFetchPerformanceAdvisors(ref, stitch)));
    }
    // The endpoint selection already applied the type filter, so filter by "all".
    return filterLegacyAdvisorLints(lints, "all", level);
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
    yield* output.raw(encodeLegacyAdvisorLints(lints));
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
  target: LegacyDbTargetSelection,
) {
  // cobra MarkFlagsMutuallyExclusive("db-url", "linked", "local"), keyed off the
  // explicitly-set flags (cobra's `Changed`), not the `--local` default value.
  const setFlags = target.setFlags;
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
  const filtered =
    target.connType === "linked"
      ? yield* runLinked(dnsResolver, advisorType, level)
      : yield* runLocal(flags, dnsResolver, advisorType, level, target);

  yield* outputAndCheck(filtered, failOn);
});

export const legacyDbAdvisors = Effect.fn("legacy.db.advisors")(function* (
  flags: LegacyDbAdvisorsFlags,
) {
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  // Flush telemetry on success and failure (Go PersistentPostRun). Command-level
  // instrumentation / JSON error handling are applied by `advisors.command.ts`.
  yield* runAdvisors(flags, dnsResolver, target).pipe(Effect.ensuring(telemetryState.flush));
});
