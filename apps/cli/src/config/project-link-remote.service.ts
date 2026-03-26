import type { Effect } from "effect";
import { ServiceMap } from "effect";
import type { LinkedServiceVersions } from "./project-link-state.service.ts";

export const linkedProjectVersionServices = ["postgres", "postgrest", "auth", "storage"] as const;

export function formatLinkedProjectLabel(project: { ref: string; name?: string }): string {
  return project.name === undefined ? project.ref : `${project.name} (${project.ref})`;
}

export type LinkedProjectVersionService = (typeof linkedProjectVersionServices)[number];

export interface AccessibleProject {
  readonly ref: string;
  readonly name: string;
  readonly region: string;
  readonly status: string;
}

export interface LinkedProjectSnapshot extends AccessibleProject {
  readonly versions: LinkedServiceVersions;
  readonly unavailableServices: ReadonlyArray<LinkedProjectVersionService>;
}

interface ProjectLinkRemoteShape {
  readonly listAccessibleProjects: Effect.Effect<ReadonlyArray<AccessibleProject>, unknown>;
  readonly fetchLinkedProject: (
    projectRef: string,
  ) => Effect.Effect<LinkedProjectSnapshot, unknown>;
}

export class ProjectLinkRemote extends ServiceMap.Service<
  ProjectLinkRemote,
  ProjectLinkRemoteShape
>()("@supabase/cli/config/ProjectLinkRemote") {}
