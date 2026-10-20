import { Effect } from "effect";

import type { Analytics } from "./analytics.service.ts";
import { GroupOrganization, GroupProject } from "./event-catalog.ts";

interface IdentifiedProject {
  readonly ref: string;
  readonly name: string;
  readonly organization_id: string;
  readonly organization_slug: string;
}

/** Publishes the organization and project group metadata for a linked project. */
export const identifyProjectGroups = Effect.fnUntraced(function* (
  analytics: typeof Analytics.Service,
  project: IdentifiedProject,
) {
  if (project.organization_id.length > 0) {
    yield* analytics.groupIdentify(GroupOrganization, project.organization_id, {
      organization_slug: project.organization_slug,
    });
  }
  if (project.ref.length > 0) {
    yield* analytics.groupIdentify(GroupProject, project.ref, {
      name: project.name,
      organization_slug: project.organization_slug,
    });
  }
});
