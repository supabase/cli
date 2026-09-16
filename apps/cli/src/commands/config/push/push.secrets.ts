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

import { containerEnabled, samePath, valueAtPath } from "./push.paths.ts";
import { secretDigestHex, secretPlaintext } from "./push.secret.ts";

export interface PushSecretDecision {
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
 * {@link PushSecretDecision} with that field removed, for every
 * formatter entry point and payload field that renders/reports secrets.
 */
export type PushSecretReport = Omit<PushSecretDecision, "plaintext">;

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function findSecretApiKey(path: ReadonlyArray<string>): string | undefined {
  const row = projectConfigMappingRows.find(
    (candidate) => candidate.isSecret === true && samePath(candidate.configPath, path),
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

export function resolveAuthSecrets(input: {
  readonly maskedPaths: ReadonlyArray<ReadonlyArray<string>>;
  readonly config: CliConfig;
  readonly local: ProjectConfig;
  readonly remoteAuthAttributes: Readonly<Record<string, unknown>>;
  readonly projectRef: string;
  readonly dotenvPrivateKeys: ReadonlyArray<string>;
}): ReadonlyArray<PushSecretDecision> {
  const { maskedPaths, config, local, remoteAuthAttributes, projectRef, dotenvPrivateKeys } = input;
  const decisions: Array<PushSecretDecision> = [];

  for (const path of maskedPaths) {
    const apiKey = findSecretApiKey(path);
    if (apiKey === undefined) {
      continue;
    }
    const remoteState = remoteStateFor(remoteAuthAttributes, apiKey);

    // The secret's parent container gates it: it must be present in `local` with `enabled !==
    // false`. `fromConfigDocument` has already applied every relevant gate (raw-presence mask,
    // disabled-sentinel prune, SMS-provider precedence), so an undetermined container state
    // (absent, or `enabled` not a boolean) gates the secret too, never coerced into "eligible".
    const parentPath = path.slice(0, -1);
    if (containerEnabled(local, parentPath) !== true) {
      decisions.push({ path, apiKey, status: "gated", remoteState });
      continue;
    }

    const rawValue = asString(valueAtPath(config, path)) ?? "";
    const digest = secretDigestHex(projectRef, rawValue, dotenvPrivateKeys);
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
      plaintext: secretPlaintext(rawValue, dotenvPrivateKeys),
    });
  }

  return decisions;
}
