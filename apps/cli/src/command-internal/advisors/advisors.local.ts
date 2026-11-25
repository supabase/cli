import { Effect, Option } from "effect";
import { hostedMutationPreapproval } from "../hosted-consent/hosted-consent.ts";
import type { ResolvedTarget } from "../target/resolve-target.ts";
import { Output } from "../../shared/output/output.service.ts";
import { DbConfigResolver } from "../db-config.service.ts";
import { DbConnection, type DbSession } from "../db-connection.service.ts";
import {
  DbAdvisorsBeginTxError,
  DbAdvisorsQueryError,
  DbAdvisorsSetupError,
} from "./advisors.errors.ts";
import { scanAdvisorLintRow } from "./advisors.format.ts";
import { splitLintsSql } from "./advisors.lints-sql.ts";

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

const setExposedSchemas = Effect.fn("DbAdvisors.setExposedSchemas")(function* (
  session: DbSession,
  schemas: ReadonlyArray<string>,
) {
  yield* Effect.annotateCurrentSpan("advisor.exposed_schema_count", schemas.length);
  yield* session
    .query("select set_config('pgrst.db_schemas', $1, true)", [schemas.join(",")])
    .pipe(
      Effect.mapError(
        (cause) =>
          new DbAdvisorsSetupError({ message: `failed to prepare lint session: ${cause.message}` }),
      ),
    );
});

export const collectLocalAdvisorLints = Effect.fn("db.advisors.runLocal")(function* (
  target: Exclude<ResolvedTarget, { readonly kind: "linked" }>,
  dnsResolver: "native" | "https",
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
      return yield* Effect.gen(function* () {
        if (cfg.exposedSchemas !== undefined) {
          yield* setExposedSchemas(session, cfg.exposedSchemas);
        }
        return yield* queryLints(session);
      }).pipe(
        Effect.ensuring(
          session
            .exec("rollback")
            .pipe(Effect.catch((cause) => output.raw(`${cause.message}\n`, "stderr"))),
        ),
      );
    }),
  );

  return lints;
});
