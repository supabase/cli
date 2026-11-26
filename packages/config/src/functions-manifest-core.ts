import {
  edgeFunctionDenoConfigFileName,
  edgeFunctionEntrypointFileName,
  edgeFunctionsDirectoryName,
  type ResolvedFunctionConfig,
} from "./functions-manifest-model.ts";

export const functionSlugPattern = /^[a-zA-Z0-9_-]+$/;

export function filesystemFunctionConfig(
  slug: string,
  hasDenoJson: boolean,
): ResolvedFunctionConfig {
  return {
    enabled: true,
    verify_jwt: true,
    import_map: hasDenoJson
      ? `./${edgeFunctionsDirectoryName}/${slug}/${edgeFunctionDenoConfigFileName}`
      : "",
    entrypoint: `./${edgeFunctionsDirectoryName}/${slug}/${edgeFunctionEntrypointFileName}`,
    static_files: [],
    env: {},
  };
}

function defaultFunctionConfig(slug: string): ResolvedFunctionConfig {
  return filesystemFunctionConfig(slug, false);
}

function hasFunctionOverride(config: ResolvedFunctionConfig): boolean {
  return (
    config.enabled !== true ||
    config.verify_jwt !== true ||
    config.import_map !== "" ||
    config.entrypoint !== "" ||
    config.static_files.length > 0 ||
    Object.keys(config.env).length > 0
  );
}

function applyFunctionOverride(
  base: ResolvedFunctionConfig,
  override: ResolvedFunctionConfig | undefined,
): ResolvedFunctionConfig {
  if (override === undefined) {
    return base;
  }

  return {
    enabled: override.enabled === true ? base.enabled : override.enabled,
    verify_jwt: override.verify_jwt === true ? base.verify_jwt : override.verify_jwt,
    import_map: override.import_map === "" ? base.import_map : override.import_map,
    entrypoint: override.entrypoint === "" ? base.entrypoint : override.entrypoint,
    static_files: override.static_files.length === 0 ? base.static_files : override.static_files,
    env: Object.keys(override.env).length === 0 ? base.env : override.env,
  };
}

/** Merges filesystem-discovered functions with the config's `functions` overrides into the resolved manifest. */
export function buildFunctionsManifest(
  filesystemFunctions: Readonly<Record<string, ResolvedFunctionConfig>>,
  configFunctions: Readonly<Record<string, ResolvedFunctionConfig>>,
): Record<string, ResolvedFunctionConfig> {
  const slugs = [
    ...new Set([...Object.keys(filesystemFunctions), ...Object.keys(configFunctions)]),
  ].sort((left, right) => left.localeCompare(right));
  const manifest: Record<string, ResolvedFunctionConfig> = {};

  for (const slug of slugs) {
    const override = configFunctions[slug];
    const base = filesystemFunctions[slug] ?? defaultFunctionConfig(slug);
    if (
      filesystemFunctions[slug] === undefined &&
      override !== undefined &&
      !hasFunctionOverride(override)
    ) {
      continue;
    }

    manifest[slug] = applyFunctionOverride(base, override);
  }

  return manifest;
}
