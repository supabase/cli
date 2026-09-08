/**
 * Syncs `packages/stack/src/model/WorkloadCatalog.ts` to a slim-services
 * release.
 *
 * `@supabase/stack` pins each workload to an exact slim-services artifact
 * release — a version plus the digest of its `ghcr.io/supabase/cli/<service>`
 * image — because ADR 0017 makes the artifact release the boundary for service
 * startup defaults. Those pins therefore track the slim-services release feed,
 * NOT `apps/cli-go/pkg/config/templates/Dockerfile`. Dependabot maintains the
 * Dockerfile (which the shipped CLI reads via
 * `apps/cli/src/shared/services/dockerfile-images.ts`) and cannot maintain this
 * catalog: it resolves registry tags and has no way to emit a `sha256:` index
 * digest.
 *
 * The feed is the `mirror-slim-image` repository_dispatch that slim-services
 * already sends this repo for the ECR mirror (see `mirror-slim-image.yml` and
 * `docs/design/ecr-mirror-dispatch.md` in supabase/slim-services). This script
 * consumes the same payload and rewrites the matching catalog entry;
 * `sync-stack-workload-catalog.yml` runs it and opens the PR.
 *
 * Only two source values need rewriting per release. `artifactFor` in
 * `WorkloadCatalog.ts` derives `releaseTag`, `assetName`, and every download
 * URL from `service` + `version`, and `releases` is derived from
 * `defaultVersion` + the container image, so updating the `native(...)`
 * positional `defaultVersion` and container image is the whole change.
 *
 * The payload arrives with whatever authority holds the dispatch token, so it
 * is revalidated here rather than trusted from the workflow — the patterns
 * below are what keep `version` and `digest` from breaking out of the TypeScript
 * string literals they are written into.
 *
 * Run in CI as:
 *   bun .github/scripts/sync-workload-catalog.ts
 * with SLIM_SERVICE / SLIM_VERSION / SLIM_DIGEST set from the payload.
 *
 * Exit codes: 0 the sync ran (whether or not it changed anything), 1 invalid
 * payload or tool failure. A service the catalog does not model, and a release
 * line it does not carry, are both successful no-ops — slim-services publishes
 * for consumers beyond this catalog.
 *
 * `planCatalogUpdate` is pure and unit-tested in `sync-workload-catalog.test.ts`;
 * `main()` wires up the real filesystem.
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

/**
 * The release line a version belongs to: its leading numeric component, with
 * any `v` prefix stripped. Used only to disambiguate services that carry
 * several supported lines at once (today just postgres, 17.x alongside 15.x).
 */
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

/**
 * The `native("<service>", "<version>", "<image>"` positional arguments. The
 * image is anchored to this service's own slim repository, so `postgres` cannot
 * match `postgrest` and vice versa.
 */
function defaultEntryPattern(service: string): RegExp {
  const s = escapeRegExp(service);
  return new RegExp(
    `(native\\(\\s*"${s}",\\s*")([^"]+)("\\s*,\\s*")(${escapeRegExp(SLIM_IMAGE_PREFIX)}${s}:[^"]+)(")`,
  );
}

/**
 * Entries of an `additionalReleases` map for this service: `"<version>":
 * "<image>"`. The `:` between key and value is what separates these from the
 * positional arguments above; `\s` spans the line break oxfmt introduces when
 * a digest-pinned value wraps.
 */
function additionalEntryPattern(service: string, version?: string): RegExp {
  const s = escapeRegExp(service);
  const key = version === undefined ? `[^"]+` : escapeRegExp(version);
  // Groups: 1 the version key, 2 the key/value separator (preserved so the
  // rewrite keeps oxfmt's existing wrapping), 3 the container image.
  return new RegExp(
    `"(${key})"(\\s*:\\s*)"(${escapeRegExp(SLIM_IMAGE_PREFIX)}${s}:[^"]+)"`,
    version === undefined ? "g" : "",
  );
}

function slimImageRef(service: string, version: string, digest: string): string {
  return `${SLIM_IMAGE_PREFIX}${service}:${version}@${digest}`;
}

/**
 * Rewrites the catalog entry for `service` onto `version`/`digest`, or explains
 * why there was nothing to do.
 */
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

  // With one modelled line there is no ambiguity — every release bumps the
  // default. With several (postgres), the release line decides which one moves,
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
