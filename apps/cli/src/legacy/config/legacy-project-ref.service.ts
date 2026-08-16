import type { Effect, Option } from "effect";
import { Context } from "effect";
import type { PlatformError } from "effect/PlatformError";

import type {
  DuplicateRemoteProjectIdError,
  InvalidRemoteProjectIdError,
  ProjectConfigParseError,
  ProjectEnvParseError,
} from "@supabase/config";
import type {
  NoProjectConfigError,
  RemoteFlagConflictError,
  UnknownRemoteError,
} from "../../shared/remotes/remotes.errors.ts";
import type { LegacyProjectRefReadError } from "../shared/legacy-temp-paths.ts";
import type {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
  LegacyProjectRefRequiredError,
} from "./legacy-project-ref.errors.ts";

/**
 * Every resolution method's error channel additionally carries the
 * `--remote`/`SUPABASE_REMOTE` errors — resolved centrally, ahead of the
 * method's own flag-value precedence, by `legacy-project-ref.layer.ts`. See
 * that file's `resolveEffectiveFlagValue` for why this lives in exactly one
 * place instead of on all leaf commands. The `@supabase/config` pair is
 * `listRemotes`'s own static error surface — never actually raised on the default,
 * non-`goViperCompat` load path this seam uses, but part of the function's
 * declared type regardless of the runtime option value.
 */
type LegacyRemoteResolutionError =
  | RemoteFlagConflictError
  | UnknownRemoteError
  | NoProjectConfigError
  | DuplicateRemoteProjectIdError
  | InvalidRemoteProjectIdError
  | ProjectConfigParseError
  | ProjectEnvParseError
  | PlatformError;

interface LegacyProjectRefResolverShape {
  readonly resolve: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    | LegacyProjectNotLinkedError
    | LegacyInvalidProjectRefError
    | LegacyProjectRefReadError
    | LegacyRemoteResolutionError,
    never
  >;
  /**
   * Resolution chain used by `supabase link`. The on-disk `project-ref` file
   * is deliberately skipped:
   *
   *   flag → `cliConfig.projectId` (env `SUPABASE_PROJECT_ID`) → (TTY) prompt.
   *
   * On a non-TTY with neither the flag nor `PROJECT_ID` set, fails with
   * `LegacyProjectRefRequiredError`, reproducing cobra's
   * `required flag(s) "project-ref" not set` error.
   */
  readonly resolveForLink: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    | LegacyProjectNotLinkedError
    | LegacyInvalidProjectRefError
    | LegacyProjectRefRequiredError
    | LegacyRemoteResolutionError,
    never
  >;
  /**
   * Soft resolution chain (flag -> `cliConfig.projectId` -> ref file) with **no
   * prompt and no failure**. Used by `projects list`, which ignores a
   * missing/unreadable ref and only uses the value as a "linked" marker.
   * Returns `None` when nothing resolves.
   *
   * Unlike `resolve`, the returned value is **not** format-validated (see
   * `services`'s equivalent validate-and-warn handling, CLI-1872, for an
   * alternative pattern). `resolveOptional` skips that warning, which is
   * safe only because every current caller uses the value purely as a
   * display marker, never injected into an API path — a caller that needs
   * the warning should validate and warn itself rather than assume this
   * does it.
   */
  readonly resolveOptional: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<Option.Option<string>, LegacyRemoteResolutionError, never>;
  /**
   * Non-prompting resolution chain (flag -> `cliConfig.projectId` -> ref file)
   * that **fails hard** with `LegacyProjectNotLinkedError` when nothing
   * resolves, with ref-format validation. Used by the `--linked` PreRun of
   * the `db` command family and by the linked branch of database-config
   * resolution.
   *
   * Unlike `resolve`, it never reaches the interactive `PromptProjectRef` TTY
   * fallback — `db lint`/`db advisors`/`db query` deliberately call
   * `loadProjectRef`, not `resolve`, so a `--linked` run with a token but no
   * linked-project file must fail fast rather than open a project picker.
   */
  readonly loadProjectRef: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    | LegacyProjectNotLinkedError
    | LegacyInvalidProjectRefError
    | LegacyProjectRefReadError
    | LegacyRemoteResolutionError,
    never
  >;
  /**
   * Lists all projects and prompts the user to select one with the given title,
   * writing "Selected project: <ref>" to stderr (text mode). The `title` lets
   * callers set their own per-command prompt label (e.g. `projects delete`
   * uses "Which project do you want to delete?"). Used on a TTY when no
   * positional ref is supplied; never reads the linked ref file.
   */
  readonly promptProjectRef: (
    title: string,
  ) => Effect.Effect<string, LegacyProjectNotLinkedError, never>;
}

export class LegacyProjectRefResolver extends Context.Service<
  LegacyProjectRefResolver,
  LegacyProjectRefResolverShape
>()("supabase/legacy/ProjectRefResolver") {}

export const PROJECT_REF_PATTERN = /^[a-z]{20}$/;

export const PROJECT_NOT_LINKED_MESSAGE = "Cannot find project ref. Have you run supabase link?";

export const INVALID_PROJECT_REF_MESSAGE =
  "Invalid project ref format. Must be like `abcdefghijklmnopqrst`.";
