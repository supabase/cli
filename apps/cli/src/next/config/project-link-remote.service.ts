import type { SupabaseApiError } from "@supabase/api/effect";
import { Context, Data } from "effect";
import type { Effect } from "effect";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../shared/telemetry/error-actionability.ts";
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
  readonly organizationId: string;
  readonly organizationSlug: string;
}

export interface LinkedProjectSnapshot extends AccessibleProject {
  readonly versions: LinkedServiceVersions;
  readonly unavailableServices: ReadonlyArray<LinkedProjectVersionService>;
}

export class NoProjectApiKeyError extends Data.TaggedError("NoProjectApiKeyError")<{
  readonly projectRef: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return { ...actionability.apiStatus, fingerprint_suffix: "api_response" };
  }
}

export type ProjectLinkRemoteError = SupabaseApiError | NoProjectApiKeyError;

interface ProjectLinkRemoteShape {
  readonly listAccessibleProjects: Effect.Effect<
    ReadonlyArray<AccessibleProject>,
    SupabaseApiError
  >;
  readonly fetchLinkedProject: (
    projectRef: string,
  ) => Effect.Effect<LinkedProjectSnapshot, ProjectLinkRemoteError>;
}

export class ProjectLinkRemote extends Context.Service<ProjectLinkRemote, ProjectLinkRemoteShape>()(
  "supabase/config/ProjectLinkRemote",
) {}
