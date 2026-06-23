import { readFileSync } from "node:fs";

/**
 * PostgreSQL service file (`pg_service.conf`) support, a 1:1 port of
 * `jackc/pgservicefile` as used by `pgconn.ParseConfig`
 * (`apps/cli-go/pkg/mod/.../pgconn/config.go:250-256`): when a connection's
 * `service` is set (via `service=` or `PGSERVICE`), pgconn reads the service file
 * and merges the named section's settings between the env and connection-string
 * layers. A `dbname` key is remapped to `database` to match pgconn's `nameMap`.
 */

/**
 * Parse a service file into a `section → settings` map. Mirrors
 * `pgservicefile.ParseServicefile`: INI-style `[name]` sections of `key=value`
 * pairs (split on the first `=`, both sides trimmed); blank and `#` lines are
 * ignored. Throws on a `key=value` line before any section, or a line that is
 * neither a section, comment, nor `key=value` — matching pgconn, which surfaces
 * those as a `failed to read service` parse error.
 */
export function parseLegacyServicefile(contents: string): Map<string, Map<string, string>> {
  const services = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  const lines = contents.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      current = new Map();
      services.set(line.slice(1, -1), current);
    } else if (current !== undefined) {
      const eq = line.indexOf("=");
      if (eq === -1) {
        throw new Error(`unable to parse line ${i + 1}`);
      }
      current.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    } else {
      throw new Error(`line ${i + 1} is not in a section`);
    }
  }
  return services;
}

/**
 * Resolve a named service's settings from the service file at `servicefilePath`,
 * remapping `dbname` → `database` like pgconn's `parseServiceSettings`. Returns
 * `undefined` when the file is missing/unreadable, malformed, or has no matching
 * section — pgconn treats all three as a hard parse error, so the caller surfaces
 * a parse failure rather than silently falling through to defaults. The returned
 * map may be empty (a section with no keys), which is distinct from `undefined`.
 */
export function legacyServiceSettings(
  serviceName: string,
  servicefilePath: string,
): Map<string, string> | undefined {
  let contents: string;
  try {
    contents = readFileSync(servicefilePath, "utf8");
  } catch {
    return undefined;
  }
  let services: Map<string, Map<string, string>>;
  try {
    services = parseLegacyServicefile(contents);
  } catch {
    return undefined;
  }
  const service = services.get(serviceName);
  if (service === undefined) {
    return undefined;
  }
  const settings = new Map<string, string>();
  for (const [key, value] of service) {
    settings.set(key === "dbname" ? "database" : key, value);
  }
  return settings;
}
