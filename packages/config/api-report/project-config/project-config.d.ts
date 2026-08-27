import type { CliConfig } from "../base.ts";
import { type DeepPartial, type EffectiveConfig } from "../sparse.ts";
import { type HostedSectionKey } from "./hosted-sections.ts";
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
export type ReadonlyJsonValue = string | number | boolean | null | ReadonlyArray<ReadonlyJsonValue> | {
    readonly [key: string]: ReadonlyJsonValue;
};
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
 */
export type ProjectConfig = DeepPartial<Pick<CliConfig, HostedSectionKey>> & {
    readonly _apiResponse?: {
        readonly [key: string]: ReadonlyJsonValue;
    };
};
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
 * Projects a {@link CliConfig} document (or any {@link EffectiveConfig}
 * operand — a full `CliConfig` is one) down to its hosted-section subset.
 * Copies each hosted section deeply and only when own-present on `config`,
 * omitting every `x-secret` leaf ({@link copyHostedValueWithoutSecrets}) and
 * canonicalizing every field a registry row's `normalizeDocument` covers
 * ({@link applyDocumentNormalizations}) — parity with
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
export declare function fromConfigDocument(config: EffectiveConfig): ProjectConfig;
export declare function fromConfigDocument(loaded: CliConfigWithRawPresence): ProjectConfig;
export declare function fromConfigDocument(source: EffectiveConfig | CliConfigWithRawPresence): ProjectConfig;
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
export declare const SMS_PROVIDER_PUSH_PRECEDENCE: readonly ["twilio", "twilio_verify", "messagebird", "textlocal", "vonage"];
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
export declare const DISABLED_SENTINEL_PRUNES: ReadonlyArray<{
    readonly containerPath: ReadonlyArray<string>;
    /** Keys to drop when `enabled === false`; absent = drop every key but `enabled`. */
    readonly dropKeys?: ReadonlyArray<string>;
}>;
/** Record-shaped containers whose per-entry `enabled: false` keeps only the flag. */
export declare const DISABLED_SENTINEL_ENTRY_SWEEPS: ReadonlyArray<{
    readonly containerPath: ReadonlyArray<string>;
    /** Restrict the sweep to these entry keys (a container mixing records and scalars). */
    readonly entryKeys?: ReadonlyArray<string>;
}>;
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
export declare function fromApiProjectConfig(input: unknown): ProjectConfig;
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
export declare function attachApiResponse(config: ProjectConfig, rawAttributes: Record<string, unknown>): ProjectConfig;
/**
 * Either operand `toProjectConfig` accepts: a local {@link EffectiveConfig}
 * — or a {@link CliConfigWithRawPresence} pair, the RECOMMENDED form
 * whenever a `document` is available (see {@link fromConfigDocument}'s own
 * docstring) — to project down to the hosted subset, or a raw,
 * not-yet-decoded Management API v2 project-config response (in any of the
 * three envelope shapes {@link fromApiProjectConfig} accepts) to map.
 */
export type ToProjectConfigSource = {
    readonly cliConfig: EffectiveConfig | CliConfigWithRawPresence;
} | {
    readonly apiResponse: unknown;
};
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
export declare function toProjectConfig(source: ToProjectConfigSource): ProjectConfig;
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
export declare function unmappedApiFields(config: ProjectConfig): {
    readonly [key: string]: ReadonlyJsonValue;
};
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
export declare const comparableProjectConfigPaths: ReadonlyArray<ReadonlyArray<string>>;
/**
 * Whether `path` is a member of {@link comparableProjectConfigPaths} — or a
 * DESCENDANT of one: a row that maps a container (e.g. `sms.test_otp`'s
 * record) yields diff leaves like `["auth","sms","test_otp","<phone>"]` from
 * a leaf-path traversal, and those entries are exactly as comparable as the
 * mapped container itself. A bare PREFIX of a mapped path (e.g.
 * `["auth","sms"]`) is still not comparable — it names a section, not a
 * mapped value.
 */
export declare function isComparableProjectConfigPath(path: ReadonlyArray<string>): boolean;
