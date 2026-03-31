import { Effect, Option } from "effect";
import { StateManager, resolveDaemonConfig, stackMetadata } from "@supabase/stack/effect";
import { ensureProjectStateIgnored } from "../../config/project-gitignore.ts";
import { CliConfig } from "../../config/cli-config.service.ts";
import { ProjectHome } from "../../config/project-home.service.ts";
import { refreshLinkedProjectSnapshot } from "../../config/project-link-refresh.ts";
import {
  formatLinkedProjectLabel,
  linkedProjectVersionServices,
} from "../../config/project-link-remote.service.ts";
import { ProjectLinkState } from "../../config/project-link-state.service.ts";
import { resolveServiceVersionContext } from "../../config/service-version-resolution.ts";
import { toStartStackConfig, withServiceVersions } from "../../config/stack-config.ts";
import { Output } from "../../output/output.service.ts";
import { RuntimeInfo } from "../../runtime/runtime-info.service.ts";
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
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const projectLinkState = yield* ProjectLinkState;
  const runtimeInfo = yield* RuntimeInfo;
  const stateManager = yield* StateManager;

  yield* output.intro("Update local Supabase stack versions");
  yield* ensureProjectStateIgnored(projectHome.projectRoot);

  const linkedState = yield* projectLinkState.load;
  if (Option.isSome(linkedState)) {
    const refreshed = yield* refreshLinkedProjectSnapshot(
      linkedState.value.project.ref,
      yield* stateManager.scanMetadata(),
    );
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

  const existingMetadata = yield* stateManager.readMetadata(flags.stack).pipe(
    Effect.map(Option.some),
    Effect.catchTag("StackMetadataNotFoundError", () => Effect.succeed(Option.none())),
  );
  const serviceVersionContext = yield* resolveServiceVersionContext(
    [],
    Option.match(existingMetadata, {
      onNone: () => undefined,
      onSome: (metadata) => metadata.services,
    }),
  );

  const resolvedConfig = yield* Effect.promise(() =>
    resolveDaemonConfig({
      cacheRoot: cliConfig.supabaseHome,
      cwd: runtimeInfo.cwd,
      projectDir: projectHome.projectRoot,
      projectStateRoot: projectHome.projectHomeDir,
      name: flags.stack,
      ...withServiceVersions(
        toStartStackConfig([], "auto"),
        serviceVersionContext.candidateBaseline,
      ),
    }),
  );

  yield* stateManager.writeMetadata(
    flags.stack,
    stackMetadata({
      ports: resolvedConfig.ports,
      services: serviceVersionContext.candidateBaseline,
    }),
  );

  if (serviceVersionContext.availableUpdates.length === 0) {
    yield* output.success("Pinned stack versions are already up to date.");
  } else {
    yield* output.success("Updated pinned local stack versions.", {
      stack: flags.stack,
      versions: serviceVersionContext.candidateBaseline,
    });
    yield* output.info("Pinned versions updated:");
    for (const updateEntry of serviceVersionContext.availableUpdates) {
      yield* output.info(
        `${updateEntry.service}: ${updateEntry.pinnedVersion} -> ${updateEntry.availableVersion}`,
      );
    }
  }

  const runningState = yield* stateManager.read(flags.stack).pipe(
    Effect.map(Option.some),
    Effect.catchTag("StateNotFoundError", () => Effect.succeed(Option.none())),
  );
  if (Option.isSome(runningState) && (yield* stateManager.isAlive(runningState.value))) {
    yield* output.warn(
      "This stack is currently running. Stop and start it again to apply the updated pinned versions.",
    );
  }

  yield* output.outro(`Pinned versions are ready for stack ${flags.stack}.`);
});
