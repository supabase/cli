import type { AvailableServiceVersionUpdate, StackMetadata } from "@supabase/stack/effect";
import {
  diffPinnedAndAvailableVersions,
  fillServiceVersionManifest,
  normalizeServiceVersions,
} from "@supabase/stack/effect";
import { Effect } from "effect";
import { ProjectLinkRemote } from "./project-link-remote.service.ts";
import { ProjectLinkState } from "./project-link-state.service.ts";

interface StackNeedsVersionUpdate {
  readonly stackName: string;
  readonly diff: ReadonlyArray<AvailableServiceVersionUpdate>;
}

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
  stackMetadata: ReadonlyMap<string, StackMetadata>,
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

  const stacksNeedingUpdate = Array.from(stackMetadata.entries())
    .map(([stackName, metadata]) => ({
      stackName,
      diff: diffPinnedAndAvailableVersions(metadata.services, availableBaseline),
    }))
    .filter(({ diff }) => diff.length > 0);

  return {
    linkedProject,
    stacksNeedingUpdate,
  } satisfies RefreshedLinkedProjectSnapshot;
});
