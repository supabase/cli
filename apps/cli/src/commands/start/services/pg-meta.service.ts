/**
 * pg-meta container spec builder, gated on `config.studio.enabled` (pg-meta
 * has no `enabled` flag of its own — it only exists to back Studio's schema
 * browser) and
 * `!isContainerExcluded(config.studio.pgmeta_image, excluded)` — see
 * `service-catalog.ts`'s `pgMeta` entry (`excludeKey: "postgres-meta"`,
 * gated on `studio.enabled`). Gating and image resolution/pre-pull are the
 * caller's job (a future `start.handler.ts`); this module only assembles the
 * container spec once the caller has already decided to start it, matching
 * `docker-create-args.ts`'s "image already resolved/pulled" contract.
 *
 * No separately-tested pure env function the way Studio has
 * (`buildStudioEnv`): pg-meta's env is 6 straight `KEY=value`
 * assignments with no derived formatting or conditional logic, so
 * {@link buildPgMetaContainerSpec} is the only exported entry point.
 */

import type { StartContainerSpec } from "../../../command-internal/db-bootstrap/docker-create-args.ts";

/** The hardcoded pg-meta listen port (`PG_META_PORT=8080`) — never configurable. */
const PG_META_PORT = 8080;

/** The pg-meta network alias — a fixed, non-configurable constant. */
const PG_META_NETWORK_ALIASES = ["pg_meta"];

export interface PgMetaContainerInput {
  /** `config.studio.pgmeta_image`, already resolved/pulled by the caller. */
  readonly image: string;
  /** `serviceContainerName("pg_meta", projectId)`. */
  readonly containerName: string;
  /**
   * The local Postgres container's own hostname on the shared Docker
   * network.
   */
  readonly dbHost: string;
  /** Hardcoded `5432`. */
  readonly dbPort: number;
  /** Hardcoded `"postgres"`. */
  readonly dbUser: string;
  /** `config.db.password` (`resolveLocalConfigValues`'s resolved value). */
  readonly dbPassword: string;
  /** Hardcoded `"postgres"`. */
  readonly dbName: string;
  /** The shared Docker network every `start` container joins. */
  readonly networkId: string;
}

/**
 * Assembles pg-meta's {@link StartContainerSpec}. Pure — no Effect or
 * I/O — matching `docker-create-args.ts`'s own builder shape.
 */
export function buildPgMetaContainerSpec(input: PgMetaContainerInput): StartContainerSpec {
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
