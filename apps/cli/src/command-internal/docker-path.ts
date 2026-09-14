/**
 * Translates an absolute host path to its in-container mount path: strips a Windows volume name
 * (`C:`) and converts backslashes to forward slashes.
 */
export function toDockerMountPath(absHostPath: string): string {
  const slashed = absHostPath.replaceAll("\\", "/");
  const volumeMatch = /^[A-Za-z]:/.exec(absHostPath);
  return volumeMatch === null ? slashed : slashed.slice(volumeMatch[0].length);
}
