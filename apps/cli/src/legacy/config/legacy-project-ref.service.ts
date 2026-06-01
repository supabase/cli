import type { Effect, Option } from "effect";
import { Context } from "effect";

import type {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
} from "./legacy-project-ref.errors.ts";

interface LegacyProjectRefResolverShape {
  readonly resolve: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<string, LegacyProjectNotLinkedError | LegacyInvalidProjectRefError, never>;
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

export const PROJECT_NOT_LINKED_MESSAGE = "Cannot find project ref. Have you run `supabase link`?";

export const INVALID_PROJECT_REF_MESSAGE =
  "Invalid project ref format. Must be like `abcdefghijklmnopqrst`.";
