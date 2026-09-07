import type { Effect } from "effect";
import { Context } from "effect";
import type { LinkedServiceVersions } from "./project-link-state.service.ts";

const linkedProjectVersionServices = ["postgres", "postgrest", "auth", "storage"] as const;

type LinkedProjectVersionService = (typeof linkedProjectVersionServices)[number];

interface AccessibleProject {
  readonly ref: string;
  readonly name: string;
  readonly region: string;
  readonly status: string;
  readonly organizationId: string;
  readonly organizationSlug: string;
}

interface LinkedProjectSnapshot extends AccessibleProject {
  readonly versions: LinkedServiceVersions;
  readonly unavailableServices: ReadonlyArray<LinkedProjectVersionService>;
}

interface ProjectLinkRemoteShape {
  readonly listAccessibleProjects: Effect.Effect<ReadonlyArray<AccessibleProject>, unknown>;
  readonly fetchLinkedProject: (
    projectRef: string,
  ) => Effect.Effect<LinkedProjectSnapshot, unknown>;
}

export class ProjectLinkRemote extends Context.Service<ProjectLinkRemote, ProjectLinkRemoteShape>()(
  "supabase/cli/ProjectLinkRemote",
) {}
