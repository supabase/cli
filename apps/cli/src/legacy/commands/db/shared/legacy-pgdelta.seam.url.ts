/**
 * Injects the Postgres password into a connection URL that the Go `db __shadow`
 * seam emitted WITHOUT one.
 *
 * The Go seam prints the shadow source/target URLs via
 * `ToPostgresURLWithoutPassword` so it never writes a credential to stdout
 * (CWE-312). The shadow database always uses the local Postgres password
 * (`utils.Config.Db.Password`), which the TS caller resolves independently from
 * `config.toml` (`legacyReadDbToml().password`) — so we re-attach it here before
 * the URL is handed to the differ (migra / pg-delta) or a sql-pg connection.
 *
 * The host, port, database, and query params are left exactly as the Go seam
 * produced them (Go remains the authority for IPv6 bracketing, `connect_timeout`,
 * and runtime params); only the userinfo password is set. The `URL` setter
 * percent-encodes the password, matching Go's `url.UserPassword` encoding, and
 * the pg driver decodes it back to the same secret.
 */
export function legacyInjectPostgresPassword(connectionUrl: string, password: string): string {
  const url = new URL(connectionUrl);
  url.password = password;
  return url.toString();
}
