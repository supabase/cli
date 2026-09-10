/**
 * Runtime, size, and exposure are the CLI's own small closed sets, not the API's: the Compute API
 * takes `spec.size` as one opaque string (`2gb-1vcpu`) and `spec.exposure` as an unconstrained
 * string, so the CLI offers exactly the sizes that exist and derives vCPU count from memory rather
 * than letting the two be picked independently.
 */

/**
 * A compute's runtime: its own Dockerfile, or one of the catalog base images, kept in sync with
 * `./stacks/` — a runtime offered here with no starter files there scaffolds an empty compute,
 * which `compute-stacks.macro.ts` refuses at build time.
 */
export const COMPUTE_RUNTIMES = ["dockerfile", "node", "deno"] as const;

export type ComputeRuntime = (typeof COMPUTE_RUNTIMES)[number];

/**
 * The runtime `new` pre-selects and the classifier falls back to for an unrecognized directory.
 * Deno, since it's the runtime the rest of the CLI's function tooling assumes.
 */
export const DEFAULT_COMPUTE_RUNTIME: ComputeRuntime = "deno";

function isComputeRuntime(value: string): value is ComputeRuntime {
  return COMPUTE_RUNTIMES.some((runtime) => runtime === value);
}

/**
 * Parses a config-file `[compute.<name>] runtime` value case-insensitively (hand-written casing
 * like `Runtime = "Node"` should still mean `node`). Not used for `--runtime`, which validates
 * through a `Flag.choice` over the same catalog instead.
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
 * The only instance sizes offered, denominated by memory. There is no resize — a different size
 * means a new compute, not a `push` flag.
 */
export const COMPUTE_SIZES = ["2gb", "4gb"] as const;

export type ComputeSize = (typeof COMPUTE_SIZES)[number];

/** The first available option — what `new` records when `--size` is omitted. */
export const DEFAULT_COMPUTE_SIZE: ComputeSize = "2gb";

/**
 * Instance count used when neither `--instances` nor `[compute.<name>] instances` is set. One,
 * since the API's deploy spec requires a count and an unscaled compute is a single instance.
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
 * How a compute is reached: `public` gets an internet-facing URL, `private` is reachable only
 * from inside the project. Like {@link COMPUTE_SIZES}, this closed set is the CLI's own — the
 * API's `spec.exposure` is an unconstrained string — so output renders the *accepted* exposure
 * verbatim rather than forcing it back into this enum.
 */
export const COMPUTE_EXPOSURES = ["public", "private"] as const;

export type ComputeExposure = (typeof COMPUTE_EXPOSURES)[number];

/**
 * Exposure used when neither `--exposure` nor `[compute.<name>] exposure` is set. Public, since
 * every runtime offered today serves HTTP and an unlocked-down compute is one you can call.
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
 * Formats a size for output as `2gb · 1 vCPU`, from the API's own spelling — a compute deployed at
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
 * Compute names end up in hostnames, so they are DNS labels — the same pattern
 * the Management API validates the `:name` path parameter against.
 */
const COMPUTE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

const computeNameRequirement =
  "Use lowercase letters, digits and hyphens, starting and ending with a letter or digit.";

/**
 * `undefined` when `name` can be recorded as `[compute.<name>]`, else the reason it can't — used
 * by `new` (which writes the section) and `push` (which deploys what `new` wrote).
 */
export function validateComputeNameMessage(name: string): string | undefined {
  return COMPUTE_NAME_PATTERN.test(name) ? undefined : computeNameRequirement;
}
