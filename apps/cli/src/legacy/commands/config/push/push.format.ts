import type { ConfigChange } from "@supabase/config/internal";

import {
  legacyConfigDiffUnmanagedCaveat,
  legacyRenderConfigChangeLines,
  type LegacyConfigDiffScope,
} from "../diff/diff.format.ts";
import { legacySanitizeInlineName } from "../../../shared/legacy-http-errors.ts";

/**
 * Pure formatters and payload builders for `config push` — no Effect, no
 * services, unit-testable in isolation. Mirrors `diff/diff.format.ts`'s
 * shape: every non-constant string interpolated into TEXT output goes
 * through `legacySanitizeInlineName` (path segments are unconstrained
 * declared-config-key strings — an `sms.test_otp` phone number or a
 * `[remotes.*]` name — so a hostile value could otherwise emit raw ANSI or
 * forge output lines). Secret VALUES never reach this module: callers pass
 * only the `status`/`path` shell of a secret decision, never `plaintext`.
 */

// TODO(shard-3): import from ./push.plan.ts
export type LegacyPushResource =
  | "api"
  | "db.settings"
  | "db.network_restrictions"
  | "db.ssl_enforcement"
  | "auth"
  | "storage";

// TODO(shard-3): import from ./push.secrets.ts
export interface LegacyPushSecretDecision {
  readonly path: ReadonlyArray<string>;
  readonly apiKey: string;
  readonly status: "send" | "unchanged" | "not_set" | "gated";
  readonly plaintext?: string;
}

/** Display-only join — a change/secret path is segment-array everywhere else. */
function renderPath(path: ReadonlyArray<string>): string {
  return legacySanitizeInlineName(path.join("."));
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

const PUSH_UPDATING_PREFIX: Readonly<Record<LegacyPushResource, string>> = {
  api: "Updating API service with config:",
  "db.settings": "Updating DB service with config:",
  "db.network_restrictions": "Updating network restrictions with config:",
  "db.ssl_enforcement": "Updating SSL enforcement with config:",
  auth: "Updating Auth service with config:",
  storage: "Updating Storage service with config:",
};

const PUSH_UP_TO_DATE_LINE: Readonly<Record<LegacyPushResource, string>> = {
  api: "Remote API config is up to date.\n",
  "db.settings": "Remote DB config is up to date.\n",
  "db.network_restrictions": "Remote DB Network restrictions config is up to date.\n",
  "db.ssl_enforcement": "Remote DB SSL enforcement config is up to date.\n",
  auth: "Remote Auth config is up to date.\n",
  storage: "Remote Storage config is up to date.\n",
};

/**
 * The `[secret]` counterpart to `legacyRenderConfigChangeLines` — same
 * 4-line-per-entry, blank-line-separated shape, so appending it directly
 * after `legacyRenderConfigChangeLines`'s output (which already ends on a
 * single trailing `\n`) never introduces a spurious blank line. Only
 * `status === "send"` secrets render; the plaintext never appears, and
 * neither does the actual digest — both sides are fixed descriptive text.
 */
function renderSecretLines(secrets: ReadonlyArray<LegacyPushSecretDecision>): string {
  const lines: Array<string> = [];
  for (const secret of secrets) {
    if (secret.status !== "send") {
      continue;
    }
    lines.push(`${renderPath(secret.path)} [secret]`);
    lines.push("  local:  (set; differs from the remote digest)");
    lines.push("  remote: (digest)");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * The `Updating <resource> service with config:` block for a resource with
 * at least one pushable change. `changes` renders through the same
 * per-property format `config diff` uses; `secrets` is the resource's full
 * secret-decision list (only `send` entries render, so callers may pass an
 * unfiltered list — non-auth resources simply pass `[]`).
 */
export function legacyPushUpdatingLine(
  resource: LegacyPushResource,
  changes: ReadonlyArray<ConfigChange>,
  secrets: ReadonlyArray<LegacyPushSecretDecision>,
): string {
  return `${PUSH_UPDATING_PREFIX[resource]}\n${legacyRenderConfigChangeLines(changes)}${renderSecretLines(secrets)}`;
}

/** The `Remote <resource> config is up to date.` line for a resource with no pushable change. */
export function legacyPushUpToDateLine(resource: LegacyPushResource): string {
  return PUSH_UP_TO_DATE_LINE[resource];
}

export interface LegacyPushNotesInput {
  /** Pushable-class changes with no v1 write path (`plan.unsupported` ∪ every encoder's `unencodable`). */
  readonly unsupported: ReadonlyArray<ReadonlyArray<string>>;
  /** `changeSet.unmanaged` — declared paths the projection dropped, so push cannot express them either. */
  readonly unmanaged: ReadonlyArray<ReadonlyArray<string>>;
  /** Declared secrets gated to `status === "not_set"` (empty value or unresolved `env(...)`). */
  readonly secretsNotSet: ReadonlyArray<ReadonlyArray<string>>;
  /** `changeSet.counts.remote_only` — hands-off, informational only. */
  readonly remoteOnly: number;
}

/**
 * The stderr `Note:` block printed after the resource loop, one line per
 * non-empty category in this fixed order. `""` when there is nothing to
 * note.
 */
export function legacyPushNotes(input: LegacyPushNotesInput): string {
  const lines: Array<string> = [];
  if (input.unsupported.length > 0) {
    lines.push(
      `Note: ${plural(input.unsupported.length, "declared property", "declared properties")} cannot be pushed by config push: ${input.unsupported.map(renderPath).join(", ")}`,
    );
  }
  if (input.unmanaged.length > 0) {
    lines.push(`Note: ${legacyConfigDiffUnmanagedCaveat(input.unmanaged)}`);
  }
  if (input.secretsNotSet.length > 0) {
    const was = input.secretsNotSet.length === 1 ? "was" : "were";
    lines.push(
      `Note: ${plural(input.secretsNotSet.length, "credential value", "credential values")} ${was} not pushed (empty or unresolved env reference): ${input.secretsNotSet.map(renderPath).join(", ")}`,
    );
  }
  if (input.remoteOnly > 0) {
    const is = input.remoteOnly === 1 ? "is" : "are";
    const was = input.remoteOnly === 1 ? "was" : "were";
    lines.push(
      `Note: ${plural(input.remoteOnly, "remote property", "remote properties")} ${is} not declared in supabase/config.toml and ${was} left unchanged (run \`supabase config diff\` to inspect).`,
    );
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

export interface LegacyPushPayloadServiceResult {
  readonly service: string;
  readonly status: string;
  readonly changes: ReadonlyArray<ReadonlyArray<string>>;
}

export interface LegacyPushPayloadInput {
  readonly projectRef: string;
  readonly services: ReadonlyArray<LegacyPushPayloadServiceResult>;
  /** Pushable-class changes with no v1 write path — same set `legacyPushNotes` reports. */
  readonly unsupported: ReadonlyArray<ReadonlyArray<string>>;
  /** `changeSet.unmanaged`. */
  readonly unmanaged: ReadonlyArray<ReadonlyArray<string>>;
  /** Every declared secret's decision, unfiltered — bucketed by status below. `"gated"` decisions
   *  are omitted from every bucket: the secret's parent container is off, so there is nothing to
   *  report (the same silence a `disabled` resource status already carries). */
  readonly secrets: ReadonlyArray<LegacyPushSecretDecision>;
  /** `changeSet.counts.remote_only`. */
  readonly remoteOnly: number;
  readonly scope: LegacyConfigDiffScope;
}

/**
 * The structured result for `--output-format json|stream-json`.
 * `project_ref`/`services[].service`/`services[].status` keep the existing
 * contract; everything else is additive. Paths are segment arrays — a record
 * key may itself contain a `.`.
 */
export function legacyPushPayload(input: LegacyPushPayloadInput): Record<string, unknown> {
  const byStatus = (status: LegacyPushSecretDecision["status"]) =>
    input.secrets.filter((secret) => secret.status === status).map((secret) => secret.path);

  return {
    project_ref: input.projectRef,
    services: input.services.map((service) => ({
      service: service.service,
      status: service.status,
      changes: service.changes,
    })),
    unsupported: input.unsupported,
    unmanaged: input.unmanaged,
    secrets: {
      sent: byStatus("send"),
      unchanged: byStatus("unchanged"),
      not_sent: byStatus("not_set"),
    },
    remote_only: input.remoteOnly,
    scope: { present: input.scope.present, missing: input.scope.missing },
  };
}
