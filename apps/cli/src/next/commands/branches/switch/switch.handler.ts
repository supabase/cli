import {
  connectLayer,
  daemonLayer,
  resolveManagedStack,
  Stack,
  stopDaemon,
} from "@supabase/stack/effect";
import { loadProjectConfig } from "@supabase/config/effect";
import { Effect, Option } from "effect";
import { PlatformApi } from "../../../auth/platform-api.service.ts";
import { CliConfig } from "../../../config/cli-config.service.ts";
import { ProjectHome } from "../../../config/project-home.service.ts";
import { managedPortIntents } from "../../../config/managed-port-intents.ts";
import {
  ProjectLinkState,
  ProjectNotLinkedError,
} from "../../../config/project-link-state.service.ts";
import {
  excludedStackServices,
  toStartStackConfig,
  withServiceVersions,
  type ExcludedStackService,
} from "../../../config/stack-config.ts";
import { NonInteractiveError } from "../../../../shared/output/errors.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { printStackConnectionInfo, startStackWithProgress } from "../../../stack/stack.shared.ts";
import { BranchNotFoundError } from "../errors.ts";
import { CLI_VERSION } from "../../../../shared/cli/version.ts";

export const switchBranch = Effect.fn("branches.switch")(function* (opts: {
  name: Option.Option<string>;
}) {
  const output = yield* Output;
  const projectLinkState = yield* ProjectLinkState;
  const api = yield* PlatformApi;
  const cliConfig = yield* CliConfig;
  const projectHome = yield* ProjectHome;
  const runtimeInfo = yield* RuntimeInfo;

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
  const branches = yield* api.v1
    .listAllBranches({ ref: project.ref })
    .pipe(Effect.tapError(() => fetching.fail()));
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

  // If a local stack is running, stop and restart it against the new branch.
  const stackCheck = yield* resolveManagedStack({
    cacheRoot: cliConfig.supabaseHome,
    cwd: runtimeInfo.cwd,
    projectDir: projectHome.projectRoot,
  }).pipe(
    Effect.map(Option.some),
    Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
    // Branch switching is also valid outside a local project checkout. In
    // that case managed discovery cannot canonicalize the synthetic/nonexistent
    // project root supplied by the command context, which is equivalent to no
    // local stack being present for this lifecycle check.
    Effect.catchTag("InvalidManagedIdentityError", () => Effect.succeed(Option.none())),
  );

  if (Option.isSome(stackCheck) && stackCheck.value.lifecycle === "running") {
    const stackName = stackCheck.value.identity.name;

    // Branch switching restarts a running stack, but it is not authorized to
    // restart an incompatible daemon. Capture the same-version RPC owner/session
    // before stopping it so a mismatch leaves the old stack intact.
    const existingLayer = yield* connectLayer({
      cliVersion: CLI_VERSION,
      cwd: runtimeInfo.cwd,
      cacheRoot: cliConfig.supabaseHome,
      projectDir: projectHome.projectRoot,
      name: stackName,
    }).pipe(
      Effect.map(Option.some),
      // A running document without a live owner is stale. Continue into the
      // normal stop path, which acquires ownership and records it stopped.
      Effect.catchTag("NoRunningStackError", () => Effect.succeed(Option.none())),
    );

    if (Option.isSome(existingLayer)) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const stack = yield* Stack;
          const stopping = yield* output.task("Stopping local stack...");
          yield* stack.stop().pipe(Effect.tapError(() => stopping.fail()));
          yield* stopping.clear();
        }).pipe(Effect.provide(existingLayer.value)),
      );
    } else {
      const stopping = yield* output.task("Stopping local stack...");
      yield* stopDaemon({
        cwd: runtimeInfo.cwd,
        cacheRoot: cliConfig.supabaseHome,
        projectDir: projectHome.projectRoot,
        name: stackName,
      }).pipe(Effect.tapError(() => stopping.fail()));
      yield* stopping.clear();
    }

    // TODO: run `supabase pull` against the new branch before restarting the stack
    // so the local config reflects the branch's migrations and seed state.
    // `pull` does not exist yet.
    const launch = stackCheck.value.launch;
    const launchConfig = withServiceVersions(
      toStartStackConfig(
        launch.excludedServices?.filter((service): service is ExcludedStackService =>
          excludedStackServices.some((candidate) => candidate === service),
        ) ?? [],
        launch.mode,
      ),
      launch.versions,
    );
    const loadedProjectConfig = yield* loadProjectConfig(projectHome.projectRoot);

    const stackLayer = yield* daemonLayer({
      cliVersion: CLI_VERSION,
      cacheRoot: cliConfig.supabaseHome,
      cwd: runtimeInfo.cwd,
      projectDir: projectHome.projectRoot,
      name: stackName,
      portIntents: managedPortIntents(launchConfig, loadedProjectConfig ?? undefined),
      launch,
      ...launchConfig,
    });

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
});
