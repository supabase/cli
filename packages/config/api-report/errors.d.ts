import type { ConfigFormat } from "./config-format.ts";
declare const CliConfigParseError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CliConfigParseError";
} & Readonly<A>;
export declare class CliConfigParseError extends CliConfigParseError_base<{
    readonly path: string;
    readonly format: ConfigFormat;
    readonly cause: unknown;
    /**
     * The pre-schema-decode `edge_runtime` subtree (post env-interpolation and
     * `[remotes.*]` merge) — present only when the failure happened during
     * *schema* decode (`Schema.decodeUnknownSync`), not during raw TOML/JSON
     * parsing. `Schema.decodeUnknownSync` is all-or-nothing: a single invalid
     * field anywhere in the document discards the entire decode, unlike Go's
     * `viper`+`mapstructure` decode (`apps/cli-go/pkg/config/config.go:749`),
     * which mutates the target struct field-by-field and keeps whatever
     * independently decoded before hitting an unrelated error. Callers that
     * need Go's tolerance for a single subtree (e.g. `secrets set` recovering
     * `edge_runtime.secrets` when an unrelated field like `analytics.port` is
     * malformed) can re-decode this subtree against the full schema themselves.
     * Only `edge_runtime` is retained, not the whole document — several callers
     * of `loadCliConfig` don't catch `CliConfigParseError` at all, so
     * this error can propagate with whatever is attached here, and no caller
     * needs anything outside `edge_runtime` today. Every `edge_runtime.secrets`
     * value is wrapped in `Redacted` (mirroring `secret()`'s `x-secret`
     * treatment elsewhere in this package) so an uncaught error can't
     * accidentally leak a resolved secret into a log or trace; callers must
     * unwrap via `Redacted.value` before re-decoding. `undefined` when the
     * document never parsed at all — that class has no recoverable structure in
     * either implementation.
     */
    readonly document?: {
        readonly edge_runtime?: unknown;
    };
    /**
     * Name of the `[remotes.<name>]` block whose subtree was merged over the
     * base document before the decode that produced this error, when a
     * `projectRef` was supplied and one matched. Mirrors `appliedRemote` on
     * {@link LoadedCliConfig} for the success path. Go's `loadFromFile`
     * prints `Loading config override: [remotes.<name>]` to stderr
     * unconditionally, *before* `mapstructure` decode ever runs
     * (`apps/cli-go/pkg/config/config.go:604-609`) — so the notice is still due
     * even when the subsequent decode fails. Callers that tolerate a
     * schema-decode failure and keep going (e.g. `secrets set`) must surface
     * this themselves; callers that let the error propagate get no such
     * notice from Go either, since `c.load(v)` fails before `Run` prints
     * anything else. `undefined` when no `projectRef` was requested or none
     * matched — same as the raw-parse-failure case, where remote merging never
     * runs at all.
     */
    readonly appliedRemote?: string;
}> {
}
/**
 * Renders `detail` under the shared {@link ProjectConfigParseError} message
 * convention: `"<prefix>: <detail>"`, or `"<prefix>: at data.attributes.<apiPath>:
 * <detail>"` when `apiPath` is given and non-empty. Every construction site
 * (`./project-config/project-config.ts`, `./project-config/registry-row.ts`,
 * `./project-config/registry.ts`) builds its message through this helper so
 * the "at data.attributes...." rendering stays identical everywhere an
 * `apiPath` is known.
 */
export declare function formatProjectConfigParseErrorMessage(detail: string, apiPath?: ReadonlyArray<string>): string;
/**
 * {@link ProjectConfigParseError} is, by construction, always the same
 * underlying situation: this package's mirrored schema/registry
 * (`./project-config/api-attributes.ts`, `./project-config/registry*.ts`) is
 * behind what the Management API actually sent. There is therefore exactly
 * one remediation, attached as `suggestion` at every construction site:
 * upgrade first (a newer package version may already map or leniently accept
 * the offending shape), then report if it persists.
 */
export declare const PROJECT_CONFIG_PARSE_ERROR_SUGGESTION = "Try upgrading the Supabase CLI to the latest version. If the error persists on the latest version, report it at https://github.com/supabase/cli/issues.";
declare const ProjectConfigParseError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "ProjectConfigParseError";
} & Readonly<A>;
/**
 * A Management API v2 project-config response failed to map into a
 * `ProjectConfig`: the envelope/attributes shape didn't decode, or a
 * registry-mapped field carried a value of the wrong type. `message` is a
 * human-readable summary built via {@link formatProjectConfigParseErrorMessage}
 * at every construction site; `detail` optionally carries a fuller,
 * multi-issue rendering (currently only populated for a schema decode
 * failure, via `SchemaIssue.makeFormatterDefault()`); `suggestion` is always
 * {@link PROJECT_CONFIG_PARSE_ERROR_SUGGESTION}. Unknown keys never cause
 * this on their own — the mapping decode is lenient toward
 * API-ahead-of-package skew by design (ADR 0019, rule 2) — with one
 * documented trade: an own `data` or `attributes` key found on what was
 * actually meant to be a bare-attributes payload is indistinguishable from a
 * real envelope and is treated as one (`unwrapApiResponse`'s docstring in
 * `./project-config/project-config.ts`), so a section genuinely named either
 * of those two words would trigger envelope validation instead of being
 * tolerated as an unmapped key.
 */
export declare class ProjectConfigParseError extends ProjectConfigParseError_base<{
    readonly message: string;
    /**
     * What actually went wrong, as a closed union telemetry can branch on:
     * `"api_response"` (the default when absent) — the Management API payload
     * itself failed to decode or map; `"caller_misuse"` — the CALLER handed
     * this package's own API an invalid argument (a `toProjectConfig` source
     * carrying neither/both keys or not an object at all, a non-object
     * `attachApiResponse` operand). Misuse is a programming error in the
     * consumer: the upgrade `suggestion` does not apply to it, and it must not
     * be reported as an external platform failure.
     */
    readonly reason?: "api_response" | "caller_misuse";
    /**
     * Path under v2 `data.attributes` of the offending value; `undefined` when
     * the response envelope/attributes shape itself failed to decode.
     */
    readonly apiPath?: ReadonlyArray<string>;
    readonly cause: unknown;
    /** Fuller, multi-issue detail beyond `message`'s single-issue summary. */
    readonly detail?: string;
    readonly suggestion?: string;
}> {
}
declare const CliProjectEnvParseError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "CliProjectEnvParseError";
} & Readonly<A>;
export declare class CliProjectEnvParseError extends CliProjectEnvParseError_base<{
    readonly path: string;
    readonly line: number;
}> {
}
declare const MissingCliConfigValueError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "MissingCliConfigValueError";
} & Readonly<A>;
export declare class MissingCliConfigValueError extends MissingCliConfigValueError_base<{
    readonly configPath: string;
}> {
}
declare const DuplicateRemoteProjectIdError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "DuplicateRemoteProjectIdError";
} & Readonly<A>;
/**
 * Two `[remotes.*]` blocks declare the same `project_id` as the requested
 * `projectRef`. Mirrors Go's `loadFromFile` guard
 * (`apps/cli-go/pkg/config/config.go:508-509`); `message` matches the Go string
 * verbatim so callers can surface it without rewrapping.
 */
export declare class DuplicateRemoteProjectIdError extends DuplicateRemoteProjectIdError_base<{
    readonly message: string;
}> {
}
declare const InvalidRemoteProjectIdError_base: new <A extends Record<string, any> = {}>(args: import("effect/Types").VoidIfEmpty<{ readonly [P in keyof A as P extends "_tag" ? never : P]: A[P]; }>) => import("effect/Cause").YieldableError & {
    readonly _tag: "InvalidRemoteProjectIdError";
} & Readonly<A>;
/**
 * A `[remotes.<name>]` block's `project_id` is not a valid 20-lowercase-letter
 * project ref. Mirrors Go's `Config.Validate` (`apps/cli-go/pkg/config/config.go:
 * 558,996-1001`), which checks every remote's `project_id` against `refPattern`
 * on every config load — regardless of whether that remote ends up selected —
 * so this fails before Docker/API access, same as Go. `message` matches the Go
 * string verbatim so callers can surface it without rewrapping.
 */
export declare class InvalidRemoteProjectIdError extends InvalidRemoteProjectIdError_base<{
    readonly message: string;
}> {
}
export {};
