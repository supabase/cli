import type { Option } from "effect";
import type { PgConnInput } from "./db-connection.service.ts";
import type { HostedMutationConsent } from "./hosted-consent/hosted-consent.token.ts";
import type { ResolvedTarget } from "./target/resolve-target.ts";

/**
 * A resolved Postgres connection plus whether it points at the local stack. `isLocal` decides
 * the pg_prove docker network/host rewrite in the `test db` handler, so it is computed once here.
 */
export interface ResolvedDbConfig {
  readonly conn: PgConnInput;
  readonly isLocal: boolean;
  /**
   * The resolved linked project ref (`--linked` path only; `None` for `--local` / `--db-url`).
   * Lets the caller re-read config with the ref applied so a matching `[remotes.<ref>]` block can
   * override fields like `db.major_version` for the container image.
   */
  readonly ref?: Option.Option<string>;
}

/** What {@link DbConfigResolver.resolveConnection} needs: the resolved target plus how to authenticate. */
export interface DbConnectionInput {
  readonly target: ResolvedTarget;
  readonly dnsResolver: "native" | "https";
  /** Rejected unless the target is the linked project. */
  readonly password: Option.Option<string>;
  readonly resolveVaultSecrets?: boolean;
  /** Set when the command binds `--password`, so the withheld-password notice can name it. */
  readonly hasPasswordFlag?: boolean;
  /** `Some` lets the temp-role retry clear a network ban; `None` fails with `LinkedDbNetworkBannedError` instead. */
  readonly networkBanRemoval: Option.Option<HostedMutationConsent>;
}

export interface ResolvedDbConnection extends ResolvedDbConfig {
  readonly target: ResolvedTarget;
}
