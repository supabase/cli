import type { ConfigChange } from "@supabase/config";

import { formatNamedRef, sanitizeInlineName } from "../../../command-internal/http-errors.ts";
import {
  configPlural,
  configRenderChangeLines,
  configRenderPath,
  configRenderValue,
  type ConfigApiScope,
} from "../config.format.ts";
import type { ConfigPushTarget } from "./push.branch-target.ts";
import { comparePaths, pathIn } from "./push.paths.ts";
import { PUSH_RESOURCES, pushResponseBlock, type PushResource } from "./push.plan.ts";
import type { PushSecretReport } from "./push.secrets.ts";

/** Response blocks `config push` writes to, derived from `PUSH_RESOURCES` so a block only
 *  `config diff`/`config pull` care about never inflates the "not returned" caveat below. */
const PUSH_RESPONSE_BLOCKS: ReadonlySet<string> = new Set(
  PUSH_RESOURCES.map((resource) => pushResponseBlock(resource)),
);

/**
 * Pure formatters and payload builders for `config push` — no Effect, no services,
 * unit-testable in isolation.
 *
 * Every value interpolated into text output goes through `configRenderPath`/`sanitizeInlineName`,
 * since path segments come from unconstrained declared config keys and could otherwise inject
 * ANSI escapes. Secret values never reach this module: inputs are always `PushSecretReport`,
 * which omits `plaintext`.
 */

/** A declared change this encoder could not structurally express, with why. */
export interface PushUnencodable {
  readonly path: ReadonlyArray<string>;
  readonly reason: string;
}

/** A template/notification body this encoder sent that has no registry row of its own. */
interface PushExtra {
  readonly path: ReadonlyArray<string>;
  readonly label: "content";
}

/** An undeclared companion value sent alongside a declared change, at its config default. */
export interface PushForced {
  readonly path: ReadonlyArray<string>;
  readonly value: unknown;
}

const PUSH_UPDATING_PREFIX: Readonly<Record<PushResource, string>> = {
  api: "Updating API service with config:",
  "db.settings": "Updating DB service with config:",
  "db.network_restrictions": "Updating network restrictions with config:",
  "db.ssl_enforcement": "Updating SSL enforcement with config:",
  auth: "Updating Auth service with config:",
  storage: "Updating Storage service with config:",
};

const RESOURCE_DISPLAY_NAME: Readonly<Record<PushResource, string>> = {
  api: "API",
  "db.settings": "DB",
  "db.network_restrictions": "DB Network restrictions",
  "db.ssl_enforcement": "DB SSL enforcement",
  auth: "Auth",
  storage: "Storage",
};

/** Re-sorts entries the handler concatenates across resources (`pushNotes`/`pushPayload`); each
 *  encoder already sorts its own list, but concatenation is in push order, not path order. */
function sortByPath<T extends { readonly path: ReadonlyArray<string> }>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return [...entries].sort((a, b) => comparePaths(a.path, b.path));
}

/** One `<path> [<label>]` / `local:` / `remote:` block, always ending in a blank line, matching
 *  `configRenderChangeLines`'s shape so the two can be concatenated without blank-line drift. */
function renderBlock(
  path: ReadonlyArray<string>,
  label: string,
  local: string,
  remote: string,
): string {
  return `${configRenderPath(path)} [${label}]\n  local:  ${local}\n  remote: ${remote}\n\n`;
}

/**
 * `[secret]` blocks, rendered before the confirmation prompt so a credential that won't be sent
 * is disclosed alongside one that will. A `send` status alone doesn't mean the secret reached the
 * request body — check `secretsEncoded`, since its container can still drop it as unencodable.
 */
function renderSecretBlocks(
  secrets: ReadonlyArray<PushSecretReport>,
  secretsEncoded: ReadonlyArray<ReadonlyArray<string>>,
): string {
  return secrets
    .map((secret) => {
      if (secret.status === "send") {
        if (!pathIn(secret.path, secretsEncoded)) {
          return renderBlock(
            secret.path,
            "secret",
            "(set)",
            "(not pushed — its group could not be encoded)",
          );
        }
        return renderBlock(
          secret.path,
          "secret",
          "(set)",
          secret.remoteState === "absent" ? "(not set)" : "(set — differs)",
        );
      }
      if (secret.status === "not_set") {
        return renderBlock(
          secret.path,
          "secret",
          "(not set — empty or unresolved env reference; will not be pushed)",
          secret.remoteState === "absent" ? "(not set)" : "(set)",
        );
      }
      return "";
    })
    .join("");
}

/** `[content]` blocks for template/notification bodies with no registry row of their own. */
function renderExtraBlocks(extras: ReadonlyArray<PushExtra>): string {
  return extras
    .map((extra) =>
      renderBlock(extra.path, "content", "(file content from content_path)", "(differs)"),
    )
    .join("");
}

/** `[group-write]` blocks — an undeclared companion the target endpoint required alongside a
 *  declared change, sent at its config schema default since the remote returned no current value
 *  (see `pushNotes`'s matching note). */
function renderForcedBlocks(forced: ReadonlyArray<PushForced>): string {
  return forced
    .map((entry) =>
      renderBlock(
        entry.path,
        "group-write",
        `${configRenderValue(entry.value, "(unset)")} (schema default — not declared in config.toml)`,
        "(not returned)",
      ),
    )
    .join("");
}

export interface PushUpdatingLineInput {
  readonly resource: PushResource;
  /** The routed changes this write actually communicated, already narrowed by the caller. */
  readonly changes: ReadonlyArray<ConfigChange>;
  /** Only `send`/`not_set` entries render. Callers with no secrets pass `[]`. */
  readonly secrets: ReadonlyArray<PushSecretReport>;
  /** Paths the request body actually placed a plaintext for. A `send` decision whose path is
   *  absent here renders as not sent (see `renderSecretBlocks`). */
  readonly secretsEncoded: ReadonlyArray<ReadonlyArray<string>>;
  readonly extras: ReadonlyArray<PushExtra>;
  readonly forced: ReadonlyArray<PushForced>;
}

/**
 * The `Updating <resource> service with config:` block for a resource with at least one pushable
 * difference. `changes` renders through the same per-property format `config diff` uses; the
 * combined block always ends on a blank line.
 */
export function pushUpdatingLine(input: PushUpdatingLineInput): string {
  return (
    `${PUSH_UPDATING_PREFIX[input.resource]}\n` +
    configRenderChangeLines(input.changes) +
    renderSecretBlocks(input.secrets, input.secretsEncoded) +
    renderExtraBlocks(input.extras) +
    renderForcedBlocks(input.forced)
  );
}

/** The `Remote <resource> config is up to date.` line — no pushable difference existed. */
export function pushUpToDateLine(resource: PushResource): string {
  return `Remote ${RESOURCE_DISPLAY_NAME[resource]} config is up to date.\n`;
}

/**
 * The `Remote <resource> config has N difference(s) config push cannot write...` line — every
 * pushable difference ended up `unencodable`, so nothing was written and no prompt ran.
 */
export function pushNotPushableLine(resource: PushResource, count: number): string {
  return `Remote ${RESOURCE_DISPLAY_NAME[resource]} config has ${configPlural(count, "difference", "differences")} config push cannot write (see notes below).\n`;
}

export interface PushNotesInput {
  /** Declared paths with no Management API field at all — the fixed unsupported-prefix list
   *  (`db.pooler.*`, `db.major_version`). */
  readonly unsupported: ReadonlyArray<ReadonlyArray<string>>;
  /** Declared paths an encoder could not structurally express, with why. */
  readonly unencodable: ReadonlyArray<PushUnencodable>;
  /** Count of `changeSet.unmanaged` entries not already covered by a disabled resource's own
   *  `disabled` status — count only; the full list stays in the payload. */
  readonly unmanagedCount: number;
  /** Undeclared companion values actually written at their config default (only from resources
   *  whose write ran). */
  readonly forced: ReadonlyArray<PushForced>;
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
export function pushNotes(input: PushNotesInput): string {
  const lines: Array<string> = [];

  if (input.unsupported.length > 0) {
    const n = input.unsupported.length;
    lines.push(
      `Note: ${configPlural(n, "declared property", "declared properties")} ${n === 1 ? "has" : "have"} no Management API field and ${n === 1 ? "was" : "were"} not pushed: ${input.unsupported.map(configRenderPath).join(", ")} (change ${n === 1 ? "it" : "them"} from the dashboard).`,
    );
  }

  if (input.unencodable.length > 0) {
    const n = input.unencodable.length;
    const rendered = sortByPath(input.unencodable)
      .map((entry) => `${configRenderPath(entry.path)} (${entry.reason})`)
      .join(", ");
    lines.push(
      `Note: ${configPlural(n, "declared property", "declared properties")} could not be encoded and ${n === 1 ? "was" : "were"} not pushed: ${rendered}`,
    );
  }

  if (input.unmanagedCount > 0) {
    const n = input.unmanagedCount;
    lines.push(
      `Note: ${configPlural(n, "declared property", "declared properties")} ${n === 1 ? "is" : "are"} not managed by config push and ${n === 1 ? "was" : "were"} not compared; run \`supabase config diff\` to list them.`,
    );
  }

  if (input.forced.length > 0) {
    const n = input.forced.length;
    const rendered = sortByPath(input.forced)
      .map((entry) => configRenderPath(entry.path))
      .join(", ");
    lines.push(
      `Note: ${configPlural(n, "undeclared property", "undeclared properties")} had to be sent alongside a declared change and ${n === 1 ? "was" : "were"} written at ${n === 1 ? "its" : "their"} config default: ${rendered} (the values shown in the confirmation block were applied).`,
    );
  }

  if (input.secretsNotSet.length > 0) {
    const n = input.secretsNotSet.length;
    lines.push(
      `Note: ${configPlural(n, "credential value", "credential values")} ${n === 1 ? "was" : "were"} not pushed (empty or unresolved env reference): ${input.secretsNotSet.map(configRenderPath).join(", ")}`,
    );
  }

  if (input.remoteOnly > 0) {
    const n = input.remoteOnly;
    lines.push(
      `Note: ${configPlural(n, "remote property", "remote properties")} ${n === 1 ? "is" : "are"} not declared in supabase/config.toml and ${n === 1 ? "was" : "were"} left unchanged (config push no longer resets undeclared properties to their defaults; run \`supabase config diff\` to inspect).`,
    );
  }

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

interface PushPayloadServiceResult {
  readonly service: string;
  readonly status: string;
  readonly changes: ReadonlyArray<ReadonlyArray<string>>;
}

export interface PushPayloadInput {
  readonly projectRef: string;
  readonly services: ReadonlyArray<PushPayloadServiceResult>;
  /** Same set `pushNotes`'s first note reports — unfiltered. */
  readonly unsupported: ReadonlyArray<ReadonlyArray<string>>;
  readonly unencodable: ReadonlyArray<PushUnencodable>;
  readonly forced: ReadonlyArray<PushForced>;
  /** `changeSet.unmanaged`, unfiltered — the note above is count-only, the payload keeps the
   *  full list. */
  readonly unmanaged: ReadonlyArray<ReadonlyArray<string>>;
  /** Gate-filtered count matching `pushNotes`'s note, so the summary sentence agrees with the
   *  stderr note even though `unmanaged` above stays unfiltered. */
  readonly unmanagedCount: number;
  /** Every declared secret's decision, unfiltered — partitions `changeSet.masked` across all six
   *  buckets below. */
  readonly secrets: ReadonlyArray<PushSecretReport>;
  /** Whether the auth write ran — decides whether a `status: "send"` secret lands in
   *  `sent`/`unencodable` or `skipped`; reports what was observed, not the pre-prompt decision. */
  readonly authWriteRan: boolean;
  /** The auth encoder's own `secretsEncoded` — paths a write actually placed a plaintext for. A
   *  `send` decision can still be dropped as `unencodable`, so `sent` reads from here rather than
   *  the raw decision list. Meaningful only when `authWriteRan`. */
  readonly secretsSent: ReadonlyArray<ReadonlyArray<string>>;
  /** Addon cost prompts (`auth_mfa_phone`, `auth_mfa_web_authn`) declined this run. */
  readonly declinedAddons: ReadonlyArray<string>;
  readonly remoteOnly: number;
  readonly scope: ConfigApiScope;
}

/**
 * One-line json/stream-json `message` summarizing what a push did, with a caveat sentence
 * appended for anything withheld, so an agent echoing `.message` never reports success while a
 * declared property went unpushed.
 */
export function pushSummaryMessage(input: PushPayloadInput): string {
  const updated = input.services.filter((service) => service.status === "updated");
  let base: string;
  if (updated.length > 0) {
    const n = updated.reduce((sum, service) => sum + service.changes.length, 0);
    base = `${configPlural(n, "property", "properties")} pushed to ${sanitizeInlineName(input.projectRef)}.`;
  } else if (
    input.unsupported.length === 0 &&
    input.unencodable.length === 0 &&
    input.services.every(
      (service) => service.status === "up_to_date" || service.status === "disabled",
    )
  ) {
    base = "Nothing to push: the project already matches the declared properties.";
  } else {
    base = "Nothing was pushed.";
  }

  const parts = [base];

  const unpushable = input.unsupported.length + input.unencodable.length;
  if (unpushable > 0) {
    parts.push(
      `${configPlural(unpushable, "declared property", "declared properties")} could not be pushed.`,
    );
  }

  if (input.unmanagedCount > 0) {
    const n = input.unmanagedCount;
    parts.push(
      `${configPlural(n, "declared property", "declared properties")} ${n === 1 ? "is" : "are"} not managed by config push.`,
    );
  }

  const missingPushBlocks = input.scope.missing.filter((block) => PUSH_RESPONSE_BLOCKS.has(block));
  if (missingPushBlocks.length > 0) {
    const n = missingPushBlocks.length;
    parts.push(
      `${configPlural(n, "block", "blocks")} ${n === 1 ? "was" : "were"} not returned by the API.`,
    );
  }

  const skipped = input.services.filter((service) => service.status === "skipped").length;
  if (skipped > 0) {
    parts.push(
      `${configPlural(skipped, "service", "services")} ${skipped === 1 ? "was" : "were"} skipped at the prompt.`,
    );
  }

  const notSet = input.secrets.filter((secret) => secret.status === "not_set").length;
  if (notSet > 0) {
    parts.push(
      `${configPlural(notSet, "credential value", "credential values")} ${notSet === 1 ? "was" : "were"} not pushed.`,
    );
  }

  if (input.declinedAddons.length > 0) {
    parts.push(
      `${configPlural(input.declinedAddons.length, "add-on prompt", "add-on prompts")} declined.`,
    );
  }

  return parts.join(" ");
}

/**
 * The structured result for `--output-format json|stream-json`.
 *
 * `project_ref`/`services[].service`/`services[].status` are the established contract;
 * everything else is additive. Paths are segment arrays since a record key may itself contain a
 * `.`.
 */
export function pushPayload(input: PushPayloadInput): Record<string, unknown> {
  const byStatus = (status: PushSecretReport["status"]) =>
    input.secrets.filter((secret) => secret.status === status).map((secret) => secret.path);
  const sendDecisions = input.secrets.filter((secret) => secret.status === "send");

  return {
    schema_version: 1,
    project_ref: input.projectRef,
    services: input.services.map((service) => ({
      service: service.service,
      status: service.status,
      changes: service.changes,
    })),
    unsupported: input.unsupported,
    unencodable: sortByPath(input.unencodable).map((entry) => ({
      path: entry.path,
      reason: entry.reason,
    })),
    forced: sortByPath(input.forced).map((entry) => ({ path: entry.path, value: entry.value })),
    unmanaged: input.unmanaged,
    secrets: {
      sent: input.authWriteRan ? input.secretsSent : [],
      unchanged: byStatus("unchanged"),
      not_set: byStatus("not_set"),
      gated: byStatus("gated"),
      // A `send` decision whose container was dropped as unencodable even though the write ran —
      // distinct from `skipped`, where the write itself never ran.
      unencodable: input.authWriteRan
        ? sendDecisions
            .map((secret) => secret.path)
            .filter((path) => !pathIn(path, input.secretsSent))
        : [],
      skipped: input.authWriteRan ? [] : sendDecisions.map((secret) => secret.path),
    },
    declined_addons: input.declinedAddons,
    remote_only: input.remoteOnly,
    scope: { present: input.scope.present, missing: input.scope.missing },
  };
}

// Every interpolated ref/name goes through `formatNamedRef`, so an API-provided branch/project
// name can't inject ANSI/OSC/newline controls into the terminal.

/**
 * The target-echo block, printed to stderr before any further network call. The no-name
 * degradation shape (a project whose name could not be resolved) stays exactly
 * `Pushing config to project: <ref>`, pinned by existing tests.
 */
export function configPushTargetLines(target: ConfigPushTarget): string {
  if (target.kind === "project") {
    return `Pushing config to project: ${formatNamedRef(target.name, target.ref)}\n`;
  }
  if (target.kind === "unknown") {
    return `Pushing config to: ${sanitizeInlineName(target.ref)} (could not determine whether this is a branch or the main project)\n`;
  }

  const lines: Array<string> = [
    `Pushing config to branch: ${formatNamedRef(target.branch, target.ref)}`,
  ];
  if (target.parentRef !== undefined) {
    lines.push(`  Parent project: ${formatNamedRef(target.parentName, target.parentRef)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The confirmation-prompt label gating a branch push. Ends with a self-serve
 * hint (`--yes`) so a CI/agent log reading the declined prompt can fix the
 * invocation without digging through docs.
 */
export function configPushBranchPromptLabel(
  target: ConfigPushTarget & { readonly kind: "branch" },
): string {
  const ref = sanitizeInlineName(target.ref);
  const hint = " (skip this check with --yes)";
  return target.branch === undefined
    ? `Do you want to push config to branch ${ref}?${hint}`
    : `Do you want to push config to branch "${sanitizeInlineName(target.branch)}" (${ref})?${hint}`;
}

/** Additive machine-payload fields describing the resolved target. `is_branch` is omitted, not
 *  `false`, when the target couldn't be determined — an absent key is the correct "unknown"
 *  signal. */
export function configPushPayloadFields(target: ConfigPushTarget): {
  readonly is_branch?: boolean;
  readonly branch?: string;
  readonly parent_project_ref?: string;
} {
  if (target.kind === "unknown") {
    return {};
  }
  return {
    is_branch: target.kind === "branch",
    ...(target.kind === "branch" && target.branch !== undefined ? { branch: target.branch } : {}),
    ...(target.kind === "branch" && target.parentRef !== undefined
      ? { parent_project_ref: target.parentRef }
      : {}),
  };
}
