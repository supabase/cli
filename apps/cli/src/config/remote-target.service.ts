import type { Effect, Option } from "effect";
import { Context } from "effect";

import { BRANCH_PROJECT_REF_PATTERN } from "../command-internal/ref-patterns.ts";
import type { LinkedProjectRefReadError } from "../command-internal/project-link.ts";
import type {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
  ProjectRefRequiredError,
} from "./project-ref.errors.ts";

/** Where a target's ref came from: the `--project-ref` flag, `SUPABASE_PROJECT_ID`, or the link. */
export type RemoteTargetSource = "flag" | "env" | "link";

/**
 * The hosted project a command acts on. `parentRef` and `branchName` are set when the ref is a
 * linked branch, and `poolerUrl` when the link recorded an IPv4 pooler for the ref; all three
 * describe the checkout's link, so they are absent for a flag or env ref that is not the linked
 * one.
 */
export interface ResolvedRemoteTarget {
  readonly ref: string;
  readonly parentRef?: string;
  readonly branchName?: string;
  readonly poolerUrl?: string;
  readonly source: RemoteTargetSource;
}

/** The linked parent project, as seen from `SUPABASE_PROJECT_ID`, the link record, or the linked ref. */
export type ParentRefResolution =
  | {
      readonly kind: "resolved";
      readonly ref: string;
      readonly source: Exclude<RemoteTargetSource, "flag">;
    }
  | { readonly kind: "invalid" }
  | { readonly kind: "absent" };

export type RemoteTargetError =
  | ProjectRefNotLinkedError
  | InvalidProjectRefError
  | LinkedProjectRefReadError;

interface RemoteTargetShape {
  /**
   * Resolves the target once per command: flag, then `SUPABASE_PROJECT_ID`, then the link, then
   * (on a TTY) a project picker. Repeat calls with the same flag return the first result, so a
   * `link` that lands mid-command cannot change a target already in use. A prompted ref counts
   * as a `flag` source.
   */
  readonly resolve: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<ResolvedRemoteTarget, RemoteTargetError, never>;
  /**
   * {@link RemoteTargetShape.resolve} without the picker: fails with `ProjectRefNotLinkedError`
   * when nothing resolves. Used by the `--linked` path of the `db` command family, so a run with
   * a token but no link fails fast instead of opening a picker.
   */
  readonly load: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<ResolvedRemoteTarget, RemoteTargetError, never>;
  /**
   * Resolution used by `supabase link`, ignoring the existing link: flag, then
   * `SUPABASE_PROJECT_ID`, then (on a TTY) the picker. Fails with `ProjectRefRequiredError` on a
   * non-TTY when neither is set, matching cobra's `required flag(s) "project-ref" not set` wording.
   */
  readonly resolveForLink: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<
    ResolvedRemoteTarget,
    ProjectRefNotLinkedError | InvalidProjectRefError | ProjectRefRequiredError,
    never
  >;
  /**
   * Soft resolution (flag, env, link) with no picker and no failure; `None` when nothing
   * resolves. The ref is not format-validated, so callers use it only as a display marker.
   */
  readonly resolveOptional: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<Option.Option<ResolvedRemoteTarget>, never, never>;
  /**
   * Lists all projects and prompts for one with the given title, writing "Selected project: <ref>"
   * to stderr in text mode. Never reads the link.
   */
  readonly prompt: (title: string) => Effect.Effect<string, ProjectRefNotLinkedError, never>;
  /**
   * The linked parent project rather than the branch's own ref. The first present candidate
   * wins, in order: `SUPABASE_PROJECT_ID`, the recorded parent, the linked ref; a malformed
   * candidate is `invalid` instead of falling through to a lower one. A recorded parent counts
   * only when a linked ref confirms the link, and an env value restating the linked ref carries
   * no parent information.
   */
  readonly parent: Effect.Effect<ParentRefResolution, never, never>;
  /**
   * The target for the parent-scoped `branches` family, whose endpoints reject branch refs: an
   * explicit flag wins, then the linked parent, then {@link RemoteTargetShape.resolve}.
   */
  readonly resolveParentScoped: (
    flagValue: Option.Option<string>,
  ) => Effect.Effect<ResolvedRemoteTarget, RemoteTargetError, never>;
}

/** Resolves the hosted project a command acts on, once per command. */
export class RemoteTarget extends Context.Service<RemoteTarget, RemoteTargetShape>()(
  "supabase/cli/RemoteTarget",
) {}

export const PROJECT_REF_PATTERN = BRANCH_PROJECT_REF_PATTERN;

export const PROJECT_NOT_LINKED_MESSAGE = "Cannot find project ref. Have you run supabase link?";

export const INVALID_PROJECT_REF_MESSAGE =
  "Invalid project ref format. Must be like `abcdefghijklmnopqrst`.";
