import { validateEnabledServiceDependencies } from "./serviceDependencies.ts";
import type { StackConfig } from "./StackBuilder.ts";
import type { ServiceName, VersionManifest } from "./versions.ts";

export type ProvisionedServiceName = Exclude<ServiceName, "postgres">;

export type ProvisionedStackVersions = Pick<VersionManifest, "postgres"> &
  Partial<Omit<VersionManifest, "postgres">>;

/**
 * The complete interface required to run a pre-initialized micro-profile data
 * directory. Callers describe the pod; @supabase/stack owns how that becomes a
 * StackConfig, including native mode, service disabling, and version mapping.
 */
export interface ProvisionedStackOptions {
  readonly dataDir: string;
  readonly postgresPassword: string;
  readonly versions: ProvisionedStackVersions;
  readonly enabledServices?: ReadonlyArray<ProvisionedServiceName>;
  readonly stackRoot?: string;
  readonly lazyServices?: boolean;
}

function versionedService(
  name: ProvisionedServiceName,
  options: ProvisionedStackOptions,
): { readonly version: string } | false {
  if (!options.enabledServices?.includes(name)) return false;
  const version = options.versions[name];
  if (version === undefined) {
    throw new Error(`versions.${name} is required when ${name} is enabled`);
  }
  return { version };
}

/** Internal resolver kept separate so the deep public constructor stays easy to verify. */
export function provisionedStackConfig(options: ProvisionedStackOptions): StackConfig {
  const enabledServices = new Set<ServiceName>(options.enabledServices ?? []);
  const dependencyError = validateEnabledServiceDependencies(enabledServices);
  if (dependencyError !== undefined) throw new Error(dependencyError);

  return {
    mode: "native",
    stackRoot: options.stackRoot,
    lazyServices: options.lazyServices,
    postgres: {
      dataDir: options.dataDir,
      version: options.versions.postgres,
      password: options.postgresPassword,
      provisioned: true,
      profile: "micro",
    },
    postgrest: versionedService("postgrest", options),
    auth: versionedService("auth", options),
    edgeRuntime: versionedService("edge-runtime", options),
    realtime: versionedService("realtime", options),
    storage: versionedService("storage", options),
    imgproxy: versionedService("imgproxy", options),
    mailpit: versionedService("mailpit", options),
    pgmeta: versionedService("pgmeta", options),
    studio: versionedService("studio", options),
    analytics: versionedService("analytics", options),
    vector: versionedService("vector", options),
    pooler: versionedService("pooler", options),
    functions: false,
  };
}
