export const SLIM_GHCR_PREFIX = "ghcr.io/supabase/cli/";
export const SLIM_ECR_PREFIX = "public.ecr.aws/supabase/cli/";

export type ArtifactHostHint = "default" | "claude" | "codex" | "cursor";

export type NativeFetchCandidate =
  | {
      readonly kind: "github";
      readonly downloadUrl: string;
      readonly manifestUrl: string;
      readonly checksumUrl: string;
    }
  | {
      readonly kind: "oci";
      readonly registry: string;
      readonly repository: string;
      readonly tag: string;
    };

const present = (value: string | undefined): boolean => value !== undefined && value.trim() !== "";

/** Claude / Codex / Cursor markers reorder candidates; they never drop a host. */
export const detectArtifactHostHint = (
  env: Readonly<Record<string, string | undefined>>,
): ArtifactHostHint => {
  if (
    present(env["CLAUDE_CODE_REMOTE"]) ||
    present(env["CLAUDECODE"]) ||
    present(env["CLAUDE_CODE"])
  )
    return "claude";
  if (present(env["CODEX_SANDBOX"]) || present(env["CODEX_THREAD_ID"]) || present(env["CODEX_CI"]))
    return "codex";
  if (present(env["CURSOR_AGENT"])) return "cursor";
  return "default";
};

export const isSlimCatalogImage = (image: string): boolean =>
  image.startsWith(SLIM_GHCR_PREFIX) || image.startsWith(SLIM_ECR_PREFIX);

const slimSuffix = (image: string): string | undefined => {
  if (image.startsWith(SLIM_GHCR_PREFIX)) return image.slice(SLIM_GHCR_PREFIX.length);
  if (image.startsWith(SLIM_ECR_PREFIX)) return image.slice(SLIM_ECR_PREFIX.length);
  return undefined;
};

/** Host-prefix swap that keeps `:tag` and `@sha256` when present. */
export const rewriteSlimImageHost = (image: string, hostPrefix: string): string => {
  const suffix = slimSuffix(image);
  if (suffix === undefined) return image;
  const prefix = hostPrefix.endsWith("/") ? hostPrefix : `${hostPrefix}/`;
  return `${prefix}${suffix}`;
};

type SlimRegistryMapping =
  | { readonly kind: "unchanged" }
  | { readonly kind: "github" }
  | { readonly kind: "prefix"; readonly value: string };

const overridePrefix = (registryOverride: string): SlimRegistryMapping => {
  const registry = registryOverride.trim().toLowerCase();
  if (registry.length === 0) return { kind: "unchanged" };
  if (registry === "docker.io") return { kind: "github" };
  if (registry === "ghcr.io") return { kind: "prefix", value: SLIM_GHCR_PREFIX };
  if (registry === "public.ecr.aws") return { kind: "prefix", value: SLIM_ECR_PREFIX };
  return { kind: "prefix", value: `${registry}/supabase/cli/` };
};

const mappingFor = (registryOverride: string | undefined): SlimRegistryMapping =>
  registryOverride === undefined ? { kind: "unchanged" } : overridePrefix(registryOverride);

export const slimImagePullCandidates = (
  image: string,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly registryOverride?: string;
  } = {},
): ReadonlyArray<string> => {
  if (!isSlimCatalogImage(image)) return [image];
  const mapped = mappingFor(options.registryOverride);
  if (mapped.kind === "prefix") return [rewriteSlimImageHost(image, mapped.value)];
  if (mapped.kind === "github") return [rewriteSlimImageHost(image, SLIM_GHCR_PREFIX)];
  const ecr = rewriteSlimImageHost(image, SLIM_ECR_PREFIX);
  const ghcr = rewriteSlimImageHost(image, SLIM_GHCR_PREFIX);
  const hint = detectArtifactHostHint(options.env ?? {});
  const ordered = hint === "codex" || hint === "cursor" ? [ghcr, ecr] : [ecr, ghcr];
  return [...new Set(ordered)];
};

const nativeOciTag = (version: string, target: string): string => `${version}-native-${target}`;

export const nativeArtifactCandidates = (
  artifact: {
    readonly service: string;
    readonly version: string;
    readonly target: string;
    readonly downloadUrl: string;
    readonly manifestUrl: string;
    readonly checksumUrl: string;
  },
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly registryOverride?: string;
  } = {},
): ReadonlyArray<NativeFetchCandidate> => {
  const repository = `supabase/cli/${artifact.service}`;
  const tag = nativeOciTag(artifact.version, artifact.target);
  const github: NativeFetchCandidate = {
    kind: "github",
    downloadUrl: artifact.downloadUrl,
    manifestUrl: artifact.manifestUrl,
    checksumUrl: artifact.checksumUrl,
  };
  const oci = (registry: string): NativeFetchCandidate => ({
    kind: "oci",
    registry,
    repository,
    tag,
  });
  const mapped = mappingFor(options.registryOverride);
  if (mapped.kind === "github") return [github];
  if (mapped.kind === "prefix") {
    const host = mapped.value.replace(/\/supabase\/cli\/$/u, "").replace(/\/$/u, "");
    return [oci(host)];
  }
  const hint = detectArtifactHostHint(options.env ?? {});
  const ecr = oci("public.ecr.aws");
  const ghcr = oci("ghcr.io");
  return hint === "codex" || hint === "cursor" ? [ghcr, github, ecr] : [ecr, ghcr, github];
};
