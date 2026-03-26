import { Effect, Option } from "effect";
import { StateManager, projectStateManagerPathsFromRoot } from "@supabase/stack/effect";
import { ensureProjectStateIgnored } from "../../config/project-gitignore.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { refreshLinkedProjectSnapshot } from "../../config/project-link-refresh.ts";
import {
  ProjectLinkRemote,
  formatLinkedProjectLabel,
  linkedProjectVersionServices,
} from "../../config/project-link-remote.service.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { Output } from "../../output/output.service.ts";
import type { LinkFlags } from "./link.command.ts";
import { NoAccessibleProjectsError, ProjectRefRequiredError } from "./link.errors.ts";

const promptForAccessibleProject = Effect.fnUntraced(function* () {
  const output = yield* Output;
  const remote = yield* ProjectLinkRemote;
  const projects = yield* remote.listAccessibleProjects;
  if (projects.length === 0) {
    return yield* Effect.fail(
      new NoAccessibleProjectsError({
        detail: "No accessible Supabase projects were found for this account.",
        suggestion: "Create a project in the dashboard or log in with a different account.",
      }),
    );
  }

  return yield* output.promptSelect(
    "Select a Supabase project to link",
    projects.map((project) => ({
      value: project.ref,
      label: project.name,
      hint: `${project.ref} | ${project.region} | ${project.status}`,
    })),
    {
      mode: "auto",
      placeholder: "Search projects...",
      maxItems: 10,
    },
  );
});

const chooseProjectRef = Effect.fnUntraced(function* (flagProjectRef: Option.Option<string>) {
  const output = yield* Output;

  if (Option.isSome(flagProjectRef)) {
    return flagProjectRef.value.trim();
  }

  const projectLinkState = yield* ProjectLinkState;
  const cachedLinkState = yield* projectLinkState.load;
  if (Option.isSome(cachedLinkState)) {
    if (!output.interactive) {
      yield* output.info(
        `This local project is already linked to ${formatLinkedProjectLabel(cachedLinkState.value)}; refreshing linked project metadata.`,
      );
      return cachedLinkState.value.ref;
    }

    yield* output.info(
      `This local project is already linked to ${formatLinkedProjectLabel(cachedLinkState.value)}.`,
    );
    const action = yield* output.promptSelect(
      "What would you like to do?",
      [
        {
          value: "refresh",
          label: "Refresh linked metadata",
          hint: `Refresh the current linked project metadata for ${formatLinkedProjectLabel(cachedLinkState.value)}`,
        },
        {
          value: "relink",
          label: "Choose a different project",
          hint: "Select another accessible Supabase project",
        },
      ],
      { mode: "select" },
    );

    if (action === "refresh") {
      return cachedLinkState.value.ref;
    }

    return yield* promptForAccessibleProject();
  }

  if (!output.interactive) {
    return yield* Effect.fail(
      new ProjectRefRequiredError({
        detail: "A project ref is required in non-interactive mode.",
        suggestion: "Pass --project-ref or link this checkout interactively first.",
      }),
    );
  }

  return yield* promptForAccessibleProject();
});

const printLinkedVersions = Effect.fnUntraced(function* (
  versions: Record<string, string | undefined>,
) {
  const output = yield* Output;
  for (const service of linkedProjectVersionServices) {
    const version = versions[service];
    if (version !== undefined) {
      yield* output.info(`${service}: ${version}`);
    }
  }
});

export const link = Effect.fnUntraced(function* (flags: LinkFlags) {
  const output = yield* Output;
  const projectHome = yield* ProjectHome;
  const stateManager = yield* StateManager.asEffect().pipe(
    Effect.provide(StateManager.make(projectStateManagerPathsFromRoot(projectHome.projectHomeDir))),
  );

  yield* output.intro("Link local project to Supabase");

  const projectRef = yield* chooseProjectRef(flags.projectRef);
  yield* ensureProjectStateIgnored(projectHome.projectRoot);
  const refreshed = yield* refreshLinkedProjectSnapshot(
    projectRef,
    yield* stateManager.scanMetadata(),
  );
  const linkedProject = refreshed.linkedProject;

  yield* output.success(`Linked to project ${linkedProject.ref}.`, {
    project_ref: linkedProject.ref,
    project_name: linkedProject.name,
    region: linkedProject.region,
    status: linkedProject.status,
    versions: linkedProject.versions,
    unavailable_services: linkedProject.unavailableServices,
  });

  yield* output.info("Updated cached linked service versions:");
  yield* printLinkedVersions(linkedProject.versions);

  if (linkedProject.unavailableServices.length > 0) {
    yield* output.warn(
      `Some remote service versions could not be fetched and will keep using CLI defaults: ${linkedProject.unavailableServices.join(", ")}`,
    );
  }

  if (refreshed.stacksNeedingUpdate.length > 0) {
    yield* output.warn(
      [
        "Linked project versions changed for local stack metadata:",
        ...refreshed.stacksNeedingUpdate.map(
          ({ stackName, diff }) =>
            `  ${stackName}: ${diff.map(({ service, pinnedVersion, availableVersion }) => `${service} ${pinnedVersion} -> ${availableVersion}`).join(", ")}`,
        ),
        "Run `supabase stack update` to adopt the refreshed pinned versions.",
      ].join("\n"),
    );
  }

  yield* output.outro(`Linked local project to ${linkedProject.name} (${linkedProject.ref}).`);
});
