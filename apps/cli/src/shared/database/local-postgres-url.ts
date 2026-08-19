const formatPostgresHost = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const localPostgresConnectionString = (
  port: number,
  password: string,
  host = "127.0.0.1",
): string =>
  `postgresql://postgres:${encodeURIComponent(password)}@${formatPostgresHost(host)}:${port}/postgres`;

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null;
}

/**
 * Host port published for container Postgres (`5432/tcp`) from Docker inspect
 * `NetworkSettings.Ports`. Ownership is the named container; this only reads
 * the port that container actually published (which may not be 54322).
 */
export const publishedPostgresHostPort = (ports: unknown): number | undefined => {
  if (!isRecord(ports)) return undefined;
  const bindings = ports["5432/tcp"];
  if (!Array.isArray(bindings) || bindings.length === 0) return undefined;
  const first = bindings[0];
  if (!isRecord(first)) return undefined;
  const hostPort = first["HostPort"];
  if (typeof hostPort !== "string" && typeof hostPort !== "number") return undefined;
  const port = typeof hostPort === "number" ? hostPort : Number(hostPort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
};
