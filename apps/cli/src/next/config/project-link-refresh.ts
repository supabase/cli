import { Effect } from "effect";
import { ProjectLinkRemote } from "./project-link-remote.service.ts";
import { ProjectLinkState } from "./project-link-state.service.ts";

export interface VersionManifest {
  readonly [service: string]: string | undefined;
}

export interface AvailableServiceVersionUpdate {
  readonly service: string;
  readonly pinnedVersion: string | undefined;
  readonly availableVersion: string | undefined;
}

interface StackNeedsVersionUpdate {
  readonly stackName: string;
  readonly diff: ReadonlyArray<AvailableServiceVersionUpdate>;
}

const fillServiceVersionManifest = (versions: VersionManifest): VersionManifest => ({
  ...versions,
});
const normalizeServiceVersions = (versions: VersionManifest): VersionManifest => ({ ...versions });
const diffPinnedAndAvailableVersions = (
  pinned: VersionManifest,
  available: VersionManifest,
): ReadonlyArray<AvailableServiceVersionUpdate> =>
  Object.keys(available).flatMap((service) =>
    pinned[service] === available[service]
      ? []
      : [{ service, pinnedVersion: pinned[service], availableVersion: available[service] }],
  );

interface RefreshedLinkedProjectSnapshot {
  readonly linkedProject: {
    readonly ref: string;
    readonly name: string;
    readonly region: string;
    readonly status: string;
    readonly organizationId: string;
    readonly organizationSlug: string;
    readonly versions: {
      readonly postgres?: string;
      readonly postgrest?: string;
      readonly auth?: string;
      readonly storage?: string;
    };
    readonly unavailableServices: ReadonlyArray<"postgres" | "postgrest" | "auth" | "storage">;
  };
  readonly stacksNeedingUpdate: ReadonlyArray<StackNeedsVersionUpdate>;
}

export const refreshLinkedProjectSnapshot = Effect.fnUntraced(function* (
  projectRef: string,
  stackMetadata: ReadonlyArray<{ readonly stackName: string; readonly services: VersionManifest }>,
) {
  const remote = yield* ProjectLinkRemote;
  const projectLinkState = yield* ProjectLinkState;

  const linkedProject = yield* remote.fetchLinkedProject(projectRef);

  yield* projectLinkState.save({
    project: {
      ref: linkedProject.ref,
      name: linkedProject.name,
      organization_id: linkedProject.organizationId,
      organization_slug: linkedProject.organizationSlug,
    },
    active_branch: {
      ref: linkedProject.ref,
      name: "main",
      is_default: true,
    },
    fetchedAt: new Date().toISOString(),
    versions: linkedProject.versions,
  });

  const availableBaseline = fillServiceVersionManifest(
    normalizeServiceVersions(linkedProject.versions),
  );

  const stacksNeedingUpdate = stackMetadata
    .map(({ stackName, services }) => ({
      stackName,
      diff: diffPinnedAndAvailableVersions(services, availableBaseline),
    }))
    .filter(({ diff }) => diff.length > 0);

  return {
    linkedProject,
    stacksNeedingUpdate,
  } satisfies RefreshedLinkedProjectSnapshot;
});
