/**
 * Where a worker is served.
 *
 * Every worker gets a path on the project's own API host, exactly like an Edge
 * Function — `<ref>.supabase.co/workers/v1/<name>` next to
 * `<ref>.supabase.co/functions/v1/<name>`. One host per project, one path per
 * worker: nothing per-worker is provisioned in DNS, so the URL is derived from
 * the name rather than returned by the API.
 */

/** Path prefix workers are served under, mirroring `functions/v1`. */
const WORKERS_PATH_PREFIX = "/workers/v1";

/** The canonical URL of a worker on its project's API host. */
export function workerUrl(projectRef: string, projectHost: string, name: string): string {
  return `https://${projectRef}.${projectHost}${WORKERS_PATH_PREFIX}/${name}`;
}
