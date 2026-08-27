/**
 * The alpha envelope a worker is described by: which runtime it is built on,
 * and how big an instance it runs as.
 *
 * Both are deliberately small closed sets. The Workers API takes `spec.size` as
 * one opaque string (`2gb-1vcpu`) rather than independent cpu/memory dials, so
 * the CLI offers exactly the sizes that string has values for and derives the
 * vCPU count from the memory the user picked — one choice, not two that could
 * be combined into a shape the platform does not run.
 */

/** A worker's runtime: its own Dockerfile, or one of the catalog base images. */
/**
 * Kept in step with the directories under `./stacks/` — a runtime offered here
 * with no starter files there would scaffold an empty worker, which
 * `worker-stacks.macro.ts` refuses at build time.
 */
export const WORKER_RUNTIMES = ["dockerfile", "node", "deno"] as const;

export type WorkerRuntime = (typeof WORKER_RUNTIMES)[number];

/**
 * The runtime a worker gets when nobody names one: what `new`'s prompt
 * pre-selects, and what the classifier falls back to for a directory it does
 * not recognize. Deno, because it is the runtime the rest of the Supabase CLI's
 * function tooling assumes.
 */
export const DEFAULT_WORKER_RUNTIME: WorkerRuntime = "deno";

function isWorkerRuntime(value: string): value is WorkerRuntime {
  return WORKER_RUNTIMES.some((runtime) => runtime === value);
}

/**
 * The runtime a config file named, case-insensitively. The canonical lowercase
 * form is what gets recorded.
 *
 * This is for hand-written `[workers.<name>] runtime` values, where the casing
 * is the user's own and `Runtime = "Node"` plainly means `node`. It is not what
 * validates `--runtime`: that is a `Flag.choice` over the same catalog, so the
 * parser rejects anything outside it — including a case variant — before a
 * handler runs, and lists the accepted values when it does.
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
 * The only instance sizes the alpha envelope offers, denominated by memory.
 * There is no resize — a different size later means a new worker, not a flag on
 * `push`.
 */
export const WORKER_SIZES = ["2gb", "4gb"] as const;

export type WorkerSize = (typeof WORKER_SIZES)[number];

/** The first available option — what `new` records when `--size` is omitted. */
export const DEFAULT_WORKER_SIZE: WorkerSize = "2gb";

/**
 * Instances a worker runs when neither `--instances` nor `[workers.<name>]
 * instances` says otherwise. One, because a deploy has to name a count — the
 * API's spec requires it — and a worker nobody has scaled is a single instance.
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
 * How a size reads in output: `2gb · 1 vCPU`. Takes the API's own spelling so a
 * worker deployed at a size this CLI never offered still renders, verbatim,
 * rather than being forced into the local enum.
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
 * `undefined` when `name` is a name this CLI can *record*, else why it is not.
 *
 * For commands that write `[workers.<name>]` — which is `new`, and `push` only
 * because it deploys what `new` wrote.
 */
export function validateWorkerNameMessage(name: string): string | undefined {
  return WORKER_NAME_PATTERN.test(name) ? undefined : workerNameRequirement;
}
