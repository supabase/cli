/**
 * Runtime dependencies inlined into the edge-runtime bootstrap template
 * (`serve.main.ts`). These replace the remote `deno.land/std` imports the template
 * used to resolve over the network on every container start, which broke
 * `functions serve` offline (supabase/supabase#45570).
 *
 * Kept as a normal, type-checked module so the path logic can be unit-tested; the
 * template imports it relatively and the build inlines it via the bundler.
 */

/** HTTP status codes used by the runtime template (subset of `deno.land/std/http/status.ts`). */
export const STATUS_CODE = {
  OK: 200,
  Unauthorized: 401,
  NotFound: 404,
  InternalServerError: 500,
  ServiceUnavailable: 503,
} as const;

/** Canonical reason phrases for the status codes the template renders. */
export const STATUS_TEXT: Record<number, string> = {
  [STATUS_CODE.OK]: "OK",
  [STATUS_CODE.Unauthorized]: "Unauthorized",
  [STATUS_CODE.NotFound]: "Not Found",
  [STATUS_CODE.InternalServerError]: "Internal Server Error",
  [STATUS_CODE.ServiceUnavailable]: "Service Unavailable",
};

/** Posix path normalization: collapse separators, resolve `.` and `..`. */
function normalize(path: string): string {
  const isAbsolute = path.startsWith("/");
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") {
        out.pop();
      } else if (!isAbsolute) {
        out.push("..");
      }
      continue;
    }
    out.push(segment);
  }
  const joined = out.join("/");
  if (isAbsolute) {
    return "/" + joined;
  }
  return joined === "" ? "." : joined;
}

/** Posix `join`: concatenate segments with a single separator and normalize. */
export function join(...paths: string[]): string {
  const joined = paths.filter((part) => part.length > 0).join("/");
  return joined === "" ? "." : normalize(joined);
}

/** Posix `dirname`: the directory portion of a path. */
export function dirname(path: string): string {
  if (path.length === 0) {
    return ".";
  }
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") {
    end -= 1;
  }
  const stripped = path.slice(0, end);
  const lastSlash = stripped.lastIndexOf("/");
  if (lastSlash === -1) {
    return ".";
  }
  if (lastSlash === 0) {
    return "/";
  }
  return stripped.slice(0, lastSlash);
}

function encodeWhitespace(value: string): string {
  return value.replace(
    /\s/g,
    (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()}`,
  );
}

/** Posix `toFileUrl`: convert an absolute path to a `file://` URL. */
export function toFileUrl(path: string): URL {
  if (!path.startsWith("/")) {
    throw new TypeError(`Path must be absolute: received "${path}"`);
  }
  const url = new URL("file:///");
  url.pathname = encodeWhitespace(path.replace(/%/g, "%25").replace(/\\/g, "%5C"));
  return url;
}
