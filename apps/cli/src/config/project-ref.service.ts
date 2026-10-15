import type { Effect, Option } from "effect";
import { Context } from "effect";

import { BRANCH_PROJECT_REF_PATTERN } from "../command-internal/ref-patterns.ts";
import type { ProjectRefReadError } from "../shared/config/temp-paths.ts";
import type {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
  ProjectRefRequiredError,
} from "./project-ref.errors.ts";

/** Where a resolved project ref came from, in chain order. */
export type ProjectRefSource = "flag" | "env" | "file" | "picker";

export interface ResolvedProjectRef {
  readonly ref: string;
  readonly source: ProjectRefSource;
  /** Whether `ref` is the project linked in `supabase/.temp/project-ref`. */
  readonly matchesLinkedRef: boolean;
}

interface ProjectRefResolverShape {
  /**
   * The single resolution chain: `--project-ref` → `SUPABASE_PROJECT_ID` → `.temp/project-ref`
   * → project picker (stdin TTY and interactive output only), otherwise `ProjectRefNotLinkedError`.
   * Announces the resolved target.
   */
  readonly resolveRef: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    ResolvedProjectRef,
    ProjectRefNotLinkedError | InvalidProjectRefError | ProjectRefReadError,
    never
  >;
  /** `resolveRef`, narrowed to the ref. */
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
   * `ProjectRefRequiredError` on a non-TTY when neither is set, with the
   * `required flag(s) "project-ref" not set` wording. Announces the resolved target.
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
