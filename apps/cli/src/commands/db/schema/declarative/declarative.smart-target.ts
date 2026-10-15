import { Effect, Option } from "effect";

import { DnsResolverFlag } from "../../../../command-internal/global-flags.ts";
import { resetLocalDatabase } from "../../../../command-internal/db-bootstrap/reset-local-database.ts";
import { DbConfigResolver } from "../../../../command-internal/db-config.service.ts";
import { hostedMutationPreapproval } from "../../../../command-internal/hosted-consent/hosted-consent.ts";
import { toPostgresURL } from "../../../../command-internal/postgres-url.ts";
import type { ResolvedTarget } from "../../../../command-internal/target/resolve-target.ts";
import type { PgDeltaDatabaseEndpoint } from "../../shared/pgdelta-engine.service.ts";
import { DeclarativeApplyError, readErrorSuggestion } from "./declarative.errors.ts";
import { DeclarativeSeam } from "../../shared/pgdelta.seam.service.ts";

/** Resolves a target's connection, which announces it, without discarding TLS and connection options. */
export const resolveTargetEndpoint = Effect.fnUntraced(function* (
  target: ResolvedTarget,
  password: Option.Option<string> = Option.none(),
  hasPasswordFlag = false,
) {
  const resolver = yield* DbConfigResolver;
  const dnsResolver = yield* DnsResolverFlag;
  const resolved = yield* resolver.resolveConnection({
    target,
    dnsResolver,
    password,
    hasPasswordFlag,
    networkBanRemoval: yield* hostedMutationPreapproval,
  });
  return {
    kind: "database",
    ref: toPostgresURL(resolved.conn),
    connection: resolved.conn,
    connectOptions: { isLocal: resolved.isLocal, dnsResolver },
  } satisfies PgDeltaDatabaseEndpoint;
});

const resetLocalDatabaseForDeclarative = () =>
  resetLocalDatabase().pipe(
    Effect.mapError(
      (error) =>
        new DeclarativeApplyError({
          message: `database reset failed: ${error.message}`,
          suggestion: readErrorSuggestion(error),
        }),
    ),
  );

/**
 * The local target for `generate` and for `sync`'s bootstrap: checks the Postgres image, starts a
 * stopped stack, optionally resets it, then resolves its connection.
 */
export const prepareLocalTargetEndpoint = Effect.fn("DeclarativeSchema.localTarget")(function* <
  E,
  R,
>(shouldReset: Effect.Effect<boolean, E, R>, password: Option.Option<string> = Option.none()) {
  const seam = yield* DeclarativeSeam;
  yield* seam.ensureLocalPostgresImageCurrent;
  yield* seam.ensureLocalDatabaseStarted;
  const reset = yield* shouldReset;
  yield* Effect.annotateCurrentSpan("declarative.local_reset", reset);
  if (reset) yield* resetLocalDatabaseForDeclarative();
  return yield* resolveTargetEndpoint({ kind: "local" }, password, true);
});
