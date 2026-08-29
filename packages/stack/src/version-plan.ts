import {
  diffPinnedAndAvailableVersions,
  fillServiceVersionManifest,
  normalizeServiceVersions,
  SERVICE_NAMES,
  type AvailableServiceVersionUpdate,
  type ServiceName,
  type VersionRuntime,
  type VersionManifest,
} from "./versions.ts";

export interface StackVersionOverride {
  readonly service: ServiceName;
  readonly version: string;
  readonly source: "flag" | "local";
}

export interface StackVersionPlanInput {
  readonly runtime?: VersionRuntime;
  readonly candidateBaseline?: Partial<Record<ServiceName, string | undefined>>;
  readonly pinnedBaseline?: Partial<Record<ServiceName, string | undefined>>;
  readonly localOverrides?: Partial<Record<ServiceName, string | undefined>>;
  readonly flagOverrides?: Partial<Record<ServiceName, string | undefined>>;
}

export interface StackVersionPlan {
  readonly candidateBaseline: VersionManifest;
  readonly pinnedBaseline: VersionManifest;
  readonly runtimeVersions: VersionManifest;
  readonly activeOverrides: ReadonlyArray<StackVersionOverride>;
  readonly availableUpdates: ReadonlyArray<AvailableServiceVersionUpdate>;
  readonly updateFingerprint: string | undefined;
}

function fingerprintAvailableVersionUpdates(
  updates: ReadonlyArray<AvailableServiceVersionUpdate>,
): string | undefined {
  if (updates.length === 0) {
    return undefined;
  }

  return updates
    .map(
      ({ service, pinnedVersion, availableVersion }) =>
        `${service}:${pinnedVersion}->${availableVersion}`,
    )
    .join("|");
}

export function planStackVersions(input: StackVersionPlanInput): StackVersionPlan {
  const runtime = input.runtime ?? "native";
  const candidateBaseline = fillServiceVersionManifest(
    normalizeServiceVersions(input.candidateBaseline ?? {}, runtime),
    runtime,
  );
  const pinnedBaseline = fillServiceVersionManifest(
    normalizeServiceVersions(input.pinnedBaseline ?? candidateBaseline, runtime),
    runtime,
  );
  const localOverrides = normalizeServiceVersions(input.localOverrides ?? {}, runtime);
  const flagOverrides = normalizeServiceVersions(input.flagOverrides ?? {}, runtime);

  const activeOverrideMap = new Map<ServiceName, StackVersionOverride>();
  for (const service of SERVICE_NAMES) {
    const localVersion = localOverrides[service];
    if (localVersion !== undefined) {
      activeOverrideMap.set(service, {
        service,
        version: localVersion,
        source: "local",
      });
    }
  }
  for (const service of SERVICE_NAMES) {
    const flagVersion = flagOverrides[service];
    if (flagVersion !== undefined) {
      activeOverrideMap.set(service, {
        service,
        version: flagVersion,
        source: "flag",
      });
    }
  }

  const runtimeVersions = fillServiceVersionManifest(
    {
      ...pinnedBaseline,
      ...localOverrides,
      ...flagOverrides,
    },
    runtime,
  );
  const availableUpdates = diffPinnedAndAvailableVersions(pinnedBaseline, candidateBaseline);

  return {
    candidateBaseline,
    pinnedBaseline,
    runtimeVersions,
    activeOverrides: SERVICE_NAMES.flatMap((service) => {
      const override = activeOverrideMap.get(service);
      return override === undefined ? [] : [override];
    }),
    availableUpdates,
    updateFingerprint: fingerprintAvailableVersionUpdates(availableUpdates),
  };
}
