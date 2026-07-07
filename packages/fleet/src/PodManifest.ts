import { createHash } from "node:crypto";
import {
  fillServiceVersionManifest,
  type ServiceName,
  type VersionManifest,
} from "@supabase/stack";

export interface PodManifest {
  readonly id: string;
  readonly versions: Partial<VersionManifest>;
  readonly services: Partial<Record<ServiceName, boolean>>;
  readonly flags: { readonly supautils: boolean };
  readonly ports: { readonly dbPort: number; readonly apiPort: number };
  readonly createdAt: string;
}

const keyHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export const baseTemplateKey = (postgresVersion: string): string =>
  `pg-${keyHash(postgresVersion)}`;

export const templateKey = (
  versions: Partial<VersionManifest>,
  enabledServices: ReadonlyArray<ServiceName> = [],
): string => {
  const canonical = JSON.stringify({
    versions: Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b))),
    enabledServices: [...new Set(enabledServices)].sort((a, b) => a.localeCompare(b)),
  });
  return `tuple-${keyHash(canonical)}`;
};

export const resolveTemplateVersions = (
  versions: Partial<VersionManifest>,
  enabledServices: ReadonlyArray<ServiceName>,
): Partial<VersionManifest> => {
  const full = fillServiceVersionManifest(versions);
  const resolved: Partial<Record<ServiceName, string>> = { postgres: full.postgres };
  for (const service of new Set(enabledServices)) {
    resolved[service] = full[service];
  }
  return resolved;
};
