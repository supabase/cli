import { Effect, Option } from "effect";
import { ensureProjectStateIgnored } from "../../config/project-gitignore.ts";
import { CliProjectHome } from "../../config/cli-project-home.service.ts";
import { refreshLinkedProjectSnapshot } from "../../config/project-link-refresh.ts";
import {
  formatLinkedProjectLabel,
  linkedProjectVersionServices,
} from "../../config/project-link-remote.service.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import type { UpdateFlags } from "./update.command.ts";

function diffCachedLinkedVersions(
  previous: Record<string, string | undefined>,
  next: Record<string, string | undefined>,
) {
  return linkedProjectVersionServices.flatMap((service) => {
    const previousVersion = previous[service];
    const nextVersion = next[service];
    if (previousVersion === nextVersion || nextVersion === undefined) {
      return [];
    }
    return [
      {
        service,
        previousVersion: previousVersion ?? "not cached",
        nextVersion,
      },
    ];
  });
}

export const update = Effect.fnUntraced(function* (flags: UpdateFlags) {
  const output = yield* Output;
  const cliProjectHome = yield* CliProjectHome;
  const projectLinkState = yield* ProjectLinkState;

  yield* output.intro("Refresh linked project metadata");
  yield* ensureProjectStateIgnored(cliProjectHome.projectRoot);

  const linkedState = yield* projectLinkState.load;
  if (Option.isSome(linkedState)) {
    const refreshed = yield* refreshLinkedProjectSnapshot(linkedState.value.project.ref, []);
    const changedVersions = diffCachedLinkedVersions(
      linkedState.value.versions,
      refreshed.linkedProject.versions,
    );

    yield* output.info(`Project: ${formatLinkedProjectLabel(refreshed.linkedProject)}`);
    if (changedVersions.length === 0) {
      yield* output.info("Linked project service versions are already up to date.");
    } else {
      yield* output.info("Updated linked project service versions:");
      for (const changedVersion of changedVersions) {
        yield* output.info(
          `${changedVersion.service}: ${changedVersion.previousVersion} -> ${changedVersion.nextVersion}`,
        );
      }
    }

    if (refreshed.linkedProject.unavailableServices.length > 0) {
      yield* output.warn(
        `Some remote service versions could not be fetched and will keep using CLI defaults: ${refreshed.linkedProject.unavailableServices.join(", ")}`,
      );
    }
  }

  yield* output.success("Stack configuration is up to date.", { stack: flags.stack });
  yield* output.outro(`Stack ${flags.stack} is ready.`);
});
