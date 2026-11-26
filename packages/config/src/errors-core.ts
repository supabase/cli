import type { RemovedConfigKey } from "./removed-config-keys-core.ts";

const lastTwoSegments = (path: string): string => path.split(/[\\/]/).slice(-2).join("/");

export function removedKeyMessage(
  path: string,
  removedKeys: ReadonlyArray<RemovedConfigKey>,
): string {
  const file = lastTwoSegments(path);
  const [only, ...rest] = removedKeys;
  if (only !== undefined && rest.length === 0) {
    return `${only.key} in ${file} is no longer supported. Use ${only.replacement} instead.`;
  }
  return [
    `${file} uses config keys that are no longer supported:`,
    ...removedKeys.map(({ key, replacement }) => `  ${key}: use ${replacement} instead.`),
  ].join("\n");
}

export function removedKeySuggestion(path: string): string {
  return `Update ${lastTwoSegments(path)}, then rerun the command.`;
}

export function fileConflictMessage(paths: ReadonlyArray<string>): string {
  return `Found both ${paths.map(lastTwoSegments).join(" and ")}. Keep one and delete the other.`;
}

export function schemaVersionMessage(
  path: string,
  declaredVersion: string,
  supportedVersion: number,
): string {
  return `${lastTwoSegments(path)} declares config schema v${declaredVersion}, but this version of the Supabase CLI only reads up to v${supportedVersion}. Upgrade the Supabase CLI to use this config.`;
}
