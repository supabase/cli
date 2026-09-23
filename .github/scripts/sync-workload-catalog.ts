/**
 * Pins one workload in `packages/stack/src/Artifacts.ts` to a
 * slim-services release, driven by the same `mirror-slim-image` dispatch as the
 * ECR mirror (`mirror-slim-image.yml`).
 *
 * Dependabot owns the Dockerfile and cannot own this table: these pins carry
 * image digests, which tag resolution never produces (ADR 0017). The dispatch
 * payload is untrusted and revalidated here — `slim-mirror-payload.ts`
 * keeps `version`/`digest` inside the string literals they are written into.
 *
 * Run: `bun .github/scripts/sync-workload-catalog.ts` with SLIM_SERVICE,
 * SLIM_VERSION, SLIM_DIGEST. Exit 1 on an invalid payload; an unmodelled
 * service or release line is a successful no-op.
 *
 * `bun .github/scripts/sync-workload-catalog.ts carry <merge-base> <branch>`
 * reapplies the pins the shared sync branch holds over its merge base, so one
 * PR accumulates every pending release.
 */

import {
  InvalidPayloadError,
  SOURCE_REGISTRY,
  escapeRegExp,
  validatePayload,
} from "./slim-mirror-payload.ts";

export { InvalidPayloadError, validatePayload } from "./slim-mirror-payload.ts";

export const CATALOG_PATH = "packages/stack/src/Artifacts.ts";

const SLIM_IMAGE_PREFIX = `${SOURCE_REGISTRY}/`;

/** Leading numeric component, `v` stripped. Only postgres carries >1 line. */
export function releaseLine(version: string): string {
  const withoutPrefix = version.replace(/^[vV]/, "");
  const separator = withoutPrefix.indexOf(".");
  return separator === -1 ? withoutPrefix : withoutPrefix.slice(0, separator);
}

export interface CatalogUpdateInput {
  readonly source: string;
  readonly service: string;
  readonly version: string;
  readonly digest: string;
}

export type CatalogUpdatePlan =
  | {
      readonly kind: "updated";
      readonly source: string;
      readonly previousVersion: string;
      readonly previousImage: string;
      /** `default` bumped the entry's defaultVersion; `additional` bumped one of its extra lines. */
      readonly target: "default" | "additional";
    }
  | { readonly kind: "unchanged" }
  | { readonly kind: "unmodelled-service" }
  | { readonly kind: "unmodelled-release-line"; readonly known: ReadonlyArray<string> };

/** `definition("<service>", "<version>", "<image>"` — image anchored so postgres != postgrest. */
function defaultEntryPattern(service: string): RegExp {
  const s = escapeRegExp(service);
  return new RegExp(
    `(definition\\(\\s*"${s}",\\s*")([^"]+)("\\s*,\\s*")(${escapeRegExp(SLIM_IMAGE_PREFIX)}${s}:[^"]+)(")`,
  );
}

/** Additional release entries: `"<version>": "<image>"`. The `:` is what distinguishes them. */
function additionalEntryPattern(service: string, version?: string): RegExp {
  const s = escapeRegExp(service);
  const key = version === undefined ? `[^"]+` : escapeRegExp(version);
  // Groups: 1 key, 2 separator (kept, to preserve wrapping), 3 image.
  return new RegExp(
    `"(${key})"(\\s*:\\s*)"(${escapeRegExp(SLIM_IMAGE_PREFIX)}${s}:[^"]+)"`,
    version === undefined ? "g" : "",
  );
}

function slimImageRef(service: string, version: string, digest: string): string {
  return `${SLIM_IMAGE_PREFIX}${service}:${version}@${digest}`;
}

/** Rewrites `service`'s entry onto `version`/`digest`, or says why there was nothing to do. */
export function planCatalogUpdate(input: CatalogUpdateInput): CatalogUpdatePlan {
  validatePayload(input);
  const { source, service, version, digest } = input;

  const defaultMatch = defaultEntryPattern(service).exec(source);
  if (defaultMatch === null) {
    return { kind: "unmodelled-service" };
  }

  const currentDefaultVersion = defaultMatch[2] ?? "";
  const currentDefaultImage = defaultMatch[4] ?? "";
  const desiredImage = slimImageRef(service, version, digest);

  const additional = [...source.matchAll(additionalEntryPattern(service))].map((match) => ({
    version: match[1] ?? "",
    image: match[3] ?? "",
  }));

  // One line: always the default. Several (postgres): the release line picks,
  // so a 15.x release can never overwrite the 17.x default.
  const bumpsDefault =
    additional.length === 0 || releaseLine(version) === releaseLine(currentDefaultVersion);

  if (bumpsDefault) {
    if (currentDefaultVersion === version && currentDefaultImage === desiredImage) {
      return { kind: "unchanged" };
    }
    return {
      kind: "updated",
      source: source.replace(
        defaultEntryPattern(service),
        (_full, prefix: string, _version: string, mid: string, _image: string, suffix: string) =>
          `${prefix}${version}${mid}${desiredImage}${suffix}`,
      ),
      previousVersion: currentDefaultVersion,
      previousImage: currentDefaultImage,
      target: "default",
    };
  }

  const sameLine = additional.find((entry) => releaseLine(entry.version) === releaseLine(version));
  if (sameLine === undefined) {
    return {
      kind: "unmodelled-release-line",
      known: [currentDefaultVersion, ...additional.map((entry) => entry.version)],
    };
  }

  if (sameLine.version === version && sameLine.image === desiredImage) {
    return { kind: "unchanged" };
  }

  return {
    kind: "updated",
    source: source.replace(
      additionalEntryPattern(service, sameLine.version),
      (_full, _key: string, separator: string) => `"${version}"${separator}"${desiredImage}"`,
    ),
    previousVersion: sameLine.version,
    previousImage: sameLine.image,
    target: "additional",
  };
}

export interface CatalogPin {
  readonly service: string;
  readonly version: string;
  readonly digest: string;
}

const PIN_PATTERN = new RegExp(
  `"${escapeRegExp(SLIM_IMAGE_PREFIX)}([a-z][a-z0-9-]*):([A-Za-z0-9._-]+)@(sha256:[0-9a-f]{64})"`,
  "g",
);

function pinsIn(source: string): ReadonlyArray<CatalogPin> {
  return [...source.matchAll(PIN_PATTERN)].map((match) => ({
    service: match[1] ?? "",
    version: match[2] ?? "",
    digest: match[3] ?? "",
  }));
}

export interface CarryInput {
  readonly source: string;
  readonly mergeBase: string;
  readonly branch: string;
}

export interface CarryResult {
  readonly source: string;
  readonly carried: ReadonlyArray<CatalogPin>;
  /** Pins whose entry `source` moved since the merge base; `source` wins. */
  readonly superseded: ReadonlyArray<CatalogPin>;
}

/** Applies the pins `branch` added over `mergeBase` onto `source`. */
export function carryPins(input: CarryInput): CarryResult {
  const baseRefs = new Set(pinsIn(input.mergeBase).map(slimRefOf));
  const pending = pinsIn(input.branch).filter((pin) => !baseRefs.has(slimRefOf(pin)));

  let source = input.source;
  const carried: CatalogPin[] = [];
  const superseded: CatalogPin[] = [];
  for (const pin of pending) {
    const onBase = planCatalogUpdate({ source: input.mergeBase, ...pin });
    const onSource = planCatalogUpdate({ source, ...pin });
    if (onSource.kind === "unchanged") continue;
    if (
      onBase.kind === "updated" &&
      onSource.kind === "updated" &&
      onSource.previousVersion === onBase.previousVersion &&
      onSource.previousImage === onBase.previousImage
    ) {
      source = onSource.source;
      carried.push(pin);
    } else {
      superseded.push(pin);
    }
  }
  return { source, carried, superseded };
}

function slimRefOf(pin: CatalogPin): string {
  return slimImageRef(pin.service, pin.version, pin.digest);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new InvalidPayloadError(`missing required environment variable: ${name}`);
  }
  return value.trim();
}

async function carry(mergeBasePath: string, branchPath: string): Promise<void> {
  const result = carryPins({
    source: await Bun.file(CATALOG_PATH).text(),
    mergeBase: await Bun.file(mergeBasePath).text(),
    branch: await Bun.file(branchPath).text(),
  });
  await Bun.write(CATALOG_PATH, result.source);
  for (const pin of result.carried) {
    console.log(`Carried pending ${pin.service} ${pin.version} (${pin.digest}).`);
  }
  for (const pin of result.superseded) {
    console.log(
      `::warning ::Dropped pending ${pin.service} ${pin.version}: develop changed that entry since the sync branch was cut.`,
    );
  }
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  if (argv[0] === "carry") {
    const [, mergeBasePath, branchPath] = argv;
    if (mergeBasePath === undefined || branchPath === undefined) {
      throw new Error("usage: sync-workload-catalog.ts carry <merge-base-file> <branch-file>");
    }
    return carry(mergeBasePath, branchPath);
  }

  const service = requireEnv("SLIM_SERVICE");
  const version = requireEnv("SLIM_VERSION");
  const digest = requireEnv("SLIM_DIGEST");

  const source = await Bun.file(CATALOG_PATH).text();
  const plan = planCatalogUpdate({ source, service, version, digest });

  switch (plan.kind) {
    case "unmodelled-service":
      console.log(`::notice ::${CATALOG_PATH} models no '${service}' workload; nothing to sync.`);
      return;
    case "unmodelled-release-line":
      console.log(
        `::notice ::${service} ${version} is not on a release line ${CATALOG_PATH} carries (${plan.known.join(", ")}); nothing to sync.`,
      );
      return;
    case "unchanged":
      console.log(`::notice ::${service} is already pinned to ${version} at ${digest}.`);
      return;
    case "updated":
      await Bun.write(CATALOG_PATH, plan.source);
      console.log(
        `Updated ${service} ${plan.target} release ${plan.previousVersion} -> ${version} (${digest}).`,
      );
      return;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.log(`::error ::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
