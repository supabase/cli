/**
 * Pins one workload in `packages/stack/src/model/WorkloadCatalog.ts` to a
 * slim-services release, driven by the same `mirror-slim-image` dispatch as the
 * ECR mirror (`mirror-slim-image.yml`).
 *
 * Dependabot owns the Dockerfile and cannot own this table: these pins carry
 * image digests, which tag resolution never produces (ADR 0017). The dispatch
 * payload is untrusted and revalidated here — those patterns are what keep
 * `version`/`digest` inside the string literals they are written into.
 *
 * Run: `bun .github/scripts/sync-workload-catalog.ts` with SLIM_SERVICE,
 * SLIM_VERSION, SLIM_DIGEST. Exit 1 on an invalid payload; an unmodelled
 * service or release line is a successful no-op.
 */

export const CATALOG_PATH = "packages/stack/src/model/WorkloadCatalog.ts";

/** Mirrors the payload validation in `mirror-slim-image.yml`. */
const SERVICE_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERSION_PATTERN = /^[A-Za-z0-9._-]+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const SLIM_IMAGE_PREFIX = "ghcr.io/supabase/cli/";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
      /** `default` bumped the entry's defaultVersion; `additional` bumped one of its extra lines. */
      readonly target: "default" | "additional";
    }
  | { readonly kind: "unchanged" }
  | { readonly kind: "unmodelled-service" }
  | { readonly kind: "unmodelled-release-line"; readonly known: ReadonlyArray<string> };

export class InvalidPayloadError extends Error {}

export function validatePayload(input: {
  readonly service: string;
  readonly version: string;
  readonly digest: string;
}): void {
  if (!SERVICE_PATTERN.test(input.service)) {
    throw new InvalidPayloadError(`invalid service name: '${input.service}'`);
  }
  if (!VERSION_PATTERN.test(input.version)) {
    throw new InvalidPayloadError(`invalid version: '${input.version}'`);
  }
  if (!DIGEST_PATTERN.test(input.digest)) {
    throw new InvalidPayloadError(`invalid digest: '${input.digest}'`);
  }
}

/** `native("<service>", "<version>", "<image>"` — image anchored so postgres != postgrest. */
function defaultEntryPattern(service: string): RegExp {
  const s = escapeRegExp(service);
  return new RegExp(
    `(native\\(\\s*"${s}",\\s*")([^"]+)("\\s*,\\s*")(${escapeRegExp(SLIM_IMAGE_PREFIX)}${s}:[^"]+)(")`,
  );
}

/** `additionalReleases` entries: `"<version>": "<image>"`. The `:` is what distinguishes them. */
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
    target: "additional",
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new InvalidPayloadError(`missing required environment variable: ${name}`);
  }
  return value.trim();
}

async function main(): Promise<void> {
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
  main().catch((error: unknown) => {
    console.log(`::error ::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
