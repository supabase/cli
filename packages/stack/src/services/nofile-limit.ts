// Raised from the daemon default so many concurrent Deno isolates can run
// (supabase/cli#5151).
const desiredNofile = 65536;

// `userLimits.open_files.hard` from a `process.report.getReport()` diagnostic
// report — a number or "unlimited". Narrowed structurally because getReport()
// is typed as a bare `object`.
export const hardNofileLimitFromReport = (report: unknown): number | undefined => {
  if (typeof report !== "object" || report === null || !("userLimits" in report)) return undefined;
  const userLimits = report.userLimits;
  if (typeof userLimits !== "object" || userLimits === null || !("open_files" in userLimits)) {
    return undefined;
  }
  const openFiles = userLimits.open_files;
  if (typeof openFiles !== "object" || openFiles === null || !("hard" in openFiles)) {
    return undefined;
  }
  const hard = openFiles.hard;
  return typeof hard === "number" && Number.isSafeInteger(hard) && hard > 0 ? hard : undefined;
};

const hostHardNofileLimit = (platformOs: string): number | undefined =>
  platformOs === "linux" ? hardNofileLimitFromReport(process.report?.getReport()) : undefined;

// Never request more than the host's own hard cap: sandboxed hosts cap it
// below 65536, their docker daemon shares the cap, and exceeding it fails the
// container start (CLI-2220). The process's limit is a proxy for the daemon's
// — exact only when they share a kernel and limits, so only Linux is clamped
// (elsewhere the daemon runs in a VM), and only downward: a client more
// constrained than its daemon yields a smaller fd budget, never a failed start.
export const clampNofileLimit = (hardLimit: number | undefined): number =>
  hardLimit === undefined ? desiredNofile : Math.min(desiredNofile, hardLimit);

export const edgeRuntimeNofileUlimit = (platformOs: string): string => {
  const limit = clampNofileLimit(hostHardNofileLimit(platformOs));
  return `nofile=${limit}:${limit}`;
};
