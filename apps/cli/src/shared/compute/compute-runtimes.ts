/**
 * The alpha envelope a compute is described by: which runtime it is built on, how
 * big an instance it runs as, and whether it is reachable from the internet.
 *
 * All three are deliberately small closed sets, and the CLI's own rather than
 * the API's: the Compute API takes `spec.size` as one opaque string
 * (`2gb-1vcpu`) rather than independent cpu/memory dials, and `spec.exposure` as
 * an unconstrained string. So the CLI offers exactly the sizes that string has
 * values for and derives the vCPU count from the memory the user picked — one
 * choice, not two that could be combined into a shape the platform does not run.
 */

/** A compute's runtime: its own Dockerfile, or one of the catalog base images. */
/**
 * Kept in step with the directories under `./stacks/` — a runtime offered here
 * with no starter files there would scaffold an empty compute, which
 * `compute-stacks.macro.ts` refuses at build time.
 */
export const COMPUTE_RUNTIMES = ["dockerfile", "node", "deno"] as const;

export type ComputeRuntime = (typeof COMPUTE_RUNTIMES)[number];

/**
 * The runtime a compute gets when nobody names one: what `new`'s prompt
 * pre-selects, and what the classifier falls back to for a directory it does
 * not recognize. Deno, because it is the runtime the rest of the Supabase CLI's
 * function tooling assumes.
 */
export const DEFAULT_COMPUTE_RUNTIME: ComputeRuntime = "deno";

function isComputeRuntime(value: string): value is ComputeRuntime {
  return COMPUTE_RUNTIMES.some((runtime) => runtime === value);
}

/**
 * The runtime a config file named, case-insensitively. The canonical lowercase
 * form is what gets recorded.
 *
 * This is for hand-written `[compute.<name>] runtime` values, where the casing
 * is the user's own and `Runtime = "Node"` plainly means `node`. It is not what
 * validates `--runtime`: that is a `Flag.choice` over the same catalog, so the
 * parser rejects anything outside it — including a case variant — before a
 * handler runs, and lists the accepted values when it does.
 */
export function parseComputeRuntime(value: string): ComputeRuntime | undefined {
  const canonical = value.trim().toLowerCase();
  return isComputeRuntime(canonical) ? canonical : undefined;
}

/** One-line description of each runtime, for `--runtime`'s prompt and help. */
export const COMPUTE_RUNTIME_DESCRIPTIONS: Record<ComputeRuntime, string> = {
  dockerfile: "Build the directory's own Dockerfile; it serves plain HTTP on $PORT.",
  node: "Node.js catalog runtime (Web-standard fetch handler).",
  deno: "Deno catalog runtime (Web-standard fetch handler).",
};

/**
 * The only instance sizes the alpha envelope offers, denominated by memory.
 * There is no resize — a different size later means a new compute, not a flag on
 * `push`.
 */
export const COMPUTE_SIZES = ["2gb", "4gb"] as const;

export type ComputeSize = (typeof COMPUTE_SIZES)[number];

/** The first available option — what `new` records when `--size` is omitted. */
export const DEFAULT_COMPUTE_SIZE: ComputeSize = "2gb";

/**
 * Instances a compute runs when neither `--instances` nor `[compute.<name>]
 * instances` says otherwise. One, because a deploy has to name a count — the
 * API's spec requires it — and a compute nobody has scaled is a single instance.
 */
export const DEFAULT_COMPUTE_INSTANCES = 1;

function isComputeSize(value: string): value is ComputeSize {
  return COMPUTE_SIZES.some((size) => size === value);
}

/** As {@link parseComputeRuntime}, for instance sizes. */
export function parseComputeSize(value: string): ComputeSize | undefined {
  const canonical = value.trim().toLowerCase();
  return isComputeSize(canonical) ? canonical : undefined;
}

/**
 * How a compute is reached: `public` gives it an internet-facing URL, `private`
 * keeps it reachable only from inside the project.
 *
 * `spec.exposure` is an unconstrained string in the Management API's schema, so
 * this closed set is the CLI's own — the same arrangement as {@link COMPUTE_SIZES},
 * and the reason output renders the *accepted* exposure verbatim rather than
 * forcing it back into this enum.
 */
export const COMPUTE_EXPOSURES = ["public", "private"] as const;

export type ComputeExposure = (typeof COMPUTE_EXPOSURES)[number];

/**
 * The exposure a compute gets when neither `--exposure` nor `[compute.<name>]
 * exposure` says otherwise. Public, because every runtime offered today serves
 * HTTP and a compute nobody has locked down is one you can call.
 */
export const DEFAULT_COMPUTE_EXPOSURE: ComputeExposure = "public";

/** One-line description of each exposure, for `--exposure`'s prompt and help. */
export const COMPUTE_EXPOSURE_DESCRIPTIONS: Record<ComputeExposure, string> = {
  public: "Reachable from the internet at the compute's own URL.",
  private: "Reachable only from inside the project; no URL is issued.",
};

function isComputeExposure(value: string): value is ComputeExposure {
  return COMPUTE_EXPOSURES.some((exposure) => exposure === value);
}

/** As {@link parseComputeRuntime}, for exposures. */
export function parseComputeExposure(value: string): ComputeExposure | undefined {
  const canonical = value.trim().toLowerCase();
  return isComputeExposure(canonical) ? canonical : undefined;
}

const VCPU_FOR_SIZE: Record<ComputeSize, number> = { "2gb": 1, "4gb": 2 };

/** The vCPU count that comes with `size` — not independently choosable. */
export function vcpuForSize(size: ComputeSize): number {
  return VCPU_FOR_SIZE[size];
}

/** `spec.size` as the Compute API spells it: `2gb-1vcpu`. */
export function apiSizeFor(size: ComputeSize): string {
  return `${size}-${vcpuForSize(size)}vcpu`;
}

/**
 * How a size reads in output: `2gb · 1 vCPU`. Takes the API's own spelling so a
 * compute deployed at a size this CLI never offered still renders, verbatim,
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
 * Compute names end up in hostnames, so they are DNS labels — the same pattern
 * the Management API validates the `:name` path parameter against.
 */
const COMPUTE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const computeNameRequirement =
  "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.";

/**
 * `undefined` when `name` is a name this CLI can *record*, else why it is not.
 *
 * For commands that write `[compute.<name>]` — which is `new`, and `push` only
 * because it deploys what `new` wrote.
 */
export function validateComputeNameMessage(name: string): string | undefined {
  return COMPUTE_NAME_PATTERN.test(name) ? undefined : computeNameRequirement;
}
