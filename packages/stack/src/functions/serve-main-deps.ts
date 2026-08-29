/** Minimal runtime dependencies bundled into the Edge Runtime bootstrap. */
export const STATUS_CODE = {
  OK: 200,
  Unauthorized: 401,
  NotFound: 404,
  InternalServerError: 500,
  ServiceUnavailable: 503,
} as const;

export const STATUS_TEXT: Record<number, string> = {
  [STATUS_CODE.OK]: "OK",
  [STATUS_CODE.Unauthorized]: "Unauthorized",
  [STATUS_CODE.NotFound]: "Not Found",
  [STATUS_CODE.InternalServerError]: "Internal Server Error",
  [STATUS_CODE.ServiceUnavailable]: "Service Unavailable",
};

const normalize = (path: string): string => {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
      else if (!absolute) parts.push("..");
      continue;
    }
    parts.push(segment);
  }
  const joined = parts.join("/");
  return absolute ? `/${joined}` : joined || ".";
};

export const join = (...paths: string[]): string => normalize(paths.filter(Boolean).join("/"));

export const dirname = (path: string): string => {
  if (path.length === 0) return ".";
  let end = path.length;
  while (end > 1 && path[end - 1] === "/") end -= 1;
  const stripped = path.slice(0, end);
  const slash = stripped.lastIndexOf("/");
  if (slash < 0) return ".";
  if (slash === 0) return "/";
  return stripped.slice(0, slash);
};

export const toFileUrl = (path: string): URL => {
  if (!path.startsWith("/")) throw new TypeError("Path must be absolute");
  const url = new URL("file:///");
  url.pathname = path.replace(/%/g, "%25").replace(/\\/g, "%5C");
  return url;
};
