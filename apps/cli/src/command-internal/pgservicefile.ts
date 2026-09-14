import { readFileSync } from "node:fs";

/**
 * PostgreSQL service file (`pg_service.conf`) support: when a connection's `service` is set
 * (via `service=` or `PGSERVICE`), this reads the service file and merges the named section's
 * settings between the env and connection-string layers. A `dbname` key is remapped to
 * `database`.
 */

/**
 * Parses a service file into a `section → settings` map: INI-style `[name]` sections of
 * `key=value` pairs (split on the first `=`, both sides trimmed); blank and `#` lines are
 * ignored. Throws on a `key=value` line before any section, or a line that is neither a
 * section, comment, nor `key=value`.
 */
export function parseServicefile(contents: string): Map<string, Map<string, string>> {
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
 * Resolves a named service's settings from the service file at `servicefilePath`, remapping
 * `dbname` → `database`. Returns `undefined` when the file is missing/unreadable, malformed,
 * or has no matching section, so the caller can surface a parse failure rather than silently
 * falling through to defaults. The returned map may be empty (a section with no keys), which
 * is distinct from `undefined`.
 */
export function pgServiceSettings(
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
    services = parseServicefile(contents);
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
