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
import { readMigrationCheckFindings } from "../../../command-internal/migration-checks.ts";
import { getDocumentValue } from "../../../config/cli-config-document.ts";
import { MIGRATION_CHECK_RULES } from "@supabase/config/internal";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { DbAdvisorsFlags } from "./advisors.command.ts";
import {
  DbAdvisorsBaselineError,
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
import {
  type BaselineExclusion,
  baselineRules,
  loadBaselinePolicy,
  writeBaseline,
} from "./advisors.baseline.ts";
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

/** Runs `use` on a connection to the local (or `--db-url`) database. */
const withLocalSession = <A, E, R>(
  target: Exclude<ResolvedTarget, { readonly kind: "linked" }>,
  dnsResolver: "native" | "https",
  use: (session: DbSession) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const resolver = yield* DbConfigResolver;
    const dbConn = yield* DbConnection;
    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: Option.none(),
      networkBanRemoval: yield* hostedMutationPreapproval,
    });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
        return yield* use(session);
      }),
    );
  });

/** Gathers lints from a local (or `--db-url`) database connection. */
const runLocal = Effect.fn("db.advisors.runLocal")(function* (
  target: Exclude<ResolvedTarget, { readonly kind: "linked" }>,
  dnsResolver: "native" | "https",
  advisorType: string,
  level: string,
) {
  const output = yield* Output;
  const lints = yield* withLocalSession(target, dnsResolver, (session) =>
    Effect.gen(function* () {
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

/**
 * Runs `use` once the linked project's access token is present and well formed; the
 * linked-project cache is written whenever the project ref was resolved, even when a later step
 * fails.
 */
const withLinkedAccess = <A, E, R>(
  target: Extract<ResolvedTarget, { readonly kind: "linked" }>,
  use: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const credentials = yield* CommandCredentials;
    const linkedProjectCache = yield* LinkedProjectCache;
    return yield* Effect.gen(function* () {
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
      return yield* use;
    }).pipe(Effect.ensuring(linkedProjectCache.cache(target.ref)));
  });

/** Gathers the linked project's lints from the Management API, never from its database. */
const runLinked = Effect.fn("db.advisors.runLinked")(function* (
  target: Extract<ResolvedTarget, { readonly kind: "linked" }>,
  advisorType: string,
  level: string,
) {
  const { ref } = target;
  return yield* withLinkedAccess(
    target,
    Effect.gen(function* () {
      const lints: Array<AdvisorLint> = [];
      if (advisorType === "all" || advisorType === "security") {
        lints.push(...(yield* fetchSecurityAdvisors(ref)));
      }
      if (advisorType === "all" || advisorType === "performance") {
        lints.push(...(yield* fetchPerformanceAdvisors(ref)));
      }
      // The endpoint selection already applied the type filter, so filter by "all".
      return filterAdvisorLints(lints, "all", level);
    }),
  );
});

/**
 * `--baseline`: reads every current finding for the `[db.migrations.checks]` rules that are not
 * off and records it in `[db.migrations.checks.exclude]`. A linked project's findings come from
 * its security advisors, others from the same read migrations run.
 */
const runBaseline = Effect.fn("db.advisors.baseline")(function* (
  target: ResolvedTarget,
  dnsResolver: "native" | "https",
) {
  const checks = yield* loadBaselinePolicy(target.kind === "linked" ? target.ref : undefined);
  const rules = new Set<string>(baselineRules(checks.policy));
  const findings: ReadonlyArray<BaselineExclusion> =
    rules.size === 0
      ? []
      : target.kind === "linked"
        ? (yield* withLinkedAccess(target, fetchSecurityAdvisors(target.ref))).flatMap((lint) => {
            const rule = MIGRATION_CHECK_RULES.find((known) => known === lint.name);
            const schema = getDocumentValue(lint.metadata, ["schema"]);
            const name = getDocumentValue(lint.metadata, ["name"]);
            return rule === undefined ||
              !rules.has(rule) ||
              typeof schema !== "string" ||
              typeof name !== "string"
              ? []
              : [{ rule, object: `${schema}.${name}` }];
          })
        : (yield* withLocalSession(target, dnsResolver, (session) =>
            readMigrationCheckFindings(session, checks).pipe(
              Effect.catchTag(
                "DbExecError",
                (cause) =>
                  new DbAdvisorsQueryError({ message: `failed to query lints: ${cause.message}` }),
              ),
            ),
          )).flatMap((finding) =>
            finding.schema === null || finding.name === null
              ? []
              : [{ rule: finding.rule, object: `${finding.schema}.${finding.name}` }],
          );
  yield* writeBaseline(checks.policy, findings);
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
  const target = yield* resolveTarget(flags);
  if (flags.baseline) {
    if (Option.isSome(flags.type) || Option.isSome(flags.level) || Option.isSome(flags.failOn)) {
      return yield* new DbAdvisorsBaselineError({
        message:
          "--baseline records every current security check finding and cannot be combined with --type, --level or --fail-on.",
        reason: "flags",
      });
    }
    yield* Effect.annotateCurrentSpan({ "db.conn_type": target.kind, "advisor.baseline": true });
    return yield* runBaseline(target, dnsResolver);
  }

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
      ? yield* runLinked(target, advisorType, level)
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
