/**
 * Runtime, size, and exposure are the CLI's own small closed sets, not the API's: the Workers API
 * takes `spec.size` as one opaque string (`2gb-1vcpu`) and `spec.exposure` as an unconstrained
 * string, so the CLI offers exactly the sizes that exist and derives vCPU count from memory rather
 * than letting the two be picked independently.
 */

/**
 * A worker's runtime: its own Dockerfile, or one of the catalog base images, kept in sync with
 * `./stacks/` — a runtime offered here with no starter files there scaffolds an empty worker,
 * which `worker-stacks.macro.ts` refuses at build time.
 */
export const WORKER_RUNTIMES = ["dockerfile", "node", "deno"] as const;

export type WorkerRuntime = (typeof WORKER_RUNTIMES)[number];

/**
 * The runtime `new` pre-selects and the classifier falls back to for an unrecognized directory.
 * Deno, since it's the runtime the rest of the CLI's function tooling assumes.
 */
export const DEFAULT_WORKER_RUNTIME: WorkerRuntime = "deno";

function isWorkerRuntime(value: string): value is WorkerRuntime {
  return WORKER_RUNTIMES.some((runtime) => runtime === value);
}

/**
 * Parses a config-file `[workers.<name>] runtime` value case-insensitively (hand-written casing
 * like `Runtime = "Node"` should still mean `node`). Not used for `--runtime`, which validates
 * through a `Flag.choice` over the same catalog instead.
 */
export function parseWorkerRuntime(value: string): WorkerRuntime | undefined {
  const canonical = value.trim().toLowerCase();
  return isWorkerRuntime(canonical) ? canonical : undefined;
}

/** One-line description of each runtime, for `--runtime`'s prompt and help. */
export const WORKER_RUNTIME_DESCRIPTIONS: Record<WorkerRuntime, string> = {
  dockerfile: "Build the directory's own Dockerfile; it serves plain HTTP on $PORT.",
  node: "Node.js catalog runtime (Web-standard fetch handler).",
  deno: "Deno catalog runtime (Web-standard fetch handler).",
};

/**
 * The only instance sizes offered, denominated by memory. There is no resize — a different size
 * means a new worker, not a `push` flag.
 */
export const WORKER_SIZES = ["2gb", "4gb"] as const;

export type WorkerSize = (typeof WORKER_SIZES)[number];

/** The first available option — what `new` records when `--size` is omitted. */
export const DEFAULT_WORKER_SIZE: WorkerSize = "2gb";

/**
 * Instance count used when neither `--instances` nor `[workers.<name>] instances` is set. One,
 * since the API's deploy spec requires a count and an unscaled worker is a single instance.
 */
export const DEFAULT_WORKER_INSTANCES = 1;

function isWorkerSize(value: string): value is WorkerSize {
  return WORKER_SIZES.some((size) => size === value);
}

/** As {@link parseWorkerRuntime}, for instance sizes. */
export function parseWorkerSize(value: string): WorkerSize | undefined {
  const canonical = value.trim().toLowerCase();
  return isWorkerSize(canonical) ? canonical : undefined;
}

/**
 * How a worker is reached: `public` gets an internet-facing URL, `private` is reachable only
 * from inside the project. Like {@link WORKER_SIZES}, this closed set is the CLI's own — the
 * API's `spec.exposure` is an unconstrained string — so output renders the *accepted* exposure
 * verbatim rather than forcing it back into this enum.
 */
export const WORKER_EXPOSURES = ["public", "private"] as const;

export type WorkerExposure = (typeof WORKER_EXPOSURES)[number];

/**
 * Exposure used when neither `--exposure` nor `[workers.<name>] exposure` is set. Public, since
 * every runtime offered today serves HTTP and an unlocked-down worker is one you can call.
 */
export const DEFAULT_WORKER_EXPOSURE: WorkerExposure = "public";

/** One-line description of each exposure, for `--exposure`'s prompt and help. */
export const WORKER_EXPOSURE_DESCRIPTIONS: Record<WorkerExposure, string> = {
  public: "Reachable from the internet at the worker's own URL.",
  private: "Reachable only from inside the project; no URL is issued.",
};

function isWorkerExposure(value: string): value is WorkerExposure {
  return WORKER_EXPOSURES.some((exposure) => exposure === value);
}

/** As {@link parseWorkerRuntime}, for exposures. */
export function parseWorkerExposure(value: string): WorkerExposure | undefined {
  const canonical = value.trim().toLowerCase();
  return isWorkerExposure(canonical) ? canonical : undefined;
}

const VCPU_FOR_SIZE: Record<WorkerSize, number> = { "2gb": 1, "4gb": 2 };

/** The vCPU count that comes with `size` — not independently choosable. */
export function vcpuForSize(size: WorkerSize): number {
  return VCPU_FOR_SIZE[size];
}

/** `spec.size` as the Workers API spells it: `2gb-1vcpu`. */
export function apiSizeFor(size: WorkerSize): string {
  return `${size}-${vcpuForSize(size)}vcpu`;
}

/**
 * Formats a size for output as `2gb · 1 vCPU`, from the API's own spelling — a worker deployed at
 * a size this CLI never offered still renders verbatim instead of being forced into the local enum.
 */
export function formatApiSize(apiSize: string): string {
  const match = /^(\d+gb)-(\d+)vcpu$/.exec(apiSize.trim().toLowerCase());
  if (match === null) {
    return apiSize;
  }
  return `${match[1]} (${match[2]} vCPU)`;
}

/**
 * Worker names end up in hostnames, so they are DNS labels — the same pattern
 * the Management API validates the `:name` path parameter against.
 */
const WORKER_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const workerNameRequirement =
  "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.";

/**
 * `undefined` when `name` can be recorded as `[workers.<name>]`, else the reason it can't — used
 * by `new` (which writes the section) and `push` (which deploys what `new` wrote).
 */
export function validateWorkerNameMessage(name: string): string | undefined {
  return WORKER_NAME_PATTERN.test(name) ? undefined : workerNameRequirement;
}
