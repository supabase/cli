import type { Effect, Option } from "effect";
import { Context } from "effect";

import type { LegacyProjectRefReadError } from "../shared/legacy-temp-paths.ts";
import type {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
  LegacyProjectRefRequiredError,
} from "./legacy-project-ref.errors.ts";

interface LegacyProjectRefResolverShape {
  readonly resolve: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    LegacyProjectNotLinkedError | LegacyInvalidProjectRefError | LegacyProjectRefReadError,
    never
  >;
  /**
   * Resolution chain used by `supabase link` (`apps/cli-go/cmd/link.go:30` calls
   * `flags.ParseProjectRef` with an **empty in-memory FS**, so the on-disk
   * `project-ref` file is deliberately skipped):
   *
   *   flag → `cliConfig.projectId` (env `SUPABASE_PROJECT_ID`) → (TTY) prompt.
   *
   * On a non-TTY with neither the flag nor `PROJECT_ID` set, fails with
   * `LegacyProjectRefRequiredError`, reproducing the cobra
   * `required flag(s) "project-ref" not set` error that link's `PreRunE`
   * triggers via `cmd.MarkFlagRequired("project-ref")` (`link.go:23-27`).
   */
  readonly resolveForLink: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    LegacyProjectNotLinkedError | LegacyInvalidProjectRefError | LegacyProjectRefRequiredError,
    never
  >;
  /**
   * Soft resolution chain (flag -> `cliConfig.projectId` -> ref file) with **no
   * prompt and no failure**. Mirrors Go's `flags.LoadProjectRef` as used by
   * `projects list` (`list.go:31-33`), which ignores `ErrNotLinked` and only
   * uses the value as a "linked" marker. Returns `None` when nothing resolves.
   *
   * Unlike `resolve`, the returned value is **not** format-validated — Go's
   * soft load also skips validation here, and the value is only used as a
   * display marker, never injected into an API path.
   */
  readonly resolveOptional: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<Option.Option<string>, never, never>;
  /**
   * Non-prompting resolution chain (flag -> `cliConfig.projectId` -> ref file)
   * that **fails hard** with `LegacyProjectNotLinkedError` when nothing
   * resolves, with ref-format validation. A 1:1 port of Go's
   * `flags.LoadProjectRef` (`internal/utils/flags/project_ref.go:54-76`) as used
   * by the `--linked` PreRun of the `db` command family (`cmd/db.go:307,362`)
   * and by `ParseDatabaseConfig`'s linked branch (`db_url.go:88`).
   *
   * Unlike `resolve`, it never reaches the interactive `PromptProjectRef` TTY
   * fallback — Go's `db lint`/`db advisors`/`db query` deliberately call
   * `LoadProjectRef`, not `ParseProjectRef`, so a `--linked` run with a token
   * but no linked-project file must fail fast rather than open a project picker.
   */
  readonly loadProjectRef: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    LegacyProjectNotLinkedError | LegacyInvalidProjectRefError | LegacyProjectRefReadError,
    never
  >;
  /**
   * Lists all projects and prompts the user to select one with the given title,
   * writing "Selected project: <ref>" to stderr (text mode). Mirrors Go's
   * `flags.PromptProjectRef(ctx, title)` (`project_ref.go:30-52`). The `title`
   * lets callers match Go's per-command prompt label (e.g. `projects delete`
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
