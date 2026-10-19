import { Effect, Option } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { hostedMutationPreapproval } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import {
  resolveTarget,
  type ResolvedTarget,
} from "../../../command-internal/target/resolve-target.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../shared/runtime/process-control.service.ts";
import { CommandCredentials } from "../../../auth/command-credentials.service.ts";
import { aqua } from "../../../command-internal/colors.ts";
import { missingAccessTokenMessage } from "../../../auth/access-token.ts";
import { failsOn } from "../../../command-internal/fail-on.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import type { DbSession } from "../../../command-internal/db-connection.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { DbAdvisorsFlags } from "./advisors.command.ts";
import {
  DbAdvisorsBeginTxError,
  DbAdvisorsFailOnError,
  DbAdvisorsInvalidTokenError,
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
const queryLints = Effect.fn("DbAdvisors.queryLints")(function* (session: DbSession) {
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
  yield* Effect.annotateCurrentSpan("advisor.count", rows.length);
  return rows.map(scanAdvisorLintRow);
});

/** Gathers lints from a local (or `--db-url`) database connection. */
const runLocal = Effect.fn("db.advisors.runLocal")(function* (
  target: Exclude<ResolvedTarget, { readonly kind: "linked" }>,
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;

  const cfg = yield* resolver.resolveConnection({
    target,
    dnsResolver,
    password: Option.none(),
    networkBanRemoval: yield* hostedMutationPreapproval,
  });

  const lints = yield* Effect.scoped(
    Effect.gen(function* () {
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
const runLinked = Effect.fn("db.advisors.runLinked")(function* (
  target: Extract<ResolvedTarget, { readonly kind: "linked" }>,
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
) {
  const resolver = yield* DbConfigResolver;
  const credentials = yield* CommandCredentials;
  const linkedProjectCache = yield* LinkedProjectCache;

  const { ref } = target;

  // The linked-project cache is written whenever the project ref was resolved, even when the
  // connection resolve below fails.
  return yield* Effect.gen(function* () {
    // The host probe / login-role mint / pooler / IPv6 fallback. The linked lint-gathering path
    // ignores the resolved config — this runs purely for the side effects and early-failure
    // ordering (before the token gate).
    yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: Option.none(),
      networkBanRemoval: yield* hostedMutationPreapproval,
    });

    // The access token is validated against the `sbp_` pattern before calling the API: a
    // malformed token maps to the invalid-token error, an absent token to missing.
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
      return yield* new DbAdvisorsNotLoggedInError({
        message: missingAccessTokenMessage(),
        suggestion: loginSuggestion(),
      });
    }

    const lints: Array<AdvisorLint> = [];
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
      return yield* new DbAdvisorsFailOnError({ message });
    }
    yield* processControl.setExitCode(1);
  }
});

const runAdvisors = Effect.fnUntraced(function* (
  flags: DbAdvisorsFlags,
  dnsResolver: "native" | "https",
) {
  const target = yield* resolveTarget({
    remote: flags.remote,
    local: flags.local,
    linked: flags.linked,
    dbUrl: flags.dbUrl,
    projectRef: flags.projectRef,
  });

  const advisorType = Option.getOrElse(flags.type, () => "all");
  const level = Option.getOrElse(flags.level, () => "warn");
  const failOn = Option.getOrElse(flags.failOn, () => "none");
  yield* Effect.annotateCurrentSpan({
    "db.conn_type": target.kind,
    "advisor.type": advisorType,
    "advisor.level": level,
    "advisor.fail_on": failOn,
  });

  // Linked goes through the Management API; local and `--db-url` read the database directly.
  const filtered =
    target.kind === "linked"
      ? yield* runLinked(target, dnsResolver, advisorType, level)
      : yield* runLocal(target, dnsResolver, advisorType, level);
  yield* Effect.annotateCurrentSpan("advisor.reported_count", filtered.length);

  yield* outputAndCheck(filtered, failOn);
});

export const dbAdvisors = Effect.fn("db.advisors")(function* (flags: DbAdvisorsFlags) {
  const dnsResolver = yield* DnsResolverFlag;
  const telemetryState = yield* TelemetryState;
  // Flush telemetry on success and failure. Command-level instrumentation /
  // JSON error handling are applied by `advisors.command.ts`.
  yield* runAdvisors(flags, dnsResolver).pipe(Effect.ensuring(telemetryState.flush));
});
