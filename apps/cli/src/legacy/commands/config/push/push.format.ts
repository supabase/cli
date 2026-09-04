import type { ConfigChange } from "@supabase/config";

import {
  legacyFormatNamedRef,
  legacySanitizeInlineName,
} from "../../../shared/legacy-http-errors.ts";
import {
  legacyConfigPlural,
  legacyConfigRenderChangeLines,
  legacyConfigRenderPath,
  legacyConfigRenderValue,
  type LegacyConfigApiScope,
} from "../config.format.ts";
import type { LegacyConfigPushTarget } from "./push.branch-target.ts";
import { legacyComparePaths } from "./push.paths.ts";
import {
  LEGACY_PUSH_RESOURCES,
  legacyPushResponseBlock,
  type LegacyPushResource,
} from "./push.plan.ts";
import type { LegacyPushSecretReport } from "./push.secrets.ts";

/** The v2 response blocks `config push` actually reads from — derived from `LEGACY_PUSH_RESOURCES`
 *  rather than a hand-kept list, so a block `config diff`/`config pull` care about but push never
 *  touches (`pooler`, `realtime`) never inflates the summary's "not returned" caveat. */
const PUSH_RESPONSE_BLOCKS: ReadonlySet<string> = new Set(
  LEGACY_PUSH_RESOURCES.map((resource) => legacyPushResponseBlock(resource)),
);

/**
 * Pure formatters and payload builders for `config push` — no Effect, no
 * services, unit-testable in isolation. Consumes only the shapes an
 * encoder's `LegacyPushEncoded` result carries (`encoded`/`unencodable`/
 * `extras`/`forced`, declared structurally below rather than imported, so
 * this module never depends on `push.encoders.ts`), `LegacyPushSecretReport`,
 * `LegacyPushResource`, and `../config.format.ts`'s shared helpers.
 *
 * Every non-constant string interpolated into TEXT output goes through
 * `legacyConfigRenderPath` (which itself sanitizes via
 * `legacySanitizeInlineName`) — path segments are unconstrained
 * declared-config-key strings (an `sms.test_otp` phone number, a
 * `[remotes.*]` name), so a hostile value could otherwise emit raw ANSI or
 * forge output lines. Secret VALUES never reach this module: every secret
 * input is typed `LegacyPushSecretReport` (`LegacyPushSecretDecision` with
 * `plaintext` omitted) — callers cannot even accidentally pass a plaintext
 * through.
 *
 * `service`/`LegacyPushResource` values are OPAQUE IDENTIFIERS (dotted keys
 * mirroring `config.toml` paths, plus the fixed `"experimental.webhooks"`),
 * never themselves a config path — never rendered through
 * `legacyConfigRenderPath`.
 */

/** A declared change this encoder could not structurally express, with why. */
export interface LegacyPushUnencodable {
  readonly path: ReadonlyArray<string>;
  readonly reason: string;
}

/** A template/notification body this encoder sent that has no registry row of its own. */
export interface LegacyPushExtra {
  readonly path: ReadonlyArray<string>;
  readonly label: "content";
}

/** An undeclared companion value sent alongside a declared change, at its config default. */
export interface LegacyPushForced {
  readonly path: ReadonlyArray<string>;
  readonly value: unknown;
}

const PUSH_UPDATING_PREFIX: Readonly<Record<LegacyPushResource, string>> = {
  api: "Updating API service with config:",
  "db.settings": "Updating DB service with config:",
  "db.network_restrictions": "Updating network restrictions with config:",
  "db.ssl_enforcement": "Updating SSL enforcement with config:",
  auth: "Updating Auth service with config:",
  storage: "Updating Storage service with config:",
};

const RESOURCE_DISPLAY_NAME: Readonly<Record<LegacyPushResource, string>> = {
  api: "API",
  "db.settings": "DB",
  "db.network_restrictions": "DB Network restrictions",
  "db.ssl_enforcement": "DB SSL enforcement",
  auth: "Auth",
  storage: "Storage",
};

/** Global path order, applied wherever entries from more than one resource's encoder output get
 * concatenated (`legacyPushNotes`/`legacyPushPayload`) — each encoder already sorts its OWN
 * `unencodable`/`forced` list, but the handler appends those lists across resources in push order,
 * not path order. */
function sortByPath<T extends { readonly path: ReadonlyArray<string> }>(
  entries: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return [...entries].sort((a, b) => legacyComparePaths(a.path, b.path));
}

/** One `<path> [<label>]` / `local:` / `remote:` block, always followed by a blank line — the
 * same shape `legacyConfigRenderChangeLines` uses for ordinary property changes, so appending any
 * mix of these directly after that renderer's output never introduces (or omits) a blank line. */
function renderBlock(
  path: ReadonlyArray<string>,
  label: string,
  local: string,
  remote: string,
): string {
  return `${legacyConfigRenderPath(path)} [${label}]\n  local:  ${local}\n  remote: ${remote}\n\n`;
}

/**
 * `[secret]` blocks — rendered BEFORE the confirmation prompt, so a credential
 * that will not be sent (`not_set`) is disclosed alongside one that will
 * (`send`), inside the same resource block. `unchanged`/`gated` decisions
 * never render (nothing changed, or the secret's container is off — already
 * silent the same way a `disabled` resource status is).
 */
function renderSecretBlocks(secrets: ReadonlyArray<LegacyPushSecretReport>): string {
  return secrets
    .map((secret) => {
      if (secret.status === "send") {
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
function renderExtraBlocks(extras: ReadonlyArray<LegacyPushExtra>): string {
  return extras
    .map((extra) =>
      renderBlock(extra.path, "content", "(file content from content_path)", "(differs)"),
    )
    .join("");
}

/** `[group-write]` blocks — an undeclared companion the target endpoint required alongside a
 * declared change, sent at its config schema default because the remote didn't return a current
 * value for it (see `legacyPushNotes`' matching note). */
function renderForcedBlocks(forced: ReadonlyArray<LegacyPushForced>): string {
  return forced
    .map((entry) =>
      renderBlock(
        entry.path,
        "group-write",
        `${legacyConfigRenderValue(entry.value, "(unset)")} (schema default — not declared in config.toml)`,
        "(not returned)",
      ),
    )
    .join("");
}

export interface LegacyPushUpdatingLineInput {
  readonly resource: LegacyPushResource;
  /** The routed changes this write actually communicated (already narrowed by the caller). */
  readonly changes: ReadonlyArray<ConfigChange>;
  /** The resource's full secret-decision list; only `send`/`not_set` entries render. Callers with
   *  no secrets (every resource but `auth`) simply pass `[]`. */
  readonly secrets: ReadonlyArray<LegacyPushSecretReport>;
  readonly extras: ReadonlyArray<LegacyPushExtra>;
  readonly forced: ReadonlyArray<LegacyPushForced>;
}

/**
 * The `Updating <resource> service with config:` block for a resource with at
 * least one pushable difference. `changes` renders through the same
 * per-property format `config diff` uses; secret/content/group-write blocks
 * follow, each in the same 3-line-plus-blank-line shape, so the combined
 * block always ends on a blank line (there is always at least one line item,
 * since callers only reach this when there is something to write).
 */
export function legacyPushUpdatingLine(input: LegacyPushUpdatingLineInput): string {
  return (
    `${PUSH_UPDATING_PREFIX[input.resource]}\n` +
    legacyConfigRenderChangeLines(input.changes) +
    renderSecretBlocks(input.secrets) +
    renderExtraBlocks(input.extras) +
    renderForcedBlocks(input.forced)
  );
}

/** The `Remote <resource> config is up to date.` line — no pushable difference existed. */
export function legacyPushUpToDateLine(resource: LegacyPushResource): string {
  return `Remote ${RESOURCE_DISPLAY_NAME[resource]} config is up to date.\n`;
}

/**
 * The `Remote <resource> config has N difference(s) config push cannot
 * write...` line — a pushable difference existed, but every one of it ended
 * up `unencodable` (`count`), so nothing was written and no prompt ran.
 */
export function legacyPushNotPushableLine(resource: LegacyPushResource, count: number): string {
  return `Remote ${RESOURCE_DISPLAY_NAME[resource]} config has ${legacyConfigPlural(count, "difference", "differences")} config push cannot write (see notes below).\n`;
}

export interface LegacyPushNotesInput {
  /** Declared paths with no Management API field at all — the fixed unsupported-prefix list
   *  (`db.pooler.*`, `auth.oauth_server.*`, `db.major_version`). */
  readonly unsupported: ReadonlyArray<ReadonlyArray<string>>;
  /** Declared paths an encoder could not structurally express, with why. */
  readonly unencodable: ReadonlyArray<LegacyPushUnencodable>;
  /** Count of `changeSet.unmanaged` entries NOT already covered by a disabled resource's own
   *  `Note:`-free `disabled` status — count only, the full list stays in the payload. */
  readonly unmanagedCount: number;
  /** Undeclared companion values actually written at their config default (only from resources
   *  whose write ran). */
  readonly forced: ReadonlyArray<LegacyPushForced>;
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
    const n = input.unsupported.length;
    lines.push(
      `Note: ${legacyConfigPlural(n, "declared property", "declared properties")} ${n === 1 ? "has" : "have"} no Management API field and ${n === 1 ? "was" : "were"} not pushed: ${input.unsupported.map(legacyConfigRenderPath).join(", ")} (change them from the dashboard).`,
    );
  }

  if (input.unencodable.length > 0) {
    const n = input.unencodable.length;
    const rendered = sortByPath(input.unencodable)
      .map((entry) => `${legacyConfigRenderPath(entry.path)} (${entry.reason})`)
      .join(", ");
    lines.push(
      `Note: ${legacyConfigPlural(n, "declared property", "declared properties")} could not be encoded and ${n === 1 ? "was" : "were"} not pushed: ${rendered}`,
    );
  }

  if (input.unmanagedCount > 0) {
    const n = input.unmanagedCount;
    lines.push(
      `Note: ${legacyConfigPlural(n, "declared property", "declared properties")} ${n === 1 ? "is" : "are"} not managed by config push and ${n === 1 ? "was" : "were"} not compared; run \`supabase config diff\` to list them.`,
    );
  }

  if (input.forced.length > 0) {
    const n = input.forced.length;
    const rendered = sortByPath(input.forced)
      .map((entry) => legacyConfigRenderPath(entry.path))
      .join(", ");
    lines.push(
      `Note: ${legacyConfigPlural(n, "undeclared property", "undeclared properties")} had to be sent alongside a declared change and ${n === 1 ? "was" : "were"} written at ${n === 1 ? "its" : "their"} config default: ${rendered} (the values shown in the confirmation block were applied).`,
    );
  }

  if (input.secretsNotSet.length > 0) {
    const n = input.secretsNotSet.length;
    lines.push(
      `Note: ${legacyConfigPlural(n, "credential value", "credential values")} ${n === 1 ? "was" : "were"} not pushed (empty or unresolved env reference): ${input.secretsNotSet.map(legacyConfigRenderPath).join(", ")}`,
    );
  }

  if (input.remoteOnly > 0) {
    const n = input.remoteOnly;
    lines.push(
      `Note: ${legacyConfigPlural(n, "remote property", "remote properties")} ${n === 1 ? "is" : "are"} not declared in supabase/config.toml and ${n === 1 ? "was" : "were"} left unchanged (config push no longer resets undeclared properties to their defaults; run \`supabase config diff\` to inspect).`,
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
  /** Same set `legacyPushNotes`'s first note reports — unfiltered. */
  readonly unsupported: ReadonlyArray<ReadonlyArray<string>>;
  readonly unencodable: ReadonlyArray<LegacyPushUnencodable>;
  readonly forced: ReadonlyArray<LegacyPushForced>;
  /** `changeSet.unmanaged`, unfiltered — the note above is count-only, the payload keeps the
   *  full list (including paths under a gated-off resource). */
  readonly unmanaged: ReadonlyArray<ReadonlyArray<string>>;
  /** Count of `unmanaged` entries NOT already covered by a disabled resource's own `disabled`
   *  status — the same gate-filtered count `legacyPushNotes`'s note reports, used here so the
   *  json/stream-json summary sentence agrees with the stderr note instead of counting the
   *  unfiltered `unmanaged` list, which the payload's own `unmanaged` field keeps in full. */
  readonly unmanagedCount: number;
  /** Every declared secret's decision, unfiltered — partitions `changeSet.masked` across all
   *  five buckets below (`gated` is now included, unlike the pre-fix-pass payload). */
  readonly secrets: ReadonlyArray<LegacyPushSecretReport>;
  /** Whether the auth resource's write actually ran — decides whether a `status: "send"` secret
   *  lands in `sent` (write ran) or `skipped` (declined, or auth not written for any other
   *  reason): the payload reports what was OBSERVED to happen, not the pre-prompt decision. */
  readonly authWriteRan: boolean;
  /** The auth encoder's own `secretsEncoded` — the secret paths a write actually placed a
   *  plaintext for. NOT every `status: "send"` decision: a container can carry a `send` decision
   *  and still end up dropped as `unencodable` (its group unresolvable), so `sent` must read from
   *  here rather than from the raw decision list — meaningful only when `authWriteRan`. */
  readonly secretsSent: ReadonlyArray<ReadonlyArray<string>>;
  /** Addon cost prompts (`auth_mfa_phone`, `auth_mfa_web_authn`) declined this run. */
  readonly declinedAddons: ReadonlyArray<string>;
  readonly remoteOnly: number;
  readonly scope: LegacyConfigApiScope;
}

/**
 * One-line json/stream-json `message` summarizing what a push did, with a
 * caveat sentence appended for anything withheld — modeled on
 * `legacyConfigDiffSummaryMessage` (`../diff/diff.format.ts`), so an agent
 * echoing `.message` never reports success while some declared property was
 * left unpushed. Caveats are appended in a fixed order, one sentence per
 * non-empty category.
 */
export function legacyPushSummaryMessage(input: LegacyPushPayloadInput): string {
  const updated = input.services.filter((service) => service.status === "updated");
  let base: string;
  if (updated.length > 0) {
    const n = updated.reduce((sum, service) => sum + service.changes.length, 0);
    base = `${legacyConfigPlural(n, "property", "properties")} pushed to ${legacySanitizeInlineName(input.projectRef)}.`;
  } else if (
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
      `${legacyConfigPlural(unpushable, "declared property", "declared properties")} could not be pushed.`,
    );
  }

  if (input.unmanagedCount > 0) {
    const n = input.unmanagedCount;
    parts.push(
      `${legacyConfigPlural(n, "declared property", "declared properties")} ${n === 1 ? "is" : "are"} not managed by config push.`,
    );
  }

  const missingPushBlocks = input.scope.missing.filter((block) => PUSH_RESPONSE_BLOCKS.has(block));
  if (missingPushBlocks.length > 0) {
    const n = missingPushBlocks.length;
    parts.push(
      `${legacyConfigPlural(n, "block", "blocks")} ${n === 1 ? "was" : "were"} not returned by the API.`,
    );
  }

  const skipped = input.services.filter((service) => service.status === "skipped").length;
  if (skipped > 0) {
    parts.push(
      `${legacyConfigPlural(skipped, "service", "services")} ${skipped === 1 ? "was" : "were"} skipped at the prompt.`,
    );
  }

  const notSet = input.secrets.filter((secret) => secret.status === "not_set").length;
  if (notSet > 0) {
    parts.push(
      `${legacyConfigPlural(notSet, "credential value", "credential values")} ${notSet === 1 ? "was" : "were"} not pushed.`,
    );
  }

  if (input.declinedAddons.length > 0) {
    parts.push(
      `${legacyConfigPlural(input.declinedAddons.length, "add-on prompt", "add-on prompts")} declined.`,
    );
  }

  return parts.join(" ");
}

/**
 * The structured result for `--output-format json|stream-json`.
 * `project_ref`/`services[].service`/`services[].status` keep the existing
 * contract; everything else is additive. Paths are segment arrays — a record
 * key may itself contain a `.`.
 */
export function legacyPushPayload(input: LegacyPushPayloadInput): Record<string, unknown> {
  const byStatus = (status: LegacyPushSecretReport["status"]) =>
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
      skipped: input.authWriteRan ? [] : sendDecisions.map((secret) => secret.path),
    },
    declined_addons: input.declinedAddons,
    remote_only: input.remoteOnly,
    scope: { present: input.scope.present, missing: input.scope.missing },
  };
}

// --- branch/project target detection (CLI-2168) -----------------------------
//
// Pure formatters and payload builders for `config push`'s target-echo and
// branch confirmation — no Effect, no services, unit-testable in isolation.
// Every interpolated ref/name goes through `legacyFormatNamedRef`
// (`legacySanitizeInlineName` underneath), so an API-provided branch/project
// name can't inject ANSI/OSC/newline controls into the terminal.

/**
 * The target-echo block, printed to stderr before any further network call.
 * Only the NO-NAME-AVAILABLE degradation shape — a plain project whose name
 * could not be resolved — stays byte-identical to the pre-CLI-2168
 * `Pushing config to project: <ref>` text (existing tests pin exactly that
 * shape). The plain-project SUCCESS path text is NOT byte-identical to the
 * old behavior: it now also shows the resolved name whenever one is
 * available, which for a real project is always, since `name` is a required
 * API field.
 */
export function legacyConfigPushTargetLines(target: LegacyConfigPushTarget): string {
  if (target.kind === "project") {
    return `Pushing config to project: ${legacyFormatNamedRef(target.name, target.ref)}\n`;
  }
  if (target.kind === "unknown") {
    return `Pushing config to: ${legacySanitizeInlineName(target.ref)} (could not determine whether this is a branch or the main project)\n`;
  }

  const lines: Array<string> = [
    `Pushing config to branch: ${legacyFormatNamedRef(target.branch, target.ref)}`,
  ];
  if (target.parentRef !== undefined) {
    lines.push(`  Parent project: ${legacyFormatNamedRef(target.parentName, target.parentRef)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The confirmation-prompt label gating a branch push. Ends with a self-serve
 * hint (`--yes`) so a CI/agent log reading the declined prompt can fix the
 * invocation without digging through docs.
 */
export function legacyConfigPushBranchPromptLabel(
  target: LegacyConfigPushTarget & { readonly kind: "branch" },
): string {
  const ref = legacySanitizeInlineName(target.ref);
  const hint = " (skip this check with --yes)";
  return target.branch === undefined
    ? `Do you want to push config to branch ${ref}?${hint}`
    : `Do you want to push config to branch "${legacySanitizeInlineName(target.branch)}" (${ref})?${hint}`;
}

/** Additive machine-payload fields describing the resolved target
 * (CLI-2168/CLI-2289). `is_branch` is omitted (not `false`) when the target
 * couldn't be determined at all — asserting `false` would be as dishonest as
 * asserting `true`; an absent key is the correct "we don't know" signal. */
export function legacyConfigPushPayloadFields(target: LegacyConfigPushTarget): {
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
