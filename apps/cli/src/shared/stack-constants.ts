export const defaultPublishableKey = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
export const defaultSecretKey = "sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz";
export const defaultJwtSecret = "super-secret-jwt-token-with-at-least-32-characters-long";

const desiredNofile = 65536;

const hardNofileLimitFromReport = (report: unknown): number | undefined => {
  if (typeof report !== "object" || report === null || !("userLimits" in report)) return undefined;
  const userLimits = report.userLimits;
  if (typeof userLimits !== "object" || userLimits === null || !("open_files" in userLimits))
    return undefined;
  const openFiles = userLimits.open_files;
  if (typeof openFiles !== "object" || openFiles === null || !("hard" in openFiles))
    return undefined;
  const hard = openFiles.hard;
  return typeof hard === "number" && Number.isSafeInteger(hard) && hard > 0 ? hard : undefined;
};

export interface EdgeRuntimeNofileUlimit {
  readonly arg: string;
  readonly limit: number;
  readonly clampWarning?: string;
}

export const edgeRuntimeNofileUlimit = (
  platformOs: string,
  hostHardLimit: number | undefined = platformOs === "linux"
    ? hardNofileLimitFromReport(process.report?.getReport())
    : undefined,
): EdgeRuntimeNofileUlimit => {
  const limit =
    hostHardLimit === undefined ? desiredNofile : Math.min(desiredNofile, hostHardLimit);
  return {
    arg: `nofile=${limit}:${limit}`,
    limit,
    ...(limit < desiredNofile
      ? {
          clampWarning: `Edge Runtime file descriptor limit lowered to ${limit}: the host's hard limit (ulimit -Hn) is below the default ${desiredNofile}. Heavy Edge Function workloads may exhaust file descriptors.`,
        }
      : {}),
  };
};

export const isDockerDaemonDownMessage = (message: string): boolean =>
  /docker|container engine|daemon/i.test(message) &&
  /not running|unavailable|cannot connect|down/i.test(message);
