import { createHash } from "node:crypto";
import type { ServiceName, VersionManifest } from "@supabase/stack";

export interface PodManifest {
  readonly id: string;
  readonly versions: Partial<VersionManifest>;
  readonly services: Partial<Record<ServiceName, boolean>>;
  readonly flags: { readonly supautils: boolean };
  readonly ports: { readonly dbPort: number; readonly apiPort: number };
  readonly createdAt: string;
}

export const baseTemplateKey = (postgresVersion: string): string => `pg-${postgresVersion}`;

export const templateKey = (versions: Partial<VersionManifest>): string => {
  const canonical = JSON.stringify(
    Object.fromEntries(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b))),
  );
  return `tuple-${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
};
