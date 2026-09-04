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

import { legacyContainerEnabled, legacySamePath, legacyValueAtPath } from "./push.paths.ts";
import { legacySecretDigestHex, legacySecretPlaintext } from "./push.secret.ts";

export interface LegacyPushSecretDecision {
  /** Config path, e.g. `["auth","captcha","secret"]`. */
  readonly path: ReadonlyArray<string>;
  /** The Management API attribute key this secret reports its digest under. */
  readonly apiKey: string;
  readonly status: "send" | "unchanged" | "not_set" | "gated";
  /**
   * Whether the remote reported a non-empty digest at `apiKey` — drives the
   * `[secret]` block's `remote:` line (`"absent"` renders "not set";
   * `"present"` (when `status` differs) renders "set — differs").
   */
  readonly remoteState: "absent" | "present";
  /** Present only when `status === "send"`. */
  readonly plaintext?: string;
}

/**
 * `push.format.ts` must never see a secret's plaintext — this is
 * {@link LegacyPushSecretDecision} with that field removed, for every
 * formatter entry point and payload field that renders/reports secrets.
 */
export type LegacyPushSecretReport = Omit<LegacyPushSecretDecision, "plaintext">;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function findSecretApiKey(path: ReadonlyArray<string>): string | undefined {
  const row = projectConfigMappingRows.find(
    (candidate) => candidate.isSecret === true && legacySamePath(candidate.configPath, path),
  );
  return row?.apiPath[1];
}

function remoteStateFor(
  remoteAuthAttributes: Readonly<Record<string, unknown>>,
  apiKey: string,
): "absent" | "present" {
  const value = remoteAuthAttributes[apiKey];
  return typeof value === "string" && value.length > 0 ? "present" : "absent";
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
    const remoteState = remoteStateFor(remoteAuthAttributes, apiKey);

    // The secret's parent container gates it: it must be present in `local`
    // with `enabled !== false`. Exact because `fromConfigDocument` has
    // already applied every gate a push would apply — the raw-presence
    // mask, the disabled-sentinel prune, and SMS-provider precedence. An
    // undetermined container state (absent, or `enabled` not a boolean)
    // gates the secret too — never coerced into "eligible".
    const parentPath = path.slice(0, -1);
    if (legacyContainerEnabled(local, parentPath) !== true) {
      decisions.push({ path, apiKey, status: "gated", remoteState });
      continue;
    }

    const rawValue = asString(legacyValueAtPath(config, path)) ?? "";
    const digest = legacySecretDigestHex(projectRef, rawValue, dotenvPrivateKeys);
    if (digest === undefined) {
      decisions.push({ path, apiKey, status: "not_set", remoteState });
      continue;
    }

    const remoteValue = remoteAuthAttributes[apiKey];
    if (typeof remoteValue === "string" && remoteValue === digest) {
      decisions.push({ path, apiKey, status: "unchanged", remoteState });
      continue;
    }

    decisions.push({
      path,
      apiKey,
      status: "send",
      remoteState,
      plaintext: legacySecretPlaintext(rawValue, dotenvPrivateKeys),
    });
  }

  return decisions;
}
