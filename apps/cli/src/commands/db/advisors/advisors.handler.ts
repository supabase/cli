import { Effect, Option } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../shared/runtime/process-control.service.ts";
import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { missingAccessTokenMessage } from "../../../auth/access-token.ts";
import { failsOn } from "../../../command-internal/fail-on.ts";
import { IdentityStitch } from "../../../command-internal/identity-stitch.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import type { DbSession } from "../../../command-internal/db-connection.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import type { DbTargetSelection } from "../../../command-internal/db-target-flags.ts";
import type { DbAdvisorsFlags } from "./advisors.command.ts";
import {
  DbAdvisorsBeginTxError,
  DbAdvisorsFailOnError,
  DbAdvisorsInvalidTokenError,
  DbAdvisorsMutuallyExclusiveFlagsError,
  DbAdvisorsNotLoggedInError,
  DbAdvisorsQueryError,
  DbAdvisorsSetupError,
} from "./advisors.errors.ts";
import {
  encodeAdvisorLints,
  filterAdvisorLints,
  ADVISORS_LEVEL_ENUM,
  type AdvisorLint,
  scanAdvisorLintRow,
} from "./advisors.format.ts";
import { fetchPerformanceAdvisors, fetchSecurityAdvisors } from "./advisors.linked.ts";
import { splitLintsSql } from "./advisors.lints-sql.ts";

/** Established output-contract suggestion for a missing/invalid access token. */
const loginSuggestion = (): string => `Run ${aqua("supabase login")} first.`;

/** Queries and scans the lints, minus the transaction the caller owns. */
const queryLints = Effect.fnUntraced(function* (session: DbSession) {
  const [setupSql, querySql] = splitLintsSql();
  yield* session.exec(setupSql).pipe(
    Effect.mapError(
      (cause) =>
        new DbAdvisorsSetupError({
          message: `failed to prepare lint session: ${cause.message}`,
        }),
    ),
  );
  const rows = yield* session
    .query(querySql)
    .pipe(
      Effect.mapError(
        (cause) => new DbAdvisorsQueryError({ message: `failed to query lints: ${cause.message}` }),
      ),
    );
  return rows.map(scanAdvisorLintRow);
});

/** Gathers lints from a local (or `--db-url`) database connection. */
const runLocal = Effect.fnUntraced(function* (
  flags: DbAdvisorsFlags,
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
  target: DbTargetSelection,
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;

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
            new DbAdvisorsBeginTxError({
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

/** Gathers lints from the Management API for the linked project. */
const runLinked = Effect.fnUntraced(function* (
  flags: DbAdvisorsFlags,
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
) {
  const resolver = yield* DbConfigResolver;
  const credentials = yield* CommandCredentials;
  const projectRefResolver = yield* ProjectRefResolver;
  const linkedProjectCache = yield* LinkedProjectCache;
  // Every Management API response is wrapped in identity stitching; the
  // raw-HTTP advisor GETs run the same stitch. One stitcher shared across both
  // endpoint calls so it fires at most once per session.
  const { stitch } = yield* IdentityStitch;

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
    // pattern and fails before calling the API. `CommandCredentials.getAccessToken`
    // is the validating equivalent: map a malformed token to the invalid-token
    // error and an absent token to missing.
    const tokenOpt = yield* credentials.getAccessToken.pipe(
      Effect.catchTag("InvalidAccessTokenError", (cause) =>
        Effect.fail(
          new DbAdvisorsInvalidTokenError({
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
        new DbAdvisorsNotLoggedInError({
          message: missingAccessTokenMessage(),
          suggestion: loginSuggestion(),
        }),
      );
    }

    const lints: Array<AdvisorLint> = [];
    if (advisorType === "all" || advisorType === "security") {
      lints.push(...(yield* fetchSecurityAdvisors(ref, stitch)));
    }
    if (advisorType === "all" || advisorType === "performance") {
      lints.push(...(yield* fetchPerformanceAdvisors(ref, stitch)));
    }
    // The endpoint selection already applied the type filter, so filter by "all".
    return filterAdvisorLints(lints, "all", level);
  }).pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
});

/** Prints the lints (or the empty-result message) and applies `--fail-on`. */
const outputAndCheck = Effect.fnUntraced(function* (
  lints: ReadonlyArray<AdvisorLint>,
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

  const failOnLevel = ADVISORS_LEVEL_ENUM.toEnum(failOn);
  if (failsOn(lints, (lint) => lint.level, failOnLevel, ADVISORS_LEVEL_ENUM)) {
    // Echoes the raw `--fail-on` flag value.
    const message = `fail-on is set to ${failOn}, non-zero exit`;
    if (output.format === "text") {
      return yield* Effect.fail(new DbAdvisorsFailOnError({ message }));
    }
    yield* processControl.setExitCode(1);
  }
});

const runAdvisors = Effect.fnUntraced(function* (
  flags: DbAdvisorsFlags,
  dnsResolver: "native" | "https",
  target: DbTargetSelection,
) {
  // Mutually-exclusive db-url/linked/local group, keyed off the
  // explicitly-set flags, not the `--local` default value.
  const setFlags = target.setFlags;
  if (setFlags.length > 1) {
    return yield* Effect.fail(
      new DbAdvisorsMutuallyExclusiveFlagsError({
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
      new DbAdvisorsMutuallyExclusiveFlagsError({
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

export const dbAdvisors = Effect.fn("db.advisors")(function* (flags: DbAdvisorsFlags) {
  const dnsResolver = yield* DnsResolverFlag;
  const telemetryState = yield* TelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveDbTargetFlags(cliArgs.args);
  // Flush telemetry on success and failure. Command-level instrumentation /
  // JSON error handling are applied by `advisors.command.ts`.
  yield* runAdvisors(flags, dnsResolver, target).pipe(Effect.ensuring(telemetryState.flush));
});
