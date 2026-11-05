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
 * Pins the bundled Supabase CA (`require` plus an inline root CA, which the driver promotes to
 * `verify-ca`) on a connection to a hosted Supabase database of the active built-in profile. A
 * connection that sets `sslmode` or `sslrootcert` from any source, a host outside the profile's
 * project and pooler domains, and every other profile (`supabase-local`, YAML) are
 * returned unchanged.
 */
export function pinSupabaseTls(conn: PgConnInput, profile: string): PgConnInput {
  if (
    !PINNED_PROFILES.has(profile) ||
    conn.sslmode !== undefined ||
    conn.sslrootcert !== undefined ||
    conn.sslrootcertInline !== undefined
  ) {
    return conn;
  }
  const host = conn.host.toLowerCase().replace(/\.$/, "");
  const domain = getDomain(host);
  const hosted =
    isDirectDbHost(host, projectHost(profile)) ||
    (domain !== null && domain.toLowerCase() === poolerHost(profile));
  return hosted ? { ...conn, sslmode: "require", sslrootcertInline: rootCaBundle() } : conn;
}
