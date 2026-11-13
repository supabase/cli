import { getDomain } from "tldts";

import type { PgConnInput } from "./db-connection.service.ts";
import { isDirectDbHost } from "./pooler-fallback.ts";
import { poolerHost, projectHost } from "./profile.ts";
import caProd2021 from "./supabase-ca-templates/prod-ca-2021.ts";
import caProd2025 from "./supabase-ca-templates/prod-ca-2025.ts";
import caStaging2021 from "./supabase-ca-templates/staging-ca-2021.ts";

export function rootCaBundle() {
  return `${caStaging2021}${caProd2021}${caProd2025}`;
}

/** Built-in profiles whose database servers chain to {@link rootCaBundle}. */
const PINNED_PROFILES: ReadonlySet<string> = new Set(["supabase", "supabase-staging", "snap"]);

/**
 * Pins the bundled Supabase CA (`require` plus an inline root CA, which the driver and `pg_dump`
 * promote to `verify-ca`) on a remote connection, linked or `--db-url`, to a hosted Supabase
 * database of the active built-in profile. A
 * root CA set without `sslmode` replaces the bundle but keeps `require`, since the unset default
 * (`prefer`) would ignore it. A connection that sets `sslmode` from any source, a host outside
 * the profile's project and pooler domains, and every other profile (`supabase-local`, YAML) are
 * returned unchanged.
 */
export function pinSupabaseTls(conn: PgConnInput, profile: string): PgConnInput {
  if (!PINNED_PROFILES.has(profile) || conn.sslmode !== undefined) return conn;
  const host = conn.host.toLowerCase().replace(/\.$/, "");
  const domain = getDomain(host);
  const hosted =
    isDirectDbHost(host, projectHost(profile)) ||
    (domain !== null && domain.toLowerCase() === poolerHost(profile));
  if (!hosted) return conn;
  return conn.sslrootcert !== undefined || conn.sslrootcertInline !== undefined
    ? { ...conn, sslmode: "require" }
    : { ...conn, sslmode: "require", sslrootcertInline: rootCaBundle() };
}
