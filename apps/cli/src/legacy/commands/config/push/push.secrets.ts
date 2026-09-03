/**
 * Secret-digest comparison and gating for `config push`'s auth service.
 *
 * The platform never reports a secret's plaintext, only an HMAC digest
 * (`changeSet.masked` — the registry's `isSecret` rows are omitted from the
 * ordinary diff). This module resolves, for every declared secret path,
 * whether its local value should be sent, is already unchanged, is empty/
 * unresolved, or is gated off because its owning container is disabled or
 * absent.
 */

import type { CliConfig, ProjectConfig } from "@supabase/config";
import { projectConfigMappingRows } from "@supabase/config/internal";

import { legacySecretHash, legacySecretPlaintext } from "./push.secret.ts";

export interface LegacyPushSecretDecision {
  /** Config path, e.g. `["auth","captcha","secret"]`. */
  readonly path: ReadonlyArray<string>;
  /** The Management API attribute key this secret reports its digest under. */
  readonly apiKey: string;
  readonly status: "send" | "unchanged" | "not_set" | "gated";
  /** Present only when `status === "send"`. */
  readonly plaintext?: string;
}

// Mirrors push.secret.ts's own (private) digest prefix — the two never drift
// apart since both read from the same `legacySecretHash` output.
const HASH_PREFIX = "hash:";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valueAtPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function samePath(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function findSecretApiKey(path: ReadonlyArray<string>): string | undefined {
  const row = projectConfigMappingRows.find(
    (candidate) => candidate.isSecret === true && samePath(candidate.configPath, path),
  );
  return row?.apiPath[1];
}

/**
 * A secret's parent container gates it: the container must be present in
 * `local` (the raw-presence-masked, disabled-sentinel-pruned projection) with
 * `enabled !== false`. Exact because `fromConfigDocument` has already applied
 * every gate a push would apply — the raw-presence mask, the disabled-
 * sentinel prune, and SMS-provider precedence.
 */
function isSecretGated(local: ProjectConfig, parentPath: ReadonlyArray<string>): boolean {
  const parent = valueAtPath(local, parentPath);
  if (!isRecord(parent)) return true;
  return parent["enabled"] === false;
}

export function legacyResolveAuthSecrets(input: {
  readonly maskedPaths: ReadonlyArray<ReadonlyArray<string>>;
  readonly config: CliConfig;
  readonly local: ProjectConfig;
  readonly remoteAuthAttributes: Readonly<Record<string, unknown>>;
  readonly projectRef: string;
  readonly dotenvPrivateKeys: ReadonlyArray<string>;
}): ReadonlyArray<LegacyPushSecretDecision> {
  const { maskedPaths, config, local, remoteAuthAttributes, projectRef, dotenvPrivateKeys } = input;
  const decisions: Array<LegacyPushSecretDecision> = [];

  for (const path of maskedPaths) {
    const apiKey = findSecretApiKey(path);
    if (apiKey === undefined) {
      continue;
    }

    const parentPath = path.slice(0, -1);
    if (isSecretGated(local, parentPath)) {
      decisions.push({ path, apiKey, status: "gated" });
      continue;
    }

    const rawValue = asString(valueAtPath(config, path)) ?? "";
    const digest = legacySecretHash(projectRef, rawValue, dotenvPrivateKeys);
    if (digest.length === 0) {
      decisions.push({ path, apiKey, status: "not_set" });
      continue;
    }

    const hex = digest.startsWith(HASH_PREFIX) ? digest.slice(HASH_PREFIX.length) : digest;
    const remoteValue = remoteAuthAttributes[apiKey];
    if (typeof remoteValue === "string" && remoteValue === hex) {
      decisions.push({ path, apiKey, status: "unchanged" });
      continue;
    }

    decisions.push({
      path,
      apiKey,
      status: "send",
      plaintext: legacySecretPlaintext(rawValue, dotenvPrivateKeys),
    });
  }

  return decisions;
}
