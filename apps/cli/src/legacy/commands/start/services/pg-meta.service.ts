/**
 * pg-meta container spec builder — port of Go's "Start pg-meta" block
 * (`apps/cli-go/internal/start/start.go:1110-1146`). Gated in Go by
 * `config.studio.enabled` (pg-meta has no `enabled` flag of its own — it only
 * exists to back Studio's schema browser) and
 * `!isContainerExcluded(config.studio.pgmeta_image, excluded)` — see
 * `legacy-service-catalog.ts`'s `pgMeta` entry (`excludeKey: "postgres-meta"`,
 * gated on `studio.enabled`). Gating and image resolution/pre-pull are the
 * caller's job (a future `start.handler.ts`); this module only assembles the
 * container spec once the caller has already decided to start it, matching
 * `docker-create-args.ts`'s "image already resolved/pulled" contract.
 *
 * No separately-tested pure env function the way Studio has
 * (`legacyBuildStudioEnv`): pg-meta's env is 6 straight `KEY=value`
 * assignments with no derived formatting or conditional logic, so
 * {@link legacyBuildPgMetaContainerSpec} is the only exported entry point.
 */

import type { LegacyStartContainerSpec } from "../../../shared/containers/docker-create-args.ts";

/** Go's hardcoded pg-meta listen port (`start.go:1117`, `PG_META_PORT=8080`) — never configurable. */
const PG_META_PORT = 8080;

/** Go's `utils.PgmetaAliases` (`apps/cli-go/internal/utils/config.go:44`) — a fixed, non-configurable constant. */
const PG_META_NETWORK_ALIASES = ["pg_meta"];

export interface LegacyPgMetaContainerInput {
  /** `config.studio.pgmeta_image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `legacyServiceContainerName("pg_meta", projectId)` — Go's `utils.PgmetaId`. */
  readonly containerName: string;
  /**
   * Go's `dbConfig.Host` (`utils.DbId`, `internal/start/start.go:66`) — the
   * local Postgres container's own hostname on the shared Docker network.
   */
  readonly dbHost: string;
  /** Go's `dbConfig.Port` (hardcoded `5432`, `start.go:67`). */
  readonly dbPort: number;
  /** Go's `dbConfig.User` (hardcoded `"postgres"`, `start.go:68`). */
  readonly dbUser: string;
  /** Go's `dbConfig.Password` (`config.db.password`, `legacyResolveLocalConfigValues`'s resolved value). */
  readonly dbPassword: string;
  /** Go's `dbConfig.Database` (hardcoded `"postgres"`, `start.go:70`). */
  readonly dbName: string;
  /** Go's `utils.NetId` — the shared Docker network every `start` container joins. */
  readonly networkId: string;
}

/**
 * Assembles pg-meta's {@link LegacyStartContainerSpec}. Pure — no Effect or
 * I/O — matching `docker-create-args.ts`'s own builder shape.
 */
export function legacyBuildPgMetaContainerSpec(
  input: LegacyPgMetaContainerInput,
): LegacyStartContainerSpec {
  return {
    image: input.image,
    containerName: input.containerName,
    env: {
      PG_META_PORT: String(PG_META_PORT),
      PG_META_DB_HOST: input.dbHost,
      PG_META_DB_NAME: input.dbName,
      PG_META_DB_USER: input.dbUser,
      PG_META_DB_PORT: String(input.dbPort),
      PG_META_DB_PASSWORD: input.dbPassword,
    },
    binds: [],
    healthcheck: {
      test: [
        "CMD-SHELL",
        `node --eval="fetch('http://127.0.0.1:${PG_META_PORT}/health').then((r) => {if (!r.ok) throw new Error(r.status)})"`,
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    },
    restartPolicy: "unless-stopped",
    networkId: input.networkId,
    networkAliases: PG_META_NETWORK_ALIASES,
    labels: {},
  };
}
