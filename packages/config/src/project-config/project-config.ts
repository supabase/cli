import { Schema, SchemaIssue } from "effect";
import type { CliConfig } from "../base.ts";
import { isObject } from "../config-document.ts";
import {
  formatProjectConfigParseErrorMessage,
  PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  ProjectConfigParseError,
} from "../errors.ts";
import { isSecretPath } from "../lib/secret-paths.ts";
import { deepFreeze, setOwnProperty, type DeepPartial, type EffectiveConfig } from "../sparse.ts";
import {
  ProjectConfigApiAttributesSchema,
  type ProjectConfigApiAttributes,
} from "./api-attributes.ts";
import { HOSTED_SECTION_KEYS, type HostedSectionKey } from "./hosted-sections.ts";
import { AUTH_HOOK_NAMES, unmappedSecretApiPaths } from "./registry-auth.ts";
import { expectString } from "./registry-row.ts";
import { projectConfigMappingRows } from "./registry.ts";

/**
 * A deeply-readonly JSON value — the shape of everything under
 * `_apiResponse`, which holds (a clone of) a parsed Management API JSON
 * payload and is recursively frozen at attach time. Typed recursively
 * readonly so no narrowing path reaches a mutable view: with plain `unknown`
 * values, `Array.isArray(...)` would narrow to a mutable array whose
 * `.push` compiles and then throws against the frozen runtime value. (A
 * programmatic `attachApiResponse` caller can technically hand over
 * non-JSON structured-cloneable values — Dates, Maps; those step outside
 * this type by their own choice, exactly like any other consumer-side
 * assertion.) One narrowing caveat no user-space type can close: the lib's
 * own `Array.isArray` guard is typed `arg is any[]`, so narrowing through it
 * yields a MUTABLE array view (microsoft/TypeScript#17002) whose `.push`
 * compiles and then throws against the frozen value — narrow with a
 * readonly-preserving guard (`(v): v is ReadonlyArray<ReadonlyJsonValue> =>
 * Array.isArray(v)`) instead.
 */
export type ReadonlyJsonValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<ReadonlyJsonValue>
  | { readonly [key: string]: ReadonlyJsonValue };

/**
 * The hosted-project subset of {@link CliConfig}: the sections a Management
 * API project-config response can speak for (`api`, `auth`, `db`,
 * `realtime`, `storage`, `workers`, `experimental`) — never the local-only
 * sections (`studio`, service ports, `edge_runtime`, `analytics`,
 * `[remotes.*]`, …) that only make sense for a checkout on disk
 * (`docs/cli-config-loading.md`'s vocabulary).
 *
 * Deliberately sparse (`DeepPartial`), not a fully-materialized `CliConfig`
 * with schema defaults filled in: an API response never mentions a section
 * or field it doesn't manage, and a `ProjectConfig` that flooded in schema
 * defaults for everything it didn't report would fabricate drift against a
 * local document that genuinely differs only where the API actually speaks
 * (CLI-2230's design rule). Sparseness is also what makes a `ProjectConfig`
 * usable as an operand of `subtractCliConfig`/`omitDefaultValues`
 * (`../sparse.ts`): those helpers take an {@link EffectiveConfig}, and a
 * `ProjectConfig` (minus `_apiResponse`, which those walks never see — see
 * below) is structurally assignable to it, since `EffectiveConfig` is
 * `DeepPartial<Omit<CliConfig, "remotes">>` and every key `ProjectConfig`
 * can carry is one of `CliConfig`'s non-`remotes` keys.
 *
 * `_apiResponse` follows ADR 0019: present only on a value built by
 * {@link fromApiProjectConfig} (never on one built by
 * {@link fromConfigDocument}), holding a deep-cloned, deep-frozen copy of the
 * raw, pre-mapping `data.attributes` object (frozen/cloned rather than
 * aliasing the caller's object: neither this package nor a caller can
 * accidentally mutate it after the fact). It is attached as a non-enumerable
 * property at runtime (rule 1), so it is invisible to every *serializer* —
 * `JSON.stringify`, object spread, `Object.assign`, `structuredClone` — and
 * to the structural walks in `../sparse.ts`, and is therefore never
 * persisted to a config file. Invisible to serializers is not invisible to
 * every possible inspection, though: a debug inspector that deliberately
 * shows non-enumerable own properties (e.g. Bun's `console.log`) still
 * prints it. Never log an API-sourced `ProjectConfig` directly — the raw
 * attributes can include an HMAC digest of a secret value. A caller that
 * loses `_apiResponse` across a spread/`structuredClone`/state-store
 * round-trip can re-attach it via {@link attachApiResponse}.
 *
 * The seven hosted-section keys above are a vocabulary-level ceiling, not a
 * per-field guarantee: they name every section a project-config response
 * *could* speak for, not how much of each section a given operand actually
 * does. `fromConfigDocument`'s operand (a `CliConfig`/`EffectiveConfig`) can
 * genuinely carry any field in any of the seven. `fromApiProjectConfig`'s
 * operand speaks for far fewer — `realtime` maps zero rows today (every field
 * is local dev-server tuning with no hosted counterpart, `./registry.ts`'s
 * comment on `realtime`), and `workers`/`experimental` have no v2
 * project-config API counterpart at all, so an API-sourced `ProjectConfig`
 * never carries those two keys regardless of what the remote project has
 * configured. A comparison consumer (CLI-2156) must restrict its comparison
 * to the fields both operands actually speak for, never treat one operand's
 * whole-section presence/absence as drift against the other's — that
 * granularity gap is not only whole-section: several record-entry and
 * optional-substruct fields the registry maps *unconditionally* (every
 * mailer template/notification row, `email.smtp.enabled`, every
 * `db.settings.*` row, `sessions.timebox`/`inactivity_timeout`,
 * `captcha.enabled`, …) appear on an API-sourced `ProjectConfig` even when a
 * local document never declared that sub-section at all, since the mapping
 * has no "the local document is silent here" signal to withhold on. Use
 * {@link comparableProjectConfigPaths}/{@link isComparableProjectConfigPath}
 * to restrict a comparison to exactly the fields `fromApiProjectConfig` can
 * actually speak for, rather than hand-maintaining an equivalent field list.
 * The gap runs the other direction too: `auth.oauth_server`, and
 * `storage.analytics`/`storage.vector` when disabled, ARE comparable paths
 * (`fromApiProjectConfig` maps them) that `fromConfigDocument` can be
 * silent on entirely, since push cannot communicate that state at all — see
 * ADR 0021's "unmanaged-by-push containers" family — so the same
 * both-operands-speak-for restriction applies symmetrically, not only for
 * the API arm's unconditional fields above.
 *
 * Per ADR 0021, a `ProjectConfig` value is NOT a verbatim projection of
 * whichever operand produced it — both {@link fromConfigDocument} and
 * {@link fromApiProjectConfig} canonicalize toward the state a `config push`
 * would actually converge on (SMS-provider push precedence, disabled-sentinel
 * pruning of gated siblings, duration/byte-size re-quantization, and more —
 * see that ADR for the full enumeration). A `ProjectConfig` built from a
 * document is therefore not a faithful rendering of what the user wrote in
 * their config file; see {@link fromConfigDocument}'s own docstring.
 *
 * Relatedly (CLI-2316), a document-sourced `ProjectConfig` never carries any
 * of the paths in {@link DOCUMENT_ONLY_LOCAL_PATHS} — ports, TLS/URL
 * overrides, `db.major_version`, the whole `db.pooler`/`db.migrations`/
 * `db.seed` subtrees, every config-side `realtime.*` field, and most of
 * `experimental.*` — even though each lives inside one of the seven hosted
 * sections above: none has a live hosted counterpart under any CLI command,
 * so a `ProjectConfig` describing "the state after push" has nothing to say
 * about them. This is an asymmetry between the two arms for `db.major_version`
 * and `db.pooler.{pool_mode,default_pool_size,max_client_conn}` specifically:
 * {@link fromApiProjectConfig} still maps those from the platform's real
 * (informational, unpushable-via-`config push`) Postgres version and
 * Supavisor settings, so an API-sourced `ProjectConfig` CAN carry them while
 * a document-sourced one never does.
 */
export type ProjectConfig = DeepPartial<Pick<CliConfig, HostedSectionKey>> & {
  // Readonly, recursively: the runtime value is deep-frozen
  // (attachFrozenApiResponse), so any compile-permitted mutation — a
  // top-level assignment or a `.push` on a narrowed nested array — would
  // throw a TypeError in this ESM package.
  readonly _apiResponse?: { readonly [key: string]: ReadonlyJsonValue };
};

/**
 * Deep-copies `value` (a hosted-section subtree rooted at `path`) at the
 * OBJECT level, dropping every leaf whose full path matches an `x-secret`
 * schema annotation (CLI-2230's secret-omission finding) OR is a member of
 * {@link DOCUMENT_ONLY_LOCAL_PATHS} (CLI-2316 — a field that lives inside a
 * hosted section but describes purely local dev-server behavior no
 * `config push` can ever act on): `fromConfigDocument`'s
 * input is a *decoded* `CliConfig`/`EffectiveConfig`, where `secret()`-annotated fields
 * (`../lib/env.ts`) hold plaintext or an unresolved `env(VAR)` literal, never
 * a `Redacted` wrapper (decode never redacts — only
 * `resolveCliConfigValue`/`resolveCliConfigSubtree`, `../project.ts`, do,
 * and only post-decode). Sharing the input subtree by reference, as this
 * function's predecessor did, would carry that plaintext straight onto the
 * returned `ProjectConfig` — and since `fromApiProjectConfig` never reports
 * an `x-secret` field's value (ADR 0019 rule 5, the API only ever returns an
 * HMAC digest), a document-sourced `ProjectConfig` that kept its secrets
 * would register as drift against the API-sourced side for every secret
 * field, which is worse than useless for a diff consumer. Arrays are copied
 * recursively, element by element — no schema validation runs on this
 * function's input, so a caller can still hand it an array of objects at any
 * path (`experimental.inspect.rules` was the one schema field shaped that
 * way, until CLI-2316 excluded the whole `experimental.inspect` subtree as
 * CLI-only — this branch stays defensive against object-shaped array
 * elements arriving through any future field or a loosely-typed caller), and
 * a merely-sliced container would alias them back to the (possibly frozen)
 * input, breaking the fresh-copy contract. No `x-secret` leaf in
 * `CliConfigSchema` sits inside an array, so
 * the secret-path walk carries through elements as a no-op; empty-record
 * *elements* are preserved (the empty-container prune applies only to record
 * children — arrays compare wholesale in `../sparse.ts`, so their contents
 * must survive verbatim).
 *
 * A child that stripping leaves as (or that already was) an empty plain
 * object is pruned from `result` entirely, rather than kept as `{}` litter:
 * a genuinely-empty container carries no comparable information either way
 * (nothing for a diff consumer to compare against), and left in place it is
 * exactly the kind of key `subtractCliConfig` keeps verbatim forever, since
 * a baseline that never declared that key at all treats `{}` the same as
 * any other "present" value (CLI-2230's secret-strip empty-container
 * finding). Pruning recurses back up through {@link fromConfigDocument}'s
 * own per-section loop too, so a hosted section that turns out to contain
 * nothing but secrets disappears from the projection outright instead of
 * surviving as an empty section. Arrays are exempt — `[]` is a meaningful,
 * explicit value (e.g. "no redirect URLs"), never litter from secret
 * stripping.
 */
function copyHostedValueWithoutSecrets(value: unknown, path: ReadonlyArray<string>): unknown {
  if (Array.isArray(value)) {
    // Elements are copied recursively too — this function's input is never
    // schema-validated, so an object-shaped array element is still reachable
    // (see this function's own docstring), and a merely-sliced container
    // would alias them back to the (possibly frozen) input, breaking the
    // fresh-copy contract. The path passes through unchanged: no x-secret
    // pattern descends through an array in the hosted schema today, and
    // empty-record *elements* are preserved (the empty-container prune below
    // applies only to record children — arrays compare wholesale, so their
    // contents must survive verbatim).
    return value.map((element) => copyHostedValueWithoutSecrets(element, path));
  }
  if (isObject(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (isSecretPath(childPath) || isDocumentOnlyLocalPath(childPath)) {
        continue;
      }
      const copied = copyHostedValueWithoutSecrets(child, childPath);
      // Prune only containers this copy itself EMPTIED (a secret-stripped
      // subtree, possibly cascading upward) — never one that was empty in the
      // input. An originally-empty object can be data: a record entry's value
      // is an empty struct by schema design (`storage.analytics.buckets`,
      // `storage.vector.buckets`), so `{ buckets: { reports: {} } }` must
      // keep its entry — the KEY is the information.
      if (
        isObject(copied) &&
        Object.keys(copied).length === 0 &&
        isObject(child) &&
        Object.keys(child).length > 0
      ) {
        continue;
      }
      setOwnProperty(result, key, copied);
    }
    return result;
  }
  return value;
}

/**
 * `fromConfigDocument`-ONLY exclusions (CLI-2316), applied by
 * {@link isDocumentOnlyLocalPath} inside {@link copyHostedValueWithoutSecrets}'s
 * object recursion, alongside {@link isSecretPath}. Every one of these fields
 * lives inside a {@link HOSTED_SECTION_KEYS} section, so the whole-section
 * copy would otherwise include it, but none can ever converge toward or
 * diverge from anything the platform holds via `config push` — verified by
 * tracing every `apps/cli/src/legacy/commands/config/push/config-sync/*.sync.ts`
 * mapper plus `seed buckets`, `db inspect`, `db schema declarative generate`,
 * and `start`'s local bootstrap. Projecting one would contradict
 * {@link fromConfigDocument}'s own "predicts the state AFTER pushing
 * `config`" contract. That said, this list mixes two different REASONS a
 * field can't converge, not one — most entries have no hosted concept behind
 * them at all, but `db.major_version` and 3 of `db.pooler`'s 5 fields name a
 * REAL, platform-owned hosted fact that `config push` simply has no write
 * path for (the API arm still reports it, read-only) — see those two
 * entries' own bullets below for the distinction:
 *
 * - `api.port`, `api.tls`, `api.external_url` — local Kong bind port/TLS
 *   termination/URL override. `apiToUpdateBody` (`api.sync.ts`) reads only
 *   `db_schema`/`db_extra_search_path`/`max_rows`; none of these three.
 * - `db.port`, `db.shadow_port`, `db.health_timeout` — local Postgres/
 *   shadow-DB bind ports and local health-check wait. None is referenced
 *   anywhere in `db.sync.ts`; a hosted project has no "port" (it's reached
 *   over a fixed HTTPS URL) and no CLI-configurable startup health check.
 * - `db.major_version` — selects which local Postgres Docker image to run.
 *   The REMOTE database's actual major version IS a real, platform-owned
 *   hosted fact — mapped separately by {@link fromApiProjectConfig} (the
 *   `database.major_version` row in `./registry.ts`, read-only reporting)
 *   — that mapping is correct and untouched by this list. This document-side
 *   field just isn't how you'd ever change it: there is no `config push`
 *   write path for a project's Postgres version at all, so the document arm
 *   has no comparable value to project.
 * - `db.pooler` — the WHOLE subtree (`enabled`, `port`, `pool_mode`,
 *   `default_pool_size`, `max_client_conn`), not just `port`: legacy
 *   `config-sync/` has no `pooler`/`pgbouncer`/`supavisor` reference
 *   anywhere — `db.pooler.*` is read exclusively by `start`'s local
 *   Supavisor bootstrap. The same `db.major_version` situation applies to 3
 *   of these 5 fields — {@link fromApiProjectConfig} DOES map
 *   `pool_mode`/`default_pool_size`/`max_client_conn` from real, read-only
 *   remote Supavisor state (`./registry.ts`), untouched here for the same
 *   reason; `enabled` and `port` have no hosted concept on either arm.
 * - `db.migrations`, `db.seed` — whole subtrees (their own children,
 *   `enabled`/`schema_paths`/`sql_paths`, never need listing separately: the
 *   container itself is skipped before this function ever recurses into
 *   them). Both describe how the LOCAL CLI behaves during `db push`/`db
 *   reset`, not anything about the hosted project — no matching API
 *   attribute exists for either.
 * - `realtime.enabled`, `realtime.ip_version`, `realtime.max_header_length`
 *   — every config-side `realtime` field, i.e. the whole section (see
 *   `./registry.ts`'s own comment on why the 12 real hosted `realtime.*` API
 *   attributes have no config-side counterpart in EITHER direction — this
 *   entry closes the document-arm half of that same gap). A `ProjectConfig`
 *   built from a document therefore never carries a POPULATED `realtime` key
 *   (pruned by the empty-section rule below whenever the document declares
 *   any of these 3 — a document that instead declares `realtime` itself
 *   empty, e.g. `{realtime: {}}`, still projects `{realtime: {}}` verbatim,
 *   same as any other section: pruning only fires on a container this
 *   function's OWN exclusion emptied, never one that started empty), matching
 *   `fromApiProjectConfig` already never carrying a populated one either.
 * - `experimental.orioledb_version`, `experimental.s3_host`,
 *   `experimental.s3_region` — local OrioleDB-with-S3 storage engine config
 *   (`experimental.s3_access_key`/`s3_secret_key` need no entry: both are
 *   already `x-secret`-stripped). `experimental.pgdelta`,
 *   `experimental.inspect` — whole subtrees, local `db diff`/`db pull`
 *   engine choice and `db inspect` query config respectively. Only
 *   `experimental.webhooks.enabled` in this section is genuinely pushed
 *   (`experimental.sync.ts` POSTs to enable database webhooks) and is
 *   deliberately NOT in this list.
 *
 * Deliberately NOT listed, despite looking like the same "local toggle"
 * shape as the entries above — each was checked against how `config push`
 * actually treats it, not excluded on the strength of its description alone:
 * `auth.enabled`/`storage.enabled` (kept: {@link DISABLED_SENTINEL_PRUNES}'s
 * `["auth"]`/`["storage"]` entries already deliberately preserve
 * `{enabled: false}` as a reviewed "is this section managed by push" signal,
 * PR #6339), `db.network_restrictions.enabled` (kept: the same deliberate
 * management-opt-out shape, CLI-2314's own ruling), `api.auto_expose_new_tables`
 * and `auth.third_party`/`auth.jwt_issuer`/`auth.signing_keys_path` (real
 * hosted concepts push either already sends or simply hasn't been wired to
 * send yet — a push-capability gap, not a CLI-only field), and
 * `storage.buckets` (real hosted state via `seed buckets --linked`, which
 * writes buckets onto the remote project through the Storage API — a
 * different write path than `config push`, but still hosted).
 *
 * `studio.*`/`inbucket.*` need no entry here despite being named in the
 * report this list is derived from (Slack, Ivan, 2026-09-03): neither
 * `studio` nor `local_smtp` (the config-side key `[inbucket]` normalizes to,
 * `../io.ts`) is a member of `HOSTED_SECTION_KEYS` at all, so both are
 * already excluded by construction — confirmed by this file's own "keeps
 * exactly the hosted sections" test.
 *
 * Exact-match only, no wildcard segments: unlike `../lib/secret-paths.ts`'s
 * patterns (which need a `"*"` segment for a dynamic `Schema.Record` key,
 * e.g. `db.vault.*`), every path below names a static struct field, so a
 * plain length-and-segment comparison is enough.
 */
export const DOCUMENT_ONLY_LOCAL_PATHS: ReadonlyArray<ReadonlyArray<string>> = [
  ["api", "port"],
  ["api", "tls"],
  ["api", "external_url"],
  ["db", "port"],
  ["db", "shadow_port"],
  ["db", "health_timeout"],
  ["db", "major_version"],
  ["db", "pooler"],
  ["db", "migrations"],
  ["db", "seed"],
  ["realtime", "enabled"],
  ["realtime", "ip_version"],
  ["realtime", "max_header_length"],
  ["experimental", "orioledb_version"],
  ["experimental", "s3_host"],
  ["experimental", "s3_region"],
  ["experimental", "pgdelta"],
  ["experimental", "inspect"],
];

function isDocumentOnlyLocalPath(path: ReadonlyArray<string>): boolean {
  return DOCUMENT_ONLY_LOCAL_PATHS.some(
    (excluded) =>
      excluded.length === path.length &&
      excluded.every((segment, index) => segment === path[index]),
  );
}

/**
 * Applies every registry row's `normalizeDocument` (`./registry-row.ts`) to
 * `output` in place, at `row.configPath`, after the secret-omitting copy
 * above has already run — CLI-2230's duration/byte-size finding. A row
 * without `normalizeDocument` is untouched; a row whose `configPath` is
 * absent from `output` is skipped (nothing to normalize); otherwise the
 * leaf is replaced with the row's canonicalized value — or REMOVED when the
 * canonicalizer returns `undefined` (unmanaged absence, e.g. an empty
 * `test_otp` map the push wrapper would omit), pruning any containers the
 * removal empties, consistent with the copy's own self-emptied-section rule.
 */
function applyDocumentNormalizations(output: Record<string, unknown>): void {
  for (const row of projectConfigMappingRows) {
    if (row.normalizeDocument === undefined) {
      continue;
    }
    const current = readPath(output, row.configPath);
    if (current === undefined) {
      continue;
    }
    const normalized = row.normalizeDocument(current);
    if (normalized === undefined) {
      removePathAndEmptiedAncestors(output, row.configPath);
    } else {
      writePath(output, row.configPath, normalized);
    }
  }
}

/**
 * Deletes the leaf at `path` from `output`, then walks back up deleting each
 * container the removal left empty — a normalization that withdraws the only
 * field of a section must not leave a bare `{}` behind, matching the
 * secret-omitting copy's treatment of sections it empties itself.
 */
function removePathAndEmptiedAncestors(
  output: Record<string, unknown>,
  path: ReadonlyArray<string>,
): void {
  const containers: Array<Record<string, unknown>> = [output];
  let cursor: Record<string, unknown> = output;
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment];
    if (!isObject(next)) {
      return;
    }
    containers.push(next);
    cursor = next;
  }
  for (let index = path.length - 1; index >= 0; index--) {
    const container = containers[index];
    const segment = path[index];
    if (container === undefined || segment === undefined) {
      return;
    }
    delete container[segment];
    if (Object.keys(container).length > 0 || index === 0) {
      return;
    }
  }
}

/**
 * A `{ config, document }` pair {@link fromConfigDocument} accepts as an
 * alternative to a bare {@link EffectiveConfig} (human review round on PR
 * #6339, thread 1): `document` is the raw, pre-decode document object
 * (`LoadedCliConfig.document`, `../config-document.ts` — post-`env()`,
 * remotes-merged, retained precisely so a caller can inspect key presence a
 * decoded value loses to schema defaults) and unlocks raw-presence masking
 * ({@link applyRawPresenceMask}) a bare `EffectiveConfig` operand cannot,
 * since decode has already erased the distinction between "the file
 * declared this with a default value" and "the file never mentioned this at
 * all". `LoadedCliConfig` is structurally assignable to this interface
 * WITHOUT a cast — its `config: CliConfig` fits `EffectiveConfig` (a
 * `CliConfig` is one), its `document?: Record<string, unknown>` matches
 * exactly. Declared independently rather than importing `LoadedCliConfig`
 * by name: not for pure-runtime-graph reasons (`config-document.ts` is
 * already reachable from this package's pure entrypoint, and this very file
 * already imports `isObject` from it), but so `fromConfigDocument`'s public
 * contract doesn't couple its parameter shape to the loader's own type name
 * — this type is local-checkout-side on its own terms (ADR 0020's `Cli*`
 * convention), independent of which loader happens to produce a matching
 * shape.
 */
export interface CliConfigWithRawPresence {
  readonly config: EffectiveConfig;
  readonly document?: Record<string, unknown>;
}

/**
 * Reads one property off the `{ config, document }` pair shape through the
 * same guarded boundary as the dispatcher's source reads
 * ({@link readSourceProperty}) and the envelope reads
 * ({@link readEnvelopeProperty}): plain data never carries getters, so an
 * accessor that throws here — e.g. `toProjectConfig({ cliConfig: { get
 * config() { throw ... } } })` — is programmatic caller input and must
 * surface as the documented failure type, not a raw `Error` escaping past
 * the telemetry classification (a bug an earlier round of this file left
 * open: the pair shape's own property reads were unguarded).
 */
function readConfigDocumentSourceProperty(input: Record<string, unknown>, key: string): unknown {
  try {
    return input[key];
  } catch (cause) {
    throw new ProjectConfigParseError({
      message: `reading "${key}" threw — fromConfigDocument's { config, document } pair must be plain data, not accessor-backed`,
      cause,
      reason: "caller_misuse",
    });
  }
}

/**
 * Unwraps the two shapes {@link fromConfigDocument} accepts: a bare
 * `EffectiveConfig` operand, or a {@link CliConfigWithRawPresence} pair.
 * Presence of an own `config` key decides which shape was intended — no key
 * on `CliConfigSchema` (`../base.ts`) is literally named `config`, so a real
 * decoded document can never collide with the pair shape today. Same
 * one-own-key shape-sniffing pattern as {@link unwrapApiResponse}'s envelope
 * detection below, including that function's own documented trade: a
 * hypothetical future top-level section literally named `config` would be
 * misread as the pair shape instead of a plain operand — closing that
 * off would need an explicit discriminator key, which would break every
 * existing bare-`EffectiveConfig` call site for a collision this
 * vanishingly unlikely.
 *
 * `document` is genuinely OPTIONAL — absent, or present with an explicit
 * `undefined` value, both mean "no masking" and are equally legal. A
 * PRESENT `document` that isn't a plain object (`null`, a string, an array,
 * …) is different: unlike absence, it's a caller handing over a value this
 * function cannot use, so it throws rather than silently degrading to
 * unmasked output with no signal that masking was skipped.
 */
function unwrapConfigDocumentSource(input: Record<string, unknown>): {
  readonly config: unknown;
  readonly document: Record<string, unknown> | undefined;
} {
  if (!Object.hasOwn(input, "config")) {
    return { config: input, document: undefined };
  }
  const config = readConfigDocumentSourceProperty(input, "config");
  if (!Object.hasOwn(input, "document")) {
    return { config, document: undefined };
  }
  const document = readConfigDocumentSourceProperty(input, "document");
  if (document === undefined) {
    return { config, document: undefined };
  }
  if (!isObject(document)) {
    throw callerMisuseError(
      `fromConfigDocument operand's "document" property must be an object when present, got ${nonObjectDescription(document)}`,
    );
  }
  return { config, document };
}

/**
 * Projects a {@link CliConfig} document (or any {@link EffectiveConfig}
 * operand — a full `CliConfig` is one) down to its hosted-section subset.
 * Copies each hosted section deeply and only when own-present on `config`,
 * omitting every `x-secret` leaf and every {@link DOCUMENT_ONLY_LOCAL_PATHS}
 * entry — a field with no live hosted counterpart under any CLI command, e.g.
 * `db.port`, `db.major_version`, `db.pooler`, `db.migrations`, `db.seed`, the
 * whole `realtime` section (both via {@link copyHostedValueWithoutSecrets};
 * CLI-2316) — and canonicalizing every field a registry row's
 * `normalizeDocument` covers ({@link applyDocumentNormalizations}) — parity
 * with
 * {@link fromApiProjectConfig}'s own secret omission and canonical
 * duration/byte-size spellings, so the same logical hosted config compares
 * equal regardless of which side produced it, and so this function never
 * leaks a document's plaintext secrets onto a value that will sit next to
 * an API-sourced `ProjectConfig` in a diff. The returned value is always a
 * fresh copy — safe to call even when `config` is frozen (e.g.
 * {@link getDefaultCliConfig}'s memo). Never attaches `_apiResponse`; that
 * only happens in {@link fromApiProjectConfig}. Throws
 * {@link ProjectConfigParseError} if a value at a normalized path is
 * malformed in a way `normalizeDocument` cannot tolerate — in practice this
 * should not happen, since every `normalizeDocument` implementation returns
 * its input verbatim rather than throwing.
 *
 * NOT a verbatim projection of `config` (ADR 0021): beyond secret omission
 * and per-field canonicalization, this function also applies
 * {@link applySmsProviderPrecedence} (a document enabling several SMS
 * providers converges on only the push-selected one staying `enabled`) and
 * {@link applyDisabledSentinels} (a disabled section/entry drops the sibling
 * fields the legacy push does not manage while it is off). The result
 * predicts what the hosted config will look like AFTER pushing `config`, not
 * `config`'s own declared hosted-section values — do not render it to a user
 * as "your local config".
 *
 * The convergence prediction is exact for a genuinely sparse `config` — one
 * that only carries the keys the caller means to speak for. It holds only
 * "exact modulo schema defaults" for a fully-materialized decoded document
 * passed BARE (the common case, since a full `CliConfig` is a valid
 * operand): decode cannot recover whether the raw file actually wrote a key
 * or merely inherited its schema default, a distinction the legacy push
 * pipeline DOES read (e.g. it emits only the external providers the raw
 * file declared, never every provider a decoded document defaults to).
 *
 * **This limit has a first-class remedy**: pass a {@link
 * CliConfigWithRawPresence} pair instead of a bare `config` — this is the
 * RECOMMENDED form whenever a `document` is available (i.e. whenever the
 * config came from `loadCliConfig` rather than being constructed in-memory,
 * e.g. `getDefaultCliConfig()`'s memo). With `document` present, this
 * function additionally applies {@link applyRawPresenceMask}, mirroring the
 * legacy push pipeline's own raw-presence gates
 * (`apps/cli/src/legacy/commands/config/push/push.raw-presence.ts`) exactly,
 * closing the gap for the fields those gates cover. Without `document`, this
 * function's behavior is unchanged, and a caller diffing its output against
 * a remote `ProjectConfig` should still first strip schema defaults with
 * `omitDefaultValues` and intersect to the fields both operands actually
 * speak for — see ADR 0021's "Limits" section for the verified boundary,
 * which fields the presence mask covers, and the residual drift categories
 * that remain deferred to CLI-2266 even with a `document` supplied.
 * `@supabase/config/io`'s `loadCliConfig` supplies a `document`;
 * `saveCliConfig`'s returned `LoadedCliConfig` does NOT (there is no raw
 * file being re-read on a save) — passing that result here silently falls
 * back to the un-remedied, bare-`config` behavior.
 */
export function fromConfigDocument(config: EffectiveConfig): ProjectConfig;
export function fromConfigDocument(loaded: CliConfigWithRawPresence): ProjectConfig;
// A third, union-typed overload purely for internal callers that already
// hold a `EffectiveConfig | CliConfigWithRawPresence` value (the dispatcher
// below): TypeScript does not distribute an overload set over a union-typed
// argument the way it does for a generic conditional type, so a call site
// typed exactly as the union needs a matching overload of its own — the two
// above stay the documented public contract for callers with a concrete
// operand type.
export function fromConfigDocument(
  source: EffectiveConfig | CliConfigWithRawPresence,
): ProjectConfig;
// The implementation signature stays untyped for the same reason as
// `subtractCliConfig` (`../sparse.ts`): TypeScript cannot verify that a
// structural pick over dynamically-iterated keys reconstructs a
// `ProjectConfig`; the overloads above are the contract, pinned by the unit
// tests.
export function fromConfigDocument(input: unknown): unknown {
  // A JavaScript caller can hand this public normalizer null/undefined/an
  // array despite the compile-time type; guarding before Object.hasOwn keeps
  // the failure inside the documented typed-error contract (with the
  // caller-misuse reason) instead of a native TypeError or a silent `{}`.
  if (!isObject(input)) {
    throw callerMisuseError(
      `fromConfigDocument operand must be an object, got ${nonObjectDescription(input)}`,
    );
  }
  const { config, document } = unwrapConfigDocumentSource(input);
  if (!isObject(config)) {
    // The OPERAND was an object (checked above) — it's specifically its
    // "config" property, in the { config, document } pair shape, that
    // isn't. A bare EffectiveConfig operand (no own "config" key) can never
    // reach this branch, since `config` is then `input` itself.
    throw callerMisuseError(
      `fromConfigDocument operand's "config" property must be an object, got ${nonObjectDescription(config)}`,
    );
  }
  const result: Record<string, unknown> = {};
  for (const key of HOSTED_SECTION_KEYS) {
    if (Object.hasOwn(config, key)) {
      // The section read AND the recursive copy both evaluate caller
      // properties (the copy via Object.entries at every depth), so a
      // throwing getter anywhere in the operand is translated here — plain
      // data never carries accessors, making this programmatic caller input.
      let section: unknown;
      let copied: unknown;
      try {
        section = config[key];
        copied = copyHostedValueWithoutSecrets(section, [key]);
      } catch (cause) {
        if (cause instanceof ProjectConfigParseError) {
          throw cause;
        }
        throw new ProjectConfigParseError({
          message: `reading document section "${key}" threw — fromConfigDocument operands must be plain data, not accessor-backed`,
          cause,
          reason: "caller_misuse",
        });
      }
      // Same emptied-by-the-copy prune as `copyHostedValueWithoutSecrets`'s
      // own recursion, applied at the section boundary: a section that turns
      // out to contain nothing but secrets must disappear from the projection
      // entirely, while a section the document genuinely declared empty
      // survives as declared.
      if (
        isObject(copied) &&
        Object.keys(copied).length === 0 &&
        isObject(section) &&
        Object.keys(section).length > 0
      ) {
        continue;
      }
      setOwnProperty(result, key, copied);
    }
  }
  applyDocumentNormalizations(result);
  applySmsProviderPrecedence(result);
  applyDisabledSentinels(result);
  applyPushUnmanagedOmissions(result);
  if (document !== undefined) {
    applyRawPresenceMask(result, document);
  }
  return result;
}

/**
 * DOCUMENT-arm only: at most one SMS provider can be live on the platform —
 * the push switch selects the FIRST enabled provider in its fixed order and
 * sends only that one (`switch (true)`, auth.sync.ts:2498-2539), so a
 * document enabling several providers converges, after any push, on a hosted
 * state where only the first is enabled. Later `enabled: true` flags flip to
 * `false` here, and the entry sweep in {@link applyDisabledSentinels} (which
 * runs next) prunes their siblings — matching what `fromApiProjectConfig`
 * reports for that hosted state. The API arm never needs this: its five
 * flags all derive from the single `sms_provider` discriminator.
 */
export const SMS_PROVIDER_PUSH_PRECEDENCE = [
  "twilio",
  "twilio_verify",
  "messagebird",
  "textlocal",
  "vonage",
] as const;

function applySmsProviderPrecedence(result: Record<string, unknown>): void {
  const sms = readPath(result, ["auth", "sms"]);
  if (!isObject(sms)) {
    return;
  }
  let selected = false;
  for (const provider of SMS_PROVIDER_PUSH_PRECEDENCE) {
    const entry = sms[provider];
    if (!isObject(entry) || entry["enabled"] !== true) {
      continue;
    }
    if (selected) {
      entry["enabled"] = false;
    } else {
      selected = true;
    }
  }
}

/**
 * Fields the legacy push does not manage while their section's toggle is off
 * — it writes only the disable sentinel for each of these (Data API: only
 * `db_schema: ""`, api.sync.ts:130-145; network restrictions: whole flow
 * skipped, db.sync.ts:148-150; SMTP: only `smtp_host: ""`,
 * auth.sync.ts:2384-2397; storage Iceberg/Vector: whole feature omitted,
 * storage.sync.ts:287-299; captcha provider/secret only when enabled,
 * :2315-2324; hook URI/secrets only when enabled, :2551-2565; SMS provider
 * credentials only for the selected provider, :2498-2539; whole Auth/Storage
 * sections gated on their own `enabled`, :1224-1226 / storage.sync.ts's
 * subset gating) — so projecting the (usually schema-filled or
 * platform-retained) siblings would fabricate drift between representations
 * of the same disabled state. Applied to BOTH normalizers' outputs: the
 * mapped shape is identical on the document and API arms, so one pass keeps
 * the two symmetric by construction.
 */
export const DISABLED_SENTINEL_PRUNES: ReadonlyArray<{
  readonly containerPath: ReadonlyArray<string>;
  /** Keys to drop when `enabled === false`; absent = drop every key but `enabled`. */
  readonly dropKeys?: ReadonlyArray<string>;
}> = [
  // Top-level service toggles first — they subsume the section rules below.
  { containerPath: ["auth"] },
  { containerPath: ["storage"] },
  { containerPath: ["api"], dropKeys: ["schemas", "extra_search_path", "max_rows"] },
  {
    containerPath: ["db", "network_restrictions"],
    dropKeys: ["allowed_cidrs", "allowed_cidrs_v6"],
  },
  {
    containerPath: ["auth", "email", "smtp"],
    dropKeys: ["host", "port", "user", "pass", "admin_email", "sender_name"],
  },
  { containerPath: ["auth", "captcha"], dropKeys: ["provider", "secret"] },
  // No push precedent (the section postdates the legacy mappers) — gated for
  // family consistency: every other enabled-flagged container prunes its
  // unmanaged siblings, and a platform-retained authorization path behind a
  // disabled OAuth server is the same phantom-drift shape. Still meaningful
  // for the API arm (GoTrue reports real hosted oauth_server state
  // independent of push). On the DOCUMENT arm specifically, this entry's
  // effect is superseded by {@link applyPushUnmanagedOmissions}, which drops
  // the WHOLE `auth.oauth_server` subtree unconditionally — `authToUpdateBody`
  // has no oauth_server handling at all, so even this entry's own
  // `dropKeys` premise ("push manages the container while its toggle is on")
  // does not hold for that arm.
  {
    containerPath: ["auth", "oauth_server"],
    dropKeys: ["allow_dynamic_registration", "authorization_url_path"],
  },
  // Still meaningful on both arms for `enabled: true` (untouched) and on the
  // API arm for `enabled: false` (real hosted state). On the DOCUMENT arm
  // specifically, an `enabled: false` container is pruned further, to
  // NOTHING, by {@link applyPushUnmanagedOmissions}: `storageToUpdateBody`
  // only emits Iceberg/Vector inside a truthy `if (local.analytics.enabled)`
  // branch (storage.sync.ts:287-300), never a `{enabled: false}` shape, so
  // a disabled container reflects an unmanaged (not confirmed-off) state.
  {
    containerPath: ["storage", "analytics"],
    dropKeys: ["max_namespaces", "max_tables", "max_catalogs"],
  },
  { containerPath: ["storage", "vector"], dropKeys: ["max_buckets", "max_indexes"] },
];

/** Record-shaped containers whose per-entry `enabled: false` keeps only the flag. */
export const DISABLED_SENTINEL_ENTRY_SWEEPS: ReadonlyArray<{
  readonly containerPath: ReadonlyArray<string>;
  /** Restrict the sweep to these entry keys (a container mixing records and scalars). */
  readonly entryKeys?: ReadonlyArray<string>;
}> = [
  { containerPath: ["auth", "external"] },
  { containerPath: ["auth", "hook"] },
  // Same five provider names as SMS_PROVIDER_PUSH_PRECEDENCE — one list, not
  // two hand-kept in sync (order doesn't matter for a sweep, unlike the
  // precedence table's own order-pinned test).
  { containerPath: ["auth", "sms"], entryKeys: SMS_PROVIDER_PUSH_PRECEDENCE },
];

function pruneDisabledContainer(
  container: Record<string, unknown>,
  dropKeys?: ReadonlyArray<string>,
): void {
  for (const key of dropKeys ?? Object.keys(container)) {
    if (key !== "enabled") {
      delete container[key];
    }
  }
}

function applyDisabledSentinels(result: Record<string, unknown>): void {
  for (const rule of DISABLED_SENTINEL_PRUNES) {
    const container = readPath(result, rule.containerPath);
    if (isObject(container) && container["enabled"] === false) {
      pruneDisabledContainer(container, rule.dropKeys);
    }
  }
  for (const sweep of DISABLED_SENTINEL_ENTRY_SWEEPS) {
    const container = readPath(result, sweep.containerPath);
    if (!isObject(container)) {
      continue;
    }
    const entries = sweep.entryKeys ?? Object.keys(container);
    for (const entryKey of entries) {
      const entry = container[entryKey];
      if (isObject(entry) && entry["enabled"] === false) {
        pruneDisabledContainer(entry);
      }
    }
  }
  // Cross-section rule: the email rate limit is only managed while SMTP is
  // enabled (authToUpdateBody sends rate_limit_email_sent solely under
  // local.email.smtp.enabled, auth.sync.ts:2310-2313) — but pruning only
  // fires on an EXPLICIT `smtp.enabled === false`, never on absence: the
  // legacy push always knows local `smtp.enabled` (the document is fully
  // defaulted before push ever runs), so an ABSENT flag here can only happen
  // on the API arm, where it follows the same absent-says-nothing rule as
  // its sibling fields (`smtpExplicitlyDisabledInAttributes`,
  // `./registry-auth.ts`) — a sparse response that never mentioned
  // `smtp_host` must not have this value pruned either.
  const authSection = result["auth"];
  if (isObject(authSection)) {
    const email = authSection["email"];
    const smtp = isObject(email) ? email["smtp"] : undefined;
    const smtpExplicitlyDisabled = isObject(smtp) && smtp["enabled"] === false;
    const rateLimit = authSection["rate_limit"];
    if (smtpExplicitlyDisabled && isObject(rateLimit)) {
      delete rateLimit["email_sent"];
      if (Object.keys(rateLimit).length === 0) {
        delete authSection["rate_limit"];
      }
      // This is the one sentinel that can empty its whole section (every
      // other rule keeps at least the `enabled` flag) — a section emptied by
      // pruning is unmanaged noise, unlike an originally-empty one.
      if (Object.keys(authSection).length === 0) {
        delete result["auth"];
      }
    }
  }
}

/**
 * DOCUMENT-ARM ONLY (human review round on PR #6339, thread 3) — never
 * called from {@link fromApiProjectConfig}. Distinct from
 * {@link applyDisabledSentinels} (drops SIBLINGS of an explicitly-disabled
 * container, both arms, keyed on the DOCUMENT's own `enabled` reading) and
 * {@link applyRawPresenceMask} (drops a container push skips because the
 * RAW FILE never declared it, needs `document` and mirrors a different
 * legacy signal entirely): this drops a container `storageToUpdateBody`/
 * `authToUpdateBody` structurally cannot communicate to the platform AT
 * ALL, independent of both the document's own `enabled` value and raw
 * presence.
 *
 * - `storage.analytics`/`storage.vector`: `storageToUpdateBody` only emits
 *   `icebergCatalog`/`vectorBuckets` inside a truthy `if (local.analytics.
 *   enabled)`/`if (local.vector.enabled)` branch (storage.sync.ts:287-300)
 *   — there is no `{enabled: false}` shape it ever sends. A document with
 *   the feature disabled therefore has NOTHING pushed for it (unmanaged),
 *   unlike the API arm's own `enabled: false`, which is a confirmed hosted
 *   reading. Dropped entirely rather than left as `{enabled: false}`.
 * - `auth.oauth_server`: `authToUpdateBody` has no oauth_server handling
 *   whatsoever — the whole subtree is unconditionally unmanaged by push,
 *   regardless of its `enabled` value. Dropped unconditionally, which
 *   supersedes `DISABLED_SENTINEL_PRUNES`'s own `["auth","oauth_server"]`
 *   entry for this arm specifically (that entry stays meaningful for the
 *   API arm — see its own comment).
 */
function applyPushUnmanagedOmissions(result: Record<string, unknown>): void {
  for (const containerPath of [
    ["storage", "analytics"],
    ["storage", "vector"],
  ] as const) {
    const container = readPath(result, containerPath);
    if (isObject(container) && container["enabled"] === false) {
      removePathAndEmptiedAncestors(result, containerPath);
    }
  }
  removePathAndEmptiedAncestors(result, ["auth", "oauth_server"]);
}

/**
 * DOCUMENT-ARM ONLY, and only when {@link fromConfigDocument} was called
 * with a {@link CliConfigWithRawPresence} pair (human review round on PR
 * #6339, thread 1) — never called from {@link fromApiProjectConfig}, which
 * has no analogous raw-document concept. Mirrors the legacy push pipeline's
 * own raw-presence gates exactly: `apps/cli/src/legacy/commands/config/
 * push/push.raw-presence.ts`'s `legacyPresenceIn` (db.ssl_enforcement,
 * storage.image_transformation, storage.s3_protocol) and `config-sync/
 * auth.sync.ts`'s `AuthPresence` (captcha `:927`, the six hooks
 * `:951-960`, smtp `:1023`, external providers `:1075-1084` — `apple`
 * ALWAYS sent regardless of presence). Distinct from
 * {@link applyDisabledSentinels} (reads the DECODED `enabled` flag — can
 * only ever say "explicitly disabled", never "never mentioned", and runs
 * even without a `document`) and {@link applyPushUnmanagedOmissions} (drops
 * a container push can never emit at all, independent of presence): this
 * drops a container/entry push skips specifically because the RAW FILE
 * never declared it — a stronger, independent signal only available with
 * `document`, so it runs last and can remove a subtree either of the other
 * two mechanisms already touched or left alone.
 *
 * Values that DO survive still come from the DECODED `result` — masking
 * only decides presence/absence of a subtree, never substitutes a raw
 * value: push sends the decoded subset for any section the raw file
 * declares (e.g. a document that declares `[auth.external.google]` with
 * only `client_id` set still pushes `google`'s decoded `enabled: false`
 * default alongside it).
 */
function applyRawPresenceMask(
  result: Record<string, unknown>,
  document: Record<string, unknown>,
): void {
  // Matches `legacyPresenceIn`/`authPresenceIn`'s own predicate EXACTLY
  // (`x?.["key"] !== undefined`) — a VALUE comparison, not `Object.hasOwn`
  // (engineer review round on PR #6339, item 3): a raw document with an own
  // key set to an explicit `undefined` (`{ auth: { captcha: undefined } }`)
  // reads as ABSENT on both sides this way, keeping the docstring's
  // "mirrors ... exactly" claim literally true.
  const isPresent = (container: unknown, key: string): boolean =>
    isObject(container) && container[key] !== undefined;

  const db = document["db"];
  if (!isPresent(db, "ssl_enforcement")) {
    removePathAndEmptiedAncestors(result, ["db", "ssl_enforcement"]);
  }

  const storage = document["storage"];
  if (!isPresent(storage, "image_transformation")) {
    removePathAndEmptiedAncestors(result, ["storage", "image_transformation"]);
  }
  if (!isPresent(storage, "s3_protocol")) {
    removePathAndEmptiedAncestors(result, ["storage", "s3_protocol"]);
  }

  const auth = document["auth"];
  if (!isPresent(auth, "captcha")) {
    removePathAndEmptiedAncestors(result, ["auth", "captcha"]);
  }

  const hook = isObject(auth) ? auth["hook"] : undefined;
  for (const name of AUTH_HOOK_NAMES) {
    if (!isPresent(hook, name)) {
      removePathAndEmptiedAncestors(result, ["auth", "hook", name]);
    }
  }

  const email = isObject(auth) ? auth["email"] : undefined;
  if (!isPresent(email, "smtp")) {
    removePathAndEmptiedAncestors(result, ["auth", "email", "smtp"]);
    // The push mapper skips `rate_limit_email_sent` too when the raw file
    // never declares `[auth.email.smtp]` at all (auth.sync.ts:2310-2313) —
    // with raw presence available, this is exact, where the
    // `applyDisabledSentinels` explicit-false rule above can only ever say
    // "explicitly disabled", never "never mentioned".
    removePathAndEmptiedAncestors(result, ["auth", "rate_limit", "email_sent"]);
  }

  // Every provider decodes present (schema-defaulted `enabled: false`), but
  // push only ever sends the raw-declared providers PLUS the always-sent
  // `apple` default (auth.sync.ts:1075-1084) — keep exactly that set.
  // `Object.keys`, not `isPresent`, deliberately: `authPresenceIn`'s own
  // `externalProviders: Object.keys(external)` line uses own-key existence
  // here too, unlike its five `!== undefined` checks above — this is the
  // one gate that is genuinely keyed on `Object.hasOwn` semantics upstream.
  const external = isObject(auth) ? auth["external"] : undefined;
  const declaredProviders = isObject(external) ? new Set(Object.keys(external)) : new Set<string>();
  const projectedExternal = readPath(result, ["auth", "external"]);
  if (isObject(projectedExternal)) {
    for (const provider of Object.keys(projectedExternal)) {
      if (provider !== "apple" && !declaredProviders.has(provider)) {
        removePathAndEmptiedAncestors(result, ["auth", "external", provider]);
      }
    }
  }
}

/**
 * Unwraps the three shapes a caller might hand `fromApiProjectConfig`: the
 * full envelope (`{data: {type, attributes}}`), the `data` object itself
 * (`{type, attributes}`), or bare `attributes`. Presence of an own `data` or
 * `attributes` key decides which shape was intended, and each of those two
 * shapes is then validated strictly: a malformed envelope (e.g. `{data:
 * {attributes: 5}}`) throws rather than silently falling through to "bare
 * attributes", which would map to an empty {@link ProjectConfig} — read by a
 * diff consumer as "the remote manages nothing", a confidently wrong result
 * for what is actually a decode failure. Only the *absence* of both an own
 * `data` and an own `attributes` key is treated as "this is bare attributes
 * already" — an API-ahead section literally named `data` or `attributes`
 * inside a real attributes object is deliberately foreclosed as a
 * possibility here, since a truncated or malformed envelope reaching this
 * function is far likelier than the platform ever naming a project-config
 * section either of those two words. This is the one documented trade
 * behind {@link ProjectConfigParseError}'s "unknown keys never cause this"
 * claim: an unknown key collides with envelope detection only when it is
 * spelled exactly `data` or `attributes` at the top level.
 */
function unwrapApiResponse(input: unknown): Record<string, unknown> {
  if (!isObject(input)) {
    const detail = `expected an object, got ${nonObjectDescription(input)}`;
    throw new ProjectConfigParseError({
      message: formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
    });
  }
  if (Object.hasOwn(input, "data")) {
    const data = readEnvelopeProperty(input, "data");
    if (!isObject(data)) {
      throw envelopeError("data is not an object");
    }
    assertProjectConfigResourceType(data);
    const attributes = readEnvelopeProperty(data, "attributes");
    if (!isObject(attributes)) {
      throw envelopeError("data.attributes is not an object");
    }
    return attributes;
  }
  if (Object.hasOwn(input, "attributes")) {
    assertProjectConfigResourceType(input);
    const attributes = readEnvelopeProperty(input, "attributes");
    if (!isObject(attributes)) {
      throw envelopeError("attributes is not an object");
    }
    return attributes;
  }
  return input;
}

/**
 * Reads one envelope property, translating a throwing accessor into the
 * documented failure type: parsed JSON never carries getters, so an accessor
 * that throws during unwrapping is programmatic caller input — the same
 * taxonomy as the non-plain-object rejection in the validation walk. Each
 * envelope property is read exactly ONCE through this helper, so a getter
 * cannot return one value for a shape check and another (or a throw) for the
 * actual read.
 */
function readEnvelopeProperty(container: Record<string, unknown>, key: string): unknown {
  try {
    return container[key];
  } catch (cause) {
    throw new ProjectConfigParseError({
      message: `reading envelope property "${key}" threw — raw API input must be plain parsed JSON`,
      cause,
      reason: "caller_misuse",
    });
  }
}

/**
 * An envelope carrying an explicit `type` must carry THIS resource's type —
 * the generated contract's discriminator is `"project_config"`, so e.g. a
 * mixed-up response for another resource fails loudly instead of being
 * partially mapped wherever its attribute names happen to overlap. An absent
 * `type` stays tolerated (lenient toward trimmed-down callers that pass only
 * `{data:{attributes}}`).
 */
function assertProjectConfigResourceType(envelope: Record<string, unknown>): void {
  if (!Object.hasOwn(envelope, "type")) {
    return;
  }
  const resourceType = readEnvelopeProperty(envelope, "type");
  if (resourceType !== "project_config") {
    // Rendered defensively: JSON.stringify throws on a bigint discriminator,
    // which would escape the typed-error contract from inside the error
    // builder itself.
    const rendered =
      typeof resourceType === "string"
        ? JSON.stringify(resourceType)
        : nonObjectDescription(resourceType);
    throw envelopeError(`type is ${rendered}, expected "project_config"`);
  }
}

function nonObjectDescription(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "an array";
  }
  return typeof value;
}

function envelopeError(detail: string): ProjectConfigParseError {
  const message = `malformed envelope — ${detail}`;
  return new ProjectConfigParseError({
    message: formatProjectConfigParseErrorMessage(message),
    cause: new Error(message),
    suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
  });
}

// Sync decode is an accepted exception (repo `CLAUDE.md`'s "Schema decoding
// and encoding" section): this is an explicitly synchronous outer boundary
// (`fromApiProjectConfig` is a plain throwing function, not an `Effect`),
// `ProjectConfigApiAttributesSchema` is service-free (no `Effect.gen`/context
// requirements — see `./api-attributes.ts`), and the thrown
// `ProjectConfigParseError` below is the documented, intentional contract for
// a decode failure here.
const decodeApiAttributes = Schema.decodeUnknownSync(ProjectConfigApiAttributesSchema);

/**
 * Builds the `message`/`apiPath`/`detail` triple for a schema decode failure
 * from the thrown `SchemaError`, via the v4 `SchemaIssue` formatters: the
 * first flattened issue's path becomes `apiPath` (stringified — a
 * `SchemaIssue` path segment is a `PropertyKey`, and an array index arrives
 * as a `number`) and its message becomes the short summary rendered into
 * `message`; the full multi-issue rendering
 * (`SchemaIssue.makeFormatterDefault()`, the same formatter `SchemaError`'s
 * own `.message` uses) becomes `detail`. Falls back to the bare
 * `SchemaError` message when `cause` isn't a `SchemaError` at all — should
 * not happen given `decodeApiAttributes` is the only caller, but this
 * function must not itself throw while building an error message.
 *
 * Normalizes an empty issue path to `undefined`: an issue at the attributes
 * ROOT (the envelope/shape itself, rather than any specific field within it)
 * reports a zero-length path, and {@link ProjectConfigParseError}'s own
 * `apiPath` docstring promises `undefined` for exactly that case — an empty
 * array reads to a consumer as "the offending path is the empty path",
 * which is a different (and wrong) claim.
 */
function schemaDecodeFailureMessage(cause: unknown): {
  readonly message: string;
  readonly apiPath: ReadonlyArray<string> | undefined;
  readonly detail: string | undefined;
} {
  if (!Schema.isSchemaError(cause)) {
    return {
      message: formatProjectConfigParseErrorMessage(String(cause)),
      apiPath: undefined,
      detail: undefined,
    };
  }
  const { issues } = SchemaIssue.makeFormatterStandardSchemaV1()(cause.issue);
  const [firstIssue] = issues;
  // A `StandardSchemaV1.Issue` path entry is a `PropertyKey` OR a
  // `{ key: PropertyKey }` `PathSegment` object per the spec; effect's own
  // formatter only ever emits the former (`SchemaIssue.ts`'s internal
  // `DefaultIssue.path: ReadonlyArray<PropertyKey>`), but the public type is
  // the wider spec shape, so this reads `.key` off an object segment rather
  // than stringifying it directly.
  const rawApiPath = firstIssue?.path?.map((segment) =>
    String(typeof segment === "object" ? segment.key : segment),
  );
  const apiPath = rawApiPath !== undefined && rawApiPath.length > 0 ? rawApiPath : undefined;
  const summary = firstIssue?.message ?? cause.message;
  const detail = SchemaIssue.makeFormatterDefault()(cause.issue);
  return {
    message: formatProjectConfigParseErrorMessage(summary, apiPath),
    apiPath,
    detail,
  };
}

function decodeAttributes(rawAttributes: Record<string, unknown>): ProjectConfigApiAttributes {
  try {
    return decodeApiAttributes(rawAttributes);
  } catch (cause) {
    const { message, apiPath, detail } = schemaDecodeFailureMessage(cause);
    throw new ProjectConfigParseError({
      message,
      apiPath,
      cause,
      detail,
      suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
    });
  }
}

/** Reads `path` off `root`, descending through plain objects; `undefined` at any missing/non-object step. */
function readPath(root: unknown, path: ReadonlyArray<string>): unknown {
  let current = root;
  for (const segment of path) {
    if (!isObject(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

/** Writes `value` at `path` under `root`, creating intermediate plain objects as needed via `setOwnProperty`. */
function writePath(
  root: Record<string, unknown>,
  path: ReadonlyArray<string>,
  value: unknown,
): void {
  const [head, ...rest] = path;
  if (head === undefined) {
    return;
  }
  if (rest.length === 0) {
    setOwnProperty(root, head, value);
    return;
  }
  const existing = root[head];
  const next = isObject(existing) ? existing : {};
  if (next !== existing) {
    setOwnProperty(root, head, next);
  }
  writePath(next, rest, value);
}

/**
 * Walks {@link projectConfigMappingRows} against `decodedAttributes` and
 * writes every surviving mapped value into `output`. Per
 * `./registry-row.ts`'s null convention: a row whose `apiPath` is absent
 * (`undefined`) from `decodedAttributes` is always skipped, and one whose
 * value is `null` is skipped unless the row declares a `transform` (which
 * receives the `null` and decides). `isSecret` rows are never emitted — the
 * API only ever reports an HMAC digest for them (ADR 0019 rule 5).
 */
function applyMappingRows(
  decodedAttributes: ProjectConfigApiAttributes,
  output: Record<string, unknown>,
): void {
  for (const row of projectConfigMappingRows) {
    if (row.isSecret) {
      // The value is never emitted (ADR 0019 rule 5 — the API only reports
      // an HMAC digest), but a present non-string is still a malformed
      // platform response and must not vanish silently: the path is in the
      // consumed set, so without this check `unmappedApiFields` would hide
      // the malformed value too.
      const secretValue = readPath(decodedAttributes, row.apiPath);
      if (secretValue !== undefined && secretValue !== null) {
        expectString(secretValue, row.apiPath);
      }
      continue;
    }

    const rawValue = readPath(decodedAttributes, row.apiPath);
    if (rawValue === undefined) {
      // A row that also consumes sibling paths must still run when a sibling
      // is present despite the absent anchor: the sibling is in the consumed
      // set, so skipping here would silently swallow a malformed sibling
      // without it ever being validated (or reported unmapped).
      const siblingPresent = row.alsoConsumes?.some(
        (alsoPath) => readPath(decodedAttributes, alsoPath) !== undefined,
      );
      if (siblingPresent !== true) {
        continue;
      }
    }
    if (rawValue === null && row.transform === undefined) {
      continue;
    }

    const mapped =
      row.transform === undefined ? rawValue : row.transform(rawValue, decodedAttributes);
    if (mapped === undefined) {
      continue;
    }

    writePath(output, row.configPath, mapped);
  }

  // The orphan secret paths (`unmappedSecretApiPaths`) get the same
  // present-non-null validation as `isSecret` rows above: they too are in the
  // consumed set, so a malformed platform value (the contract permits only
  // string or null) would otherwise vanish — never emitted AND suppressed
  // from `unmappedApiFields`.
  for (const secretPath of unmappedSecretApiPaths) {
    const secretValue = readPath(decodedAttributes, secretPath);
    if (secretValue !== undefined && secretValue !== null) {
      expectString(secretValue, secretPath);
    }
  }
}

/**
 * Guards {@link walkUnmapped} and {@link assertRawAttributesDepthWithinBound}
 * against a pathologically (or maliciously) deep response body — an object
 * graph deeper than this could otherwise overflow the call stack with an
 * uncaught `RangeError` instead of the package's own documented failure
 * type.
 */
const MAX_UNMAPPED_WALK_DEPTH = 64;

/**
 * Pre-clone depth guard for {@link attachFrozenApiResponse} (CLI-2230's
 * clone/freeze finding): `structuredClone` and {@link deepFreeze} are both
 * naive recursive walks with no depth limit of their own, so a
 * pathologically deep `rawAttributes` — say, ~50k levels of nesting under an
 * API-ahead-of-package key (unmapped fields reach `attachFrozenApiResponse`
 * verbatim; decode's own leniency never prunes them) — overflows the call
 * stack with a raw, uncaught `RangeError` from inside `structuredClone`
 * itself, before this package ever gets a chance to turn it into a {@link
 * ProjectConfigParseError}. Walking (and throwing) here, before either
 * function ever runs, catches that case first. This also bounds cycles as a
 * side effect, with no separate visited-set needed: a self-referential
 * object has no finite depth, so re-encountering the same node at every
 * increasing `depth` still exceeds {@link MAX_UNMAPPED_WALK_DEPTH}
 * deterministically, well before either function's own recursion could
 * overflow the stack.
 */
/**
 * Total node visits the raw-attributes validation walk tolerates before
 * declaring the structure pathological. A real project-config response holds
 * a few hundred nodes; this bound exists for programmatic callers handing
 * `attachApiResponse` a shared-reference DAG, where ~40 objects arranged
 * with two properties each pointing at the same next node cost ~2^40 visits
 * while staying inside the depth bound — bounding *work* (not memoizing
 * subtrees) keeps the rejection typed and also keeps the later
 * path-dependent {@link walkUnmapped} safe, since any structure that passes
 * here costs `walkUnmapped` at most the same bounded number of visits.
 * (JSON parsed off a real network response can never share references, so
 * nothing legitimate is anywhere near this bound.)
 */
const MAX_RAW_ATTRIBUTES_NODE_VISITS = 100_000;

function assertRawAttributesDepthWithinBound(
  value: unknown,
  depth = 0,
  visits: { count: number } = { count: 0 },
  // Call-site provenance for the depth/visit bounds: via fromApiProjectConfig
  // a pathological structure is a platform-response problem (upgrade
  // suggestion applies); via attachApiResponse the structure is the CALLER's
  // own data, and reporting it as an external api_status failure would
  // corrupt the KPI. Non-JSON primitives and non-plain objects stay
  // caller_misuse unconditionally — parsed JSON cannot produce them on any
  // path.
  reason: "api_response" | "caller_misuse" = "api_response",
): void {
  if (depth > MAX_UNMAPPED_WALK_DEPTH) {
    const detail = `pathological nesting: exceeded ${MAX_UNMAPPED_WALK_DEPTH} levels while validating the raw API response`;
    throw new ProjectConfigParseError({
      message: reason === "caller_misuse" ? detail : formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      ...(reason === "caller_misuse"
        ? { reason }
        : { suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION }),
    });
  }
  // Bigint is structured-cloneable and freezable but not JSON — it would
  // land under a ReadonlyJsonValue-typed _apiResponse and blow up the first
  // JSON.stringify a consumer runs on an unmappedApiFields report. Parsed
  // JSON never produces one; programmatic caller input. Same for an
  // undefined-valued key (silently vanishes under JSON.stringify) and NaN
  // (no JSON literal exists for it). ±Infinity is NOT in this set (ADR 0019
  // rule 2 addendum): `JSON.parse('{"x":1e400}')` yields `Infinity`, so a
  // real platform payload can carry it in a field nothing reads — rejecting
  // it here would mis-bucket that payload as caller misuse. `walkUnmapped`
  // below converts a tolerated ±Infinity leaf to `null` (JSON.stringify's own
  // rendering) for `unmappedApiFields`, and `expectNumber` still rejects it
  // on any MAPPED field via the registry.
  if (
    typeof value === "bigint" ||
    value === undefined ||
    (typeof value === "number" && Number.isNaN(value))
  ) {
    throw new ProjectConfigParseError({
      message:
        "raw attributes hold a non-JSON primitive (a bigint, undefined, or NaN) — raw attributes must be plain parsed JSON",
      cause: new Error(`non-JSON primitive at depth ${depth}`),
      reason: "caller_misuse",
    });
  }
  visits.count += 1;
  if (visits.count > MAX_RAW_ATTRIBUTES_NODE_VISITS) {
    const detail = `pathological structure: exceeded ${MAX_RAW_ATTRIBUTES_NODE_VISITS} node visits while validating the raw API response`;
    throw new ProjectConfigParseError({
      message: reason === "caller_misuse" ? detail : formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      ...(reason === "caller_misuse"
        ? { reason }
        : { suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION }),
    });
  }
  if (Array.isArray(value)) {
    for (const child of value) {
      assertRawAttributesDepthWithinBound(child, depth + 1, visits, reason);
    }
    return;
  }
  if (isObject(value)) {
    // Only PLAIN objects pass: a Map/Set/Date/typed array is
    // structured-cloneable, but Object.freeze only freezes its wrapper — its
    // internal mutators (map.set, date.setTime) still work afterwards, so it
    // would punch a mutable hole through the deep-frozen metadata. Parsed
    // JSON never produces one. The identity check alone would also reject a
    // plain JSON payload parsed in ANOTHER REALM (an iframe handing its
    // JSON.parse result to the parent has that realm's Object.prototype), so
    // the cross-realm-safe brand check backs it up — built-ins carry their
    // own tags ("[object Map]"), a plain object reports "[object Object]"
    // from any realm.
    const prototype = Object.getPrototypeOf(value);
    if (
      prototype !== Object.prototype &&
      prototype !== null &&
      Object.prototype.toString.call(value) !== "[object Object]"
    ) {
      throw new ProjectConfigParseError({
        message:
          "raw attributes hold a non-plain object (e.g. a Map, Set, Date, or typed array) — raw attributes must be plain parsed JSON",
        cause: new Error(`non-plain object at depth ${depth}`),
        reason: "caller_misuse",
      });
    }
    for (const child of Object.values(value)) {
      assertRawAttributesDepthWithinBound(child, depth + 1, visits, reason);
    }
  }
}

/**
 * Wraps `structuredClone` for {@link attachFrozenApiResponse}: a
 * function-valued or symbol-valued raw attribute (never a shape a real API
 * response should carry, but not excluded by this package's otherwise
 * maximally-lenient decode either — `Schema.Unknown` accepts it) fails
 * `structuredClone` with an untyped, un-tagged `DOMException` ("The object
 * can not be cloned"). Translating it here keeps that failure inside this
 * package's documented `ProjectConfigParseError` contract instead of leaking
 * a raw `DOMException` to every caller.
 */
function cloneRawAttributes(
  rawAttributes: Record<string, unknown>,
  reason: "api_response" | "caller_misuse" = "api_response",
): Record<string, unknown> {
  try {
    return structuredClone(rawAttributes);
  } catch (cause) {
    // Non-cloneable values (functions/symbols) can only be programmatic, but
    // structuredClone ALSO throws on sufficiently deep plain JSON — which a
    // platform response genuinely can be — so provenance follows the call
    // site rather than assuming misuse.
    const detail =
      "raw attributes hold a value structuredClone cannot copy (a non-JSON value, or pathologically deep nesting)";
    throw new ProjectConfigParseError({
      message: reason === "caller_misuse" ? detail : formatProjectConfigParseErrorMessage(detail),
      cause,
      ...(reason === "caller_misuse"
        ? { reason }
        : { suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION }),
    });
  }
}

/**
 * Attaches a deep-cloned, deep-frozen copy of `rawAttributes` to a fresh
 * shallow copy of `enumerableProps`'s own enumerable properties, as a
 * non-enumerable `_apiResponse` (ADR 0019 rule 1). Shared by
 * {@link fromApiProjectConfig} and the exported {@link attachApiResponse} so
 * both go through one clone+freeze path. Cloning (rather than aliasing the
 * caller's object) and freezing means neither this package nor a caller can
 * mutate the attached raw attributes after the fact — including through the
 * very reference `rawAttributes` was passed in by. Every failure mode this
 * function can hit — pathological depth/cycles ({@link
 * assertRawAttributesDepthWithinBound}) and non-cloneable values ({@link
 * cloneRawAttributes}) — is translated into {@link ProjectConfigParseError}
 * rather than left to surface as a raw `RangeError`/`DOMException`, per this
 * package's documented failure-type contract.
 */
function attachFrozenApiResponse<T extends Record<string, unknown>>(
  enumerableProps: T,
  rawAttributes: Record<string, unknown>,
  reason: "api_response" | "caller_misuse" = "api_response",
): T {
  // Clone FIRST, then validate the CLONE: validating the live input leaves a
  // time-of-check/time-of-use gap for accessor properties (a getter can
  // answer the validation walk with a plain value and hand structuredClone a
  // bigint). The clone is inert data — getters are resolved exactly once by
  // structuredClone — so what gets validated is what gets attached. A
  // pathologically deep input failing inside structuredClone itself is
  // caught and typed by cloneRawAttributes.
  const cloned = cloneRawAttributes(rawAttributes, reason);
  assertRawAttributesDepthWithinBound(cloned, 0, undefined, reason);
  return attachOwnedSnapshot(enumerableProps, cloned);
}

/**
 * Maps a Management API v2 project-config response into a {@link
 * ProjectConfig}, per ADR 0019: (1) unwraps whichever of the three envelope
 * shapes `input` is, (2) decodes the unwrapped attributes leniently — an
 * API-ahead-of-package field never fails this decode, only a genuinely
 * malformed mapped field does — (3) walks the mapping registry
 * (`./registry.ts`) to populate the typed sections, and (4) attaches a
 * deep-cloned, deep-frozen copy of the raw, unwrapped attributes as a
 * non-enumerable `_apiResponse` ({@link attachFrozenApiResponse}) so
 * `unmappedApiFields` and forward-compatible consumers can still reach
 * whatever the registry didn't map. Throws {@link ProjectConfigParseError}
 * when `input` isn't an object, when the envelope is malformed, or when
 * decoding/mapping a value fails.
 *
 * Also NOT a verbatim projection of the response (ADR 0021): a `null` on a
 * gating boolean canonicalizes to `enabled: false` rather than being skipped
 * (`gatedBoolRow`/the SMTP host anchor, `./registry-auth.ts`), the
 * same {@link applyDisabledSentinels} pruning `fromConfigDocument` applies
 * runs here too, and an out-of-domain value on a mapped field (e.g. a
 * negative `storage.file_size_limit`) throws rather than canonicalizing to a
 * wrong value. This makes an API-sourced and a document-sourced
 * `ProjectConfig` comparable for the same hosted state, at the cost of this
 * function's output also not being a byte-for-byte echo of what the API
 * reported.
 */
export function fromApiProjectConfig(input: unknown): ProjectConfig;
// Untyped for the same reason as `fromConfigDocument` above: the mapping
// walk builds its result dynamically from `./registry.ts`'s rows, which
// TypeScript cannot verify reconstructs a `ProjectConfig`; the overload above
// is the contract, pinned by the unit tests.
export function fromApiProjectConfig(input: unknown): unknown {
  const rawAttributes = unwrapApiResponse(input);
  // ONE inert snapshot for everything: clone first (getters resolve exactly
  // once — decode, mapping, and the attached metadata all read the same
  // data, so no accessor can desynchronize them), then depth/work-bound the
  // snapshot BEFORE schema decoding — the mirror's `auth` record is
  // `Schema.Json`, whose decode recurses through arbitrary nesting, so a
  // pathologically deep value would otherwise overflow with a raw RangeError
  // inside the decode, escaping the typed-error contract. structuredClone's
  // own failure modes (non-cloneables, extreme depth) are already typed by
  // cloneRawAttributes.
  const snapshot = cloneRawAttributes(rawAttributes);
  assertRawAttributesDepthWithinBound(snapshot);
  const decodedAttributes = decodeAttributes(snapshot);

  const output: Record<string, unknown> = {};
  applyMappingRows(decodedAttributes, output);
  applyDisabledSentinels(output);

  // The snapshot is already validated and exclusively owned here, so it is
  // frozen and attached directly — no second clone/validation pass.
  return attachOwnedSnapshot(output, snapshot);
}

/**
 * Freezes and attaches an ALREADY-validated, exclusively-owned snapshot —
 * the tail of {@link attachFrozenApiResponse} without the clone/validate
 * steps, for the one caller ({@link fromApiProjectConfig}) that has already
 * done both on the same object.
 */
function attachOwnedSnapshot<T extends Record<string, unknown>>(
  enumerableProps: T,
  snapshot: Record<string, unknown>,
): T {
  let frozen: Record<string, unknown>;
  try {
    frozen = deepFreeze(snapshot);
  } catch (cause) {
    throw new ProjectConfigParseError({
      message:
        "raw attributes hold a value that cannot be frozen (e.g. a typed array) — raw attributes must be plain parsed JSON",
      cause,
      reason: "caller_misuse",
    });
  }
  // The spread evaluates every enumerable own property, so a getter on a
  // caller-supplied props object (attachApiResponse) would otherwise leak
  // its raw throw past the typed-error contract; the API arm's props are
  // built internally as plain data and can never take this branch.
  let result: T;
  try {
    result = { ...enumerableProps };
  } catch (cause) {
    throw new ProjectConfigParseError({
      message:
        "reading the config's enumerable properties threw — attachApiResponse configs must be plain data, not accessor-backed",
      cause,
      reason: "caller_misuse",
    });
  }
  Object.defineProperty(result, "_apiResponse", {
    value: frozen,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result;
}

/**
 * Re-attaches `_apiResponse` to `config` after a caller's own spread,
 * `structuredClone`, or state-store round-trip already dropped it — ADR
 * 0019 rule 1 promises the attach step exists precisely because those
 * operations are non-enumerable-property-blind by design, and a consumer
 * that legitimately needs to carry the raw attributes across such a
 * boundary (a state store, a serialized cache entry it then rehydrates) must
 * be able to restore them explicitly rather than losing `unmappedApiFields`
 * access permanently. Returns a NEW object: a shallow copy of `config`'s own
 * enumerable properties, plus `rawAttributes` attached via the same
 * clone-and-freeze path {@link fromApiProjectConfig} uses internally
 * ({@link attachFrozenApiResponse}) — never mutates `config` in place. Throws
 * {@link ProjectConfigParseError} when `config` is not an object, matching
 * {@link toProjectConfig}'s own strictness — a non-object `config` used to
 * silently substitute `{}`, discarding whatever the caller actually passed
 * instead of surfacing the misuse.
 */
export function attachApiResponse(
  config: ProjectConfig,
  rawAttributes: Record<string, unknown>,
): ProjectConfig;
// Untyped for the same reason as the other two normalizers above.
export function attachApiResponse(
  config: unknown,
  rawAttributes: Record<string, unknown>,
): unknown {
  if (!isObject(config)) {
    throw callerMisuseError(
      `attachApiResponse "config" must be an object, got ${nonObjectDescription(config)}`,
    );
  }
  if (!isObject(rawAttributes)) {
    throw callerMisuseError(
      `attachApiResponse "rawAttributes" must be an object, got ${nonObjectDescription(rawAttributes)}`,
    );
  }
  return attachFrozenApiResponse(config, rawAttributes, "caller_misuse");
}

/**
 * Either operand `toProjectConfig` accepts: a local {@link EffectiveConfig}
 * — or a {@link CliConfigWithRawPresence} pair, the RECOMMENDED form
 * whenever a `document` is available (see {@link fromConfigDocument}'s own
 * docstring) — to project down to the hosted subset, or a raw,
 * not-yet-decoded Management API v2 project-config response (in any of the
 * three envelope shapes {@link fromApiProjectConfig} accepts) to map.
 */
export type ToProjectConfigSource =
  | { readonly cliConfig: EffectiveConfig | CliConfigWithRawPresence }
  | { readonly apiResponse: unknown };

function hasApiResponse(
  source: ToProjectConfigSource,
): source is { readonly apiResponse: unknown } {
  return Object.hasOwn(source, "apiResponse");
}

function hasCliConfig(
  source: ToProjectConfigSource,
): source is { readonly cliConfig: EffectiveConfig | CliConfigWithRawPresence } {
  return Object.hasOwn(source, "cliConfig");
}

/**
 * Caller misuse — a programming error in the consumer, not a malformed
 * platform response: the message is plain (no "Management API response"
 * framing), the upgrade `suggestion` is omitted (upgrading fixes nothing),
 * and `reason: "caller_misuse"` lets apps/cli's error-actionability adapter
 * bucket it as invalid input instead of an external `api_status` failure.
 */
function callerMisuseError(detail: string): ProjectConfigParseError {
  return new ProjectConfigParseError({
    message: detail,
    cause: new Error(detail),
    reason: "caller_misuse",
  });
}

/**
 * Thin dispatcher over the two normalizers above: routes to
 * {@link fromApiProjectConfig} when `source` carries an own `apiResponse`
 * property, otherwise to {@link fromConfigDocument} when it carries an own
 * `cliConfig` property. A full `CliConfig` fits the `cliConfig` arm
 * directly, since `CliConfig` is assignable to {@link EffectiveConfig}.
 * Throws {@link ProjectConfigParseError} when `source` carries neither own
 * key or both — `{}` and `{ cliConfig: x, apiResponse: y }` are equally
 * meaningless dispatch requests, and failing loudly here beats a raw
 * `TypeError` from reaching into a property that isn't there.
 */
export function toProjectConfig(source: ToProjectConfigSource): ProjectConfig {
  // A JavaScript caller can hand this public dispatcher null/undefined
  // despite the compile-time type; guarding before the own-property
  // predicates keeps the failure inside the documented typed-error contract
  // instead of a native TypeError from Object.hasOwn.
  if (!isObject(source)) {
    throw callerMisuseError(
      `toProjectConfig source must be an object carrying exactly one of "cliConfig" or "apiResponse", got ${nonObjectDescription(source)}`,
    );
  }
  if (hasApiResponse(source)) {
    if (hasCliConfig(source)) {
      throw callerMisuseError(
        'toProjectConfig source must carry exactly one of an own "cliConfig" or "apiResponse" property, got both',
      );
    }
    return fromApiProjectConfig(readSourceProperty(() => source.apiResponse, "apiResponse"));
  }
  if (hasCliConfig(source)) {
    return fromConfigDocument(readSourceProperty(() => source.cliConfig, "cliConfig"));
  }
  throw callerMisuseError(
    'toProjectConfig source must carry exactly one of an own "cliConfig" or "apiResponse" property, got neither',
  );
}

/**
 * Reads the dispatcher's selected source property through the same guarded
 * boundary as the envelope reads ({@link readEnvelopeProperty}): plain data
 * never carries getters, so an accessor that throws here is programmatic
 * caller input and must surface as the documented failure type — not leak a
 * raw `Error` past the telemetry classification.
 */
function readSourceProperty<T>(read: () => T, key: string): T {
  try {
    return read();
  } catch (cause) {
    throw new ProjectConfigParseError({
      message: `reading source property "${key}" threw — toProjectConfig sources must be plain data, not accessor-backed`,
      cause,
      reason: "caller_misuse",
    });
  }
}

function pathKey(path: ReadonlyArray<string>): string {
  // JSON-encoded, not joined — a raw API key can legitimately contain any
  // candidate separator (a literal dot, even an escaped NUL), so no join
  // delimiter is collision-free. Encoding the segment array itself is
  // unambiguous for every representable key.
  return JSON.stringify(path);
}

/**
 * Every API path this registry version "knows about" — a row's own
 * `apiPath`, everything its `alsoConsumes` names, and every
 * `unmappedSecretApiPaths` entry (`./registry-auth.ts`: secret-shaped GoTrue
 * keys with no row of their own, so they'd otherwise leak an HMAC digest
 * into `unmappedApiFields`). "Consumed" here means "known to this registry
 * version", not "mapped on this run": an `alsoConsumes` sibling is suppressed
 * even on a run where its anchor row's own value was absent (e.g. Apple's
 * `external_apple_additional_client_ids` when `external_apple_client_id`
 * itself is missing) — the raw value is still there in `_apiResponse`, only
 * `unmappedApiFields` treats it as accounted for. This is intentional, not a
 * gap: the alternative (only suppress when the anchor row actually fired)
 * would report the sibling as "unmapped" even though a future run where the
 * anchor IS present would fold it in identically, which is noise, not signal.
 * Consumption is subtree-wide, not leaf-only, for the same reason: a
 * platform-added key nested INSIDE a consumed value's own structure (e.g. a
 * `comment` field added to an entry of `database.network_restrictions.
 * allowed_cidrs`, itself one row's `apiPath`) is never itemized either —
 * `walkUnmapped` prunes the whole subtree at the row's declared `apiPath`
 * before ever descending into it, so a mapped container's internal shape is
 * this registry version's business, not `unmappedApiFields`'s to re-report
 * field-by-field; `_apiResponse` still carries it verbatim.
 */
const consumedApiPathKeys: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  for (const row of projectConfigMappingRows) {
    keys.add(pathKey(row.apiPath));
    for (const alsoPath of row.alsoConsumes ?? []) {
      keys.add(pathKey(alsoPath));
    }
  }
  for (const secretPath of unmappedSecretApiPaths) {
    keys.add(pathKey(secretPath));
  }
  return keys;
})();

/**
 * Every PROPER prefix of a consumed path, plus the six top-level sections the
 * mirror schema declares — the containers this registry version already
 * "knows". {@link walkUnmapped} prunes a known container that is empty in the
 * raw response (an empty `postgres_settings`/`auth` carries nothing unknown
 * to report), while an empty object at an UNKNOWN path survives as drift
 * signal — a newly introduced, not-yet-populated API section.
 */
const knownApiContainerKeys: ReadonlySet<string> = (() => {
  const keys = new Set<string>();
  const addPrefixes = (path: ReadonlyArray<string>): void => {
    for (let length = 1; length < path.length; length++) {
      keys.add(pathKey(path.slice(0, length)));
    }
  };
  for (const row of projectConfigMappingRows) {
    addPrefixes(row.apiPath);
    for (const alsoPath of row.alsoConsumes ?? []) {
      addPrefixes(alsoPath);
    }
  }
  for (const secretPath of unmappedSecretApiPaths) {
    addPrefixes(secretPath);
  }
  for (const section of ["database", "pooler", "auth", "api", "realtime", "storage"]) {
    keys.add(pathKey([section]));
  }
  return keys;
})();

/**
 * Deep-sanitizes a non-finite number anywhere inside an unmapped ARRAY
 * leaf — an element, or a leaf inside a plain object nested within the
 * array — into `null`, the same JSON.stringify-shaped collapse
 * {@link walkUnmapped}'s own scalar check applies to a bare non-finite
 * value. An array is returned wholesale by `walkUnmapped` (never walked
 * element-by-element for the consumed-path pruning that governs objects), so
 * a non-finite number hiding inside one would otherwise reach
 * `unmappedApiFields`'s return unsanitized — `Infinity`/`-Infinity`/`NaN` are
 * `number`s (the type checker admits them into `ReadonlyJsonValue` just
 * fine), but none of them has a JSON spelling: `JSON.stringify` collapses
 * every one of them to `null`, so a caller round-tripping the report through
 * JSON would silently see a different value than `toEqual` does in-process.
 *
 * Returns the SAME reference, not a copy, when nothing needed sanitizing —
 * the common all-finite case — so `unmappedApiFields`'s "leaf arrays stay
 * frozen" contract (the array is a subtree of the deep-frozen `_apiResponse`)
 * keeps holding for it; only an array that actually contains a non-finite
 * number pays for a fresh, unfrozen copy.
 *
 * Depth-capped the same way every other walk over `_apiResponse`-reachable
 * data is (`walkUnmapped` above, `assertRawAttributesDepthWithinBound`): the
 * raw attributes are already depth/cycle-bounded pre-decode, so this can
 * never actually trip in practice, but each recursive walk keeps its own
 * explicit bound rather than relying on a guarantee proven elsewhere.
 */
function sanitizeNonFiniteArrayLeaf(value: unknown, depth: number): unknown {
  if (depth > MAX_UNMAPPED_WALK_DEPTH) {
    const detail = `pathological nesting: exceeded ${MAX_UNMAPPED_WALK_DEPTH} levels while walking for unmapped fields`;
    throw new ProjectConfigParseError({
      message: formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
    });
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((element) => {
      const sanitized = sanitizeNonFiniteArrayLeaf(element, depth + 1);
      if (sanitized !== element) {
        changed = true;
      }
      return sanitized;
    });
    return changed ? mapped : value;
  }
  if (isObject(value)) {
    let changed = false;
    const mapped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const sanitized = sanitizeNonFiniteArrayLeaf(child, depth + 1);
      if (sanitized !== child) {
        changed = true;
      }
      setOwnProperty(mapped, key, sanitized);
    }
    return changed ? mapped : value;
  }
  return value;
}

function walkUnmapped(value: unknown, path: ReadonlyArray<string>, depth = 0): unknown {
  if (depth > MAX_UNMAPPED_WALK_DEPTH) {
    const detail = `pathological nesting: exceeded ${MAX_UNMAPPED_WALK_DEPTH} levels while walking for unmapped fields`;
    throw new ProjectConfigParseError({
      message: formatProjectConfigParseErrorMessage(detail),
      cause: new Error(detail),
      suggestion: PROJECT_CONFIG_PARSE_ERROR_SUGGESTION,
    });
  }
  if (consumedApiPathKeys.has(pathKey(path))) {
    return undefined;
  }
  // A tolerated ±Infinity leaf (Fix 1 above) has no JSON spelling — collapse
  // it to `null`, matching what JSON.stringify itself would render.
  if (typeof value === "number" && !Number.isFinite(value)) {
    return null;
  }
  // An array is returned wholesale below (never walked element-by-element for
  // the consumed-path pruning objects get) — sanitize it separately so a
  // non-finite number hiding inside one still surfaces as `null` (its
  // JSON.stringify rendering) instead of silently riding along unsanitized.
  if (Array.isArray(value)) {
    return sanitizeNonFiniteArrayLeaf(value, depth);
  }
  if (!isObject(value)) {
    return value;
  }
  // An empty object at an UNKNOWN path is itself information — a newly
  // introduced, not-yet-populated section would otherwise vanish here and
  // make the response look fully mapped. A KNOWN container that happens to
  // be empty (`postgres_settings: {}`, `auth: {}`) is pruned instead: there
  // is nothing unknown in it to report, and preserving it would fabricate
  // drift for perfectly ordinary responses.
  if (Object.keys(value).length === 0) {
    return knownApiContainerKeys.has(pathKey(path)) ? undefined : {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const mapped = walkUnmapped(child, [...path, key], depth + 1);
    if (mapped !== undefined) {
      setOwnProperty(result, key, mapped);
    }
  }

  return Object.keys(result).length === 0 ? undefined : result;
}

/**
 * The subtree of `config._apiResponse` that {@link projectConfigMappingRows}
 * does not map — `{}` when `config` carries no `_apiResponse` at all
 * (file-sourced config, or a `ProjectConfig` that was never built from an API
 * response), which per ADR 0019 rule 1 does NOT mean "fully mapped".
 * Registry-derived, not a second hand-maintained field list (ADR 0019 rule
 * 5): a path is "mapped" when some row's `apiPath` or `alsoConsumes` names it
 * exactly, including every `isSecret` row (deliberately omitted, but known)
 * and every `unmappedSecretApiPaths` entry (deliberately omitted despite
 * having no row at all). Empty objects are pruned from the result, so a
 * subtree that is entirely mapped never shows up as `{}` noise.
 *
 * Reports at REGISTRY `apiPath` granularity, not full recursive fidelity: a
 * key nested INSIDE a consumed subtree — including inside an element of a
 * consumed array, e.g. an unexpected `comment` field on a
 * `database.network_restrictions.allowed_cidrs` entry — is not itemized here
 * either, since the whole subtree at that `apiPath` is already "known" to
 * this registry version (`consumedApiPathKeys`'s own docstring). This is
 * never lossy for the CALLER, only for this report: `_apiResponse` still
 * carries every such key verbatim, so a consumer that needs full recursive
 * fidelity reads it directly instead of relying on this helper.
 *
 * The result can include the HMAC digest the API reports for a secret-typed
 * key neither a row nor `unmappedSecretApiPaths` knows about yet — a future
 * GoTrue secret, say, added on the platform side before this package's
 * `isSecret` rows catch up. Callers must not render this result blindly — an
 * HMAC digest is not a value a user should see echoed back at them. Throws
 * {@link ProjectConfigParseError} if `_apiResponse` is nested more than 64
 * levels deep, or if `config` is not a plain object (`reason:
 * "caller_misuse"`).
 */
export function unmappedApiFields(config: ProjectConfig): {
  readonly [key: string]: ReadonlyJsonValue;
};
// Untyped for the same reason as `attachApiResponse` above (a JavaScript
// caller can hand this public reader anything despite the compile-time
// type), AND because the report's containers are rebuilt fresh while its
// leaf arrays/objects are shared BY REFERENCE with the deep-frozen
// `_apiResponse` — a mutable return type would compile `.push(...)` that
// throws at runtime. TypeScript cannot verify the structural walk either
// way; the overload above is the contract, pinned by the unit tests.
export function unmappedApiFields(config: unknown): unknown {
  // Guards the same boundary the other public entry points do: a non-object
  // operand (or one whose `_apiResponse` getter throws, translated by
  // `readApiResponseProperty` below) must surface as the documented typed
  // failure instead of a raw TypeError/Error escaping this package's
  // contract.
  if (!isObject(config)) {
    throw callerMisuseError(
      `unmappedApiFields config must be an object, got ${nonObjectDescription(config)}`,
    );
  }
  const rawAttributes = readApiResponseProperty(config);
  if (rawAttributes === undefined) {
    return {};
  }
  const result = walkUnmapped(rawAttributes, []);
  return isObject(result) ? result : {};
}

/**
 * Reads `config._apiResponse` through the same guarded pattern as the
 * envelope/dispatcher reads ({@link readEnvelopeProperty},
 * {@link readSourceProperty}): plain data never carries getters, so an
 * accessor that throws here is programmatic caller input (e.g. a foreign
 * object with a throwing `_apiResponse` getter) and must surface as the
 * documented failure type rather than a raw `Error` escaping past the
 * telemetry classification.
 */
function readApiResponseProperty(config: Record<string, unknown>): unknown {
  try {
    return config["_apiResponse"];
  } catch (cause) {
    throw new ProjectConfigParseError({
      message:
        'reading "_apiResponse" threw — unmappedApiFields operands must be plain data, not accessor-backed',
      cause,
      reason: "caller_misuse",
    });
  }
}

/**
 * The deduped `configPath`s of every non-`isSecret` row in
 * {@link projectConfigMappingRows}, in registry order — the fields
 * `fromApiProjectConfig` can actually speak for. Exists so a diff consumer
 * (CLI-2156/Studio) never hand-maintains an equivalent field list: as rows
 * are added, removed, or renamed, this set moves with them automatically.
 * Excludes secret rows (an API-sourced value for one is never populated, so
 * it can never meaningfully participate in a comparison) and every field
 * with no row at all (`realtime` in full, `workers`/`experimental`, and
 * every "Deliberately unmapped" field the sibling registries document).
 *
 * This ONLY remedies the whole-SECTION-granularity gap (e.g. `realtime` in
 * full never showing up as phantom drift just because it has zero rows). It
 * does NOT remedy the finer, per-path granularity gap this file's own
 * {@link ProjectConfig} docstring describes: `["auth", "email", "smtp",
 * "enabled"]` IS a member of this list (`isComparableProjectConfigPath`
 * returns `true` for it) and yet still fabricates drift against a document
 * operand that never declared `[auth.email.smtp]` at all, because
 * `subtractCliConfig`'s baseline has no `smtp` key to compare against and
 * therefore keeps the API side's value verbatim (pinned by
 * `project-config.unit.test.ts`'s "does NOT rescue a diff against a document
 * operand that never declared the sub-section at all" test). A caller doing
 * that comparison must additionally intersect with what the document-side
 * operand actually declared — or accept that every field a row maps
 * unconditionally will read as a remote-only statement whenever the document
 * side is silent on it, never as neutral "no opinion".
 */
export const comparableProjectConfigPaths: ReadonlyArray<ReadonlyArray<string>> = (() => {
  const seenKeys = new Set<string>();
  const paths: Array<ReadonlyArray<string>> = [];
  for (const row of projectConfigMappingRows) {
    if (row.isSecret) {
      continue;
    }
    const key = pathKey(row.configPath);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    paths.push(row.configPath);
  }
  return paths;
})();

const comparableProjectConfigPathKeys: ReadonlySet<string> = new Set(
  comparableProjectConfigPaths.map(pathKey),
);

/**
 * Whether `path` is a member of {@link comparableProjectConfigPaths} — or a
 * DESCENDANT of one: a row that maps a container (e.g. `sms.test_otp`'s
 * record) yields diff leaves like `["auth","sms","test_otp","<phone>"]` from
 * a leaf-path traversal, and those entries are exactly as comparable as the
 * mapped container itself. A bare PREFIX of a mapped path (e.g.
 * `["auth","sms"]`) is still not comparable — it names a section, not a
 * mapped value.
 */
export function isComparableProjectConfigPath(path: ReadonlyArray<string>): boolean {
  for (let length = path.length; length >= 1; length--) {
    if (comparableProjectConfigPathKeys.has(pathKey(path.slice(0, length)))) {
      return true;
    }
  }
  return false;
}

/**
 * Deduped `configPath`s of every `dualScope` row in
 * {@link projectConfigMappingRows}, in registry order (CLI-2064) — the
 * fields with a legitimate DIFFERENT correct value for the local stack than
 * the hosted project (`./registry-row.ts`'s `dualScope` docstring). `config
 * pull` uses this list to warn before silently overwriting one of these
 * fields at the config ROOT, since doing so would reconfigure `supabase
 * start` rather than merely record the hosted project's own setting; a write
 * into a `[remotes.*]` block is unaffected.
 */
export const dualScopeProjectConfigPaths: ReadonlyArray<ReadonlyArray<string>> = (() => {
  const seenKeys = new Set<string>();
  const paths: Array<ReadonlyArray<string>> = [];
  for (const row of projectConfigMappingRows) {
    if (row.dualScope !== true) {
      continue;
    }
    const key = pathKey(row.configPath);
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    paths.push(row.configPath);
  }
  return paths;
})();
