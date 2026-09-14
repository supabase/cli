import type { Effect, Option } from "effect";
import { Context } from "effect";

import { BRANCH_PROJECT_REF_PATTERN } from "../command-internal/ref-patterns.ts";
import type { ProjectRefReadError } from "../command-internal/temp-paths.ts";
import type {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
  ProjectRefRequiredError,
} from "./project-ref.errors.ts";

interface ProjectRefResolverShape {
  readonly resolve: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    ProjectRefNotLinkedError | InvalidProjectRefError | ProjectRefReadError,
    never
  >;
  /**
   * Resolution chain used by `supabase link`, skipping the on-disk `project-ref` file:
   * flag → `cliSettings.projectId` (env `SUPABASE_PROJECT_ID`) → (TTY) prompt. Fails with
   * `ProjectRefRequiredError` on a non-TTY when neither is set, matching cobra's
   * `required flag(s) "project-ref" not set` wording.
   */
  readonly resolveForLink: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    ProjectRefNotLinkedError | InvalidProjectRefError | ProjectRefRequiredError,
    never
  >;
  /**
   * Soft resolution chain (flag → `cliSettings.projectId` → ref file), with no prompt and no
   * failure; returns `None` when nothing resolves. Unlike `resolve`, the value is not
   * format-validated — safe only because every caller treats it as a display marker, never
   * an API input; a caller needing validation must do it itself.
   */
  readonly resolveOptional: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<Option.Option<string>, never, never>;
  /**
   * Non-prompting resolution chain (flag → `cliSettings.projectId` → ref file) that fails
   * hard with `ProjectRefNotLinkedError` when nothing resolves, with ref-format validation.
   * Used by the `--linked` PreRun of the `db` command family, so a run with a token but no
   * linked-project file fails fast instead of opening a project picker.
   */
  readonly loadProjectRef: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    string,
    ProjectRefNotLinkedError | InvalidProjectRefError | ProjectRefReadError,
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
  ) => Effect.Effect<string, ProjectRefNotLinkedError, never>;
}

export class ProjectRefResolver extends Context.Service<
  ProjectRefResolver,
  ProjectRefResolverShape
>()("supabase/cli/ProjectRefResolver") {}

export const PROJECT_REF_PATTERN = BRANCH_PROJECT_REF_PATTERN;

export const PROJECT_NOT_LINKED_MESSAGE = "Cannot find project ref. Have you run supabase link?";

export const INVALID_PROJECT_REF_MESSAGE =
  "Invalid project ref format. Must be like `abcdefghijklmnopqrst`.";
