import { SupabaseApiClient, v1ListAllBranches } from "@supabase/api/effect";
import {
  StateManager,
  daemonLayer,
  resolveDaemonConfig,
  resolveManagedStack,
  stopDaemon,
} from "@supabase/stack/effect";
import { daemonEntryPoint } from "@supabase/stack";
import { Effect, Option } from "effect";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import {
  ProjectLinkState,
  ProjectNotLinkedError,
} from "../../../config/project-link-state.service.ts";
import { toStartStackConfig, withServiceVersions } from "../../../config/stack-config.ts";
import { NonInteractiveError } from "../../../output/errors.ts";
import { Output } from "../../../output/output.service.ts";
import { RuntimeInfo } from "../../../runtime/runtime-info.service.ts";
import { printStackConnectionInfo, startStackWithProgress } from "../../../stack/stack.shared.ts";
import { BranchNotFoundError } from "../errors.ts";

export const switchBranch = Effect.fn("branches.switch")(function* (opts: {
  name: Option.Option<string>;
}) {
  const output = yield* Output;
  const projectLinkState = yield* ProjectLinkState;
  const apiClient = yield* SupabaseApiClient;
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;
  const stateManager = yield* StateManager;

  yield* output.intro("Switch branch");

  const maybeLinkState = yield* projectLinkState.load;
  if (Option.isNone(maybeLinkState)) {
    return yield* Effect.fail(
      new ProjectNotLinkedError({
        detail: "No project is linked in this directory.",
        suggestion: "Run `supabase link` first.",
      }),
    );
  }

  const { project, active_branch } = maybeLinkState.value;
  const fetching = yield* output.task("Fetching branches...");
  const branches = yield* v1ListAllBranches({ ref: project.ref }).pipe(
    Effect.provideService(SupabaseApiClient, apiClient),
    Effect.tapError(() => fetching.fail()),
  );
  yield* fetching.clear();

  let target: (typeof branches)[number];

  if (Option.isSome(opts.name)) {
    const query = opts.name.value;
    const found = branches.find((b) => b.name === query || b.project_ref === query);
    if (found === undefined) {
      return yield* Effect.fail(
        new BranchNotFoundError({
          detail: `Branch '${query}' not found.`,
          suggestion: "Run `supabase branches list` to see available branches.",
        }),
      );
    }
    target = found;
  } else if (output.interactive) {
    const selected = yield* output.promptSelect(
      "Select a branch to switch to",
      branches.map((b) => ({
        value: b.project_ref,
        label: b.name,
        hint: b.project_ref,
      })),
    );
    const found = branches.find((b) => b.project_ref === selected);
    if (found === undefined) {
      return yield* Effect.fail(
        new BranchNotFoundError({
          detail: `Selected branch could not be resolved.`,
          suggestion: "Run `supabase branches list` to see available branches.",
        }),
      );
    }
    target = found;
  } else {
    return yield* Effect.fail(
      new NonInteractiveError({
        detail: "No branch name provided.",
        suggestion: "Run `supabase branches switch <name>` or use an interactive terminal.",
      }),
    );
  }

  if (target.project_ref === active_branch.ref) {
    yield* output.outro(`Already on branch '${target.name}'.`);
    return;
  }

  yield* projectLinkState.setActiveBranch({
    ref: target.project_ref,
    name: target.name,
    is_default: target.is_default,
  });

  if (output.format !== "text") {
    yield* output.success("Switched", {
      branch: {
        ref: target.project_ref,
        name: target.name,
        is_default: target.is_default,
      },
    });
  } else {
    yield* output.outro(`Switched to branch '${target.name}'.`);
  }

  // If a local stack is running, stop and restart it against the new branch.
  const stackCheck = yield* resolveManagedStack({
    cacheRoot: cliConfig.supabaseHome,
    cwd: runtimeInfo.cwd,
    projectDir: projectHome.projectRoot,
    projectStateRoot: projectHome.projectHomeDir,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
    Effect.catchTag("InvalidStackStateError", () => Effect.succeed(Option.none())),
  );

  if (Option.isSome(stackCheck) && stackCheck.value.alive) {
    const { state: stackState } = stackCheck.value;

    const maybeMetadata = yield* stateManager.readMetadata(stackState.name).pipe(
      Effect.map(Option.some),
      Effect.catchTag("StackMetadataNotFoundError", () => Effect.succeed(Option.none())),
    );

    const stopping = yield* output.task("Stopping local stack...");
    yield* stopDaemon({
      cwd: runtimeInfo.cwd,
      cacheRoot: cliConfig.supabaseHome,
      projectDir: projectHome.projectRoot,
      projectStateRoot: projectHome.projectHomeDir,
      name: stackState.name,
    }).pipe(Effect.tapError(() => stopping.fail()));
    yield* stopping.clear();

    // TODO: run `supabase pull` against the new branch before restarting the stack
    // so the local config reflects the branch's migrations and seed state.
    // `pull` does not exist yet.
    const launchConfig = Option.match(maybeMetadata, {
      onNone: () => toStartStackConfig([], "auto"),
      onSome: (metadata) => {
        const base =
          metadata.launch !== undefined
            ? toStartStackConfig(metadata.launch.excludedServices, metadata.launch.mode)
            : toStartStackConfig([], "auto");
        return withServiceVersions(base, metadata.services);
      },
    });

    const resolvedConfig = yield* Effect.promise(() =>
      resolveDaemonConfig({
        cacheRoot: cliConfig.supabaseHome,
        cwd: runtimeInfo.cwd,
        projectDir: projectHome.projectRoot,
        projectStateRoot: projectHome.projectHomeDir,
        name: stackState.name,
        ...launchConfig,
      }),
    );

    const stackLayer = yield* daemonLayer(
      { ...resolvedConfig, name: stackState.name, projectDir: projectHome.projectRoot },
      daemonEntryPoint,
    );

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* startStackWithProgress().pipe(Effect.provide(stackLayer));
        yield* printStackConnectionInfo().pipe(Effect.provide(stackLayer));
      }),
    );

    if (output.format === "text") {
      yield* output.info(
        "The local stack was restarted in detach mode.\n" +
          "Run `supabase stop` to stop it or `supabase status` to check its status.",
      );
    }
  }
});
