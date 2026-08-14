import { Effect, Option } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { LegacyCredentials } from "../../../auth/legacy-credentials.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyAqua } from "../../../shared/legacy-colors.ts";
import { legacyMissingAccessTokenMessage } from "../../../auth/legacy-access-token.ts";
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

/** Established output-contract suggestion for a missing/invalid access token. */
const loginSuggestion = (): string => `Run ${legacyAqua("supabase login")} first.`;

/** Queries and scans the lints, minus the transaction the caller owns. */
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

/** Gathers lints from a local (or `--db-url`) database connection. */
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

/** Gathers lints from the Management API for the linked project. */
const runLinked = Effect.fnUntraced(function* (
  flags: LegacyDbAdvisorsFlags,
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
) {
  const resolver = yield* LegacyDbConfigResolver;
  const credentials = yield* LegacyCredentials;
  const projectRefResolver = yield* LegacyProjectRefResolver;
  const linkedProjectCache = yield* LegacyLinkedProjectCache;
  // Every Management API response is wrapped in identity stitching; the
  // raw-HTTP advisor GETs run the same stitch. One stitcher shared across both
  // endpoint calls so it fires at most once per session.
  const { stitch } = yield* LegacyIdentityStitch;

  // The linked-project cache is written whenever the project ref was resolved,
  // even when the DB-config resolve below fails (e.g. the IPv6 error). Load
  // the ref first (non-prompting `loadProjectRef`, honoring an explicit
  // `--project-ref`; not-linked → empty ref → nothing to cache) and wrap
  // everything after it in the cache finalizer.
  const ref = yield* projectRefResolver.loadProjectRef(flags.projectRef);

  return yield* Effect.gen(function* () {
    // The host probe / login-role mint ("Initialising login role...") / pooler
    // / IPv6 fallback. The linked lint-gathering path ignores the resolved
    // config, so resolve-and-discard — purely for the side effects and
    // early-failure ordering (before the token gate).
    yield* resolver.resolve({
      dbUrl: Option.none(),
      connType: "linked",
      dnsResolver,
      linkedProjectRef: flags.projectRef,
    });

    // The access token is validated (env/keyring/file) against the `sbp_`
    // pattern and fails before calling the API. `LegacyCredentials.getAccessToken`
    // is the validating equivalent: map a malformed token to the invalid-token
    // error and an absent token to missing.
    const tokenOpt = yield* credentials.getAccessToken.pipe(
      Effect.catchTag("LegacyInvalidAccessTokenError", (cause) =>
        Effect.fail(
          new LegacyDbAdvisorsInvalidTokenError({
            message: cause.message,
            suggestion: loginSuggestion(),
            // Preserve the token source so an env-provided malformed token keeps
            // its `set_env_var` remediation instead of degrading to `supabase login`.
            source: cause.source,
          }),
        ),
      ),
    );
    if (Option.isNone(tokenOpt)) {
      return yield* Effect.fail(
        new LegacyDbAdvisorsNotLoggedInError({
          message: legacyMissingAccessTokenMessage(),
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

/** Prints the lints (or the empty-result message) and applies `--fail-on`. */
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
    // Echoes the raw `--fail-on` flag value.
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
  // Mutually-exclusive db-url/linked/local group, keyed off the
  // explicitly-set flags, not the `--local` default value.
  const setFlags = target.setFlags;
  if (setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyDbAdvisorsMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
      }),
    );
  }

  // `--project-ref` never implies `--linked` and must not be silently
  // discarded on a non-linked target — see push.handler.ts's identical guard
  // for the full TS-only rationale. advisors defaults to the local/db-url path
  // (`runLocal`) whenever `--linked` isn't the resolved target selector.
  if (Option.isSome(flags.projectRef) && target.connType !== "linked") {
    return yield* Effect.fail(
      new LegacyDbAdvisorsMutuallyExclusiveFlagsError({
        message:
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      }),
    );
  }

  const advisorType = Option.getOrElse(flags.type, () => "all");
  const level = Option.getOrElse(flags.level, () => "warn");
  const failOn = Option.getOrElse(flags.failOn, () => "none");

  // Branches on whether `--linked` was explicitly set: linked → Management
  // API; otherwise local / `--db-url`.
  const filtered =
    target.connType === "linked"
      ? yield* runLinked(flags, dnsResolver, advisorType, level)
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
  // Flush telemetry on success and failure. Command-level instrumentation /
  // JSON error handling are applied by `advisors.command.ts`.
  yield* runAdvisors(flags, dnsResolver, target).pipe(Effect.ensuring(telemetryState.flush));
});
