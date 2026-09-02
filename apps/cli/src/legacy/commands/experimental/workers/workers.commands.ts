import { WorkerNotDeployedError } from "../../../../shared/workers/workers.errors.ts";

/** How this family is invoked. Every string that names one builds from here. */
const PATH = "supabase experimental workers";

/** One of this family's commands, spelled the way a user would type it. */
export const legacyWorkersCommand = (rest: string) => `${PATH} ${rest}`;

/**
 * The `push` that deploys or redeploys `name`. A suggestion is copy-pasted
 * verbatim, so it carries `--project-ref` when the flag supplied one.
 */
export const legacyWorkersPushCommand = (name: string, refSuffix = "") =>
  legacyWorkersCommand(`push ${name}${refSuffix}`);

/** The `status` that reports on `name`. */
export const legacyWorkersStatusCommand = (name: string, refSuffix = "") =>
  legacyWorkersCommand(`status ${name}${refSuffix}`);

/**
 * "There is no such deployment", with the caller's own way out: `status` and
 * `logs` point at `push`, `delete` at `list` — somebody removing "api" wants to
 * see what *is* deployed, not to deploy it.
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
