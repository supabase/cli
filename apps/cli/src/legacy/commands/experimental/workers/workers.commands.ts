import { WorkerNotDeployedError } from "../../../../shared/workers/workers.errors.ts";

/**
 * How this family is invoked, in one place.
 *
 * The path was a literal in roughly thirty call sites, so moving the family
 * under `experimental` had to rewrite every one — and two follow-up commits
 * exist because some were missed or left pointing at a command that no longer
 * existed. Every user-facing string that names one of these commands builds it
 * from here.
 */
const PATH = "supabase experimental workers";

/** One of this family's commands, spelled the way a user would type it. */
export const legacyWorkersCommand = (rest: string) => `${PATH} ${rest}`;

/**
 * The `push` that deploys or redeploys `name`.
 *
 * `refSuffix` is the caller's `--project-ref` when the flag supplied one — a
 * suggestion is copy-pasted verbatim, so one that drops it re-resolves against
 * whatever this checkout is linked to.
 */
export const legacyWorkersPushCommand = (name: string, refSuffix = "") =>
  legacyWorkersCommand(`push ${name}${refSuffix}`);

/** The `status` that reports on `name`. */
export const legacyWorkersStatusCommand = (name: string, refSuffix = "") =>
  legacyWorkersCommand(`status ${name}${refSuffix}`);

/**
 * "There is no such deployment", with the caller's own way out.
 *
 * The detail is the same wherever it is raised; the suggestion is not. `status`
 * and `logs` point at `push`, but `delete` deliberately does not — somebody
 * removing "api" and hearing "nothing is deployed" wants to see what *is*
 * deployed, not to deploy it.
 */
export const legacyWorkerNotDeployed = (options: {
  readonly name: string;
  readonly projectRef: string;
  readonly suggestion: string;
}) =>
  new WorkerNotDeployedError({
    detail: `Nothing is deployed for "${options.name}" in project ${options.projectRef}.`,
    suggestion: options.suggestion,
  });
