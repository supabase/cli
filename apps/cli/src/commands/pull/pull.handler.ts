import { Effect, FileSystem, Option, Path } from "effect";

import { OutputFlag, resolveYes } from "../../command-internal/global-flags.ts";
import { validateWorkdirIsDirectory } from "../../command-internal/workdir-validation.ts";
import { listProjectSecrets } from "../../command-internal/list-project-secrets.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { ProjectRefResolver } from "../../config/project-ref.service.ts";
import { initProject } from "../../shared/init/project-init.ts";
import { Output } from "../../shared/output/output.service.ts";
import { LinkedProjectCache } from "../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../telemetry/telemetry-state.service.ts";
import { openConfigPullSource, runConfigPull } from "../../command-internal/config-pull.ts";
import { pullDatabaseSchema } from "../../command-internal/db-pull.ts";
import { downloadProjectFunctions } from "../../command-internal/functions-download.ts";
import type { PullFlags } from "./pull.command.ts";
import { PullOutputFlagUnsupportedError, PullSecretNameError } from "./pull.errors.ts";
import { PullInitialization } from "./pull.initialize.ts";
import { readProjectRefFile } from "../../command-internal/temp-paths.ts";
import { promptYesNo } from "../../command-internal/prompt-yes-no.ts";
import { linkProject } from "../../command-internal/link-project.ts";

export const pull = Effect.fn("pull")(function* (flags: PullFlags) {
  const output = yield* Output;
  const settings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolver = yield* ProjectRefResolver;
  const cache = yield* LinkedProjectCache;
  const telemetry = yield* TelemetryState;
  const initialization = yield* PullInitialization;
  let projectRef: string | undefined;

  yield* Effect.gen(function* () {
    if (Option.isSome(yield* OutputFlag)) {
      return yield* new PullOutputFlagUnsupportedError({
        message:
          "the -o/--output flag is not supported by pull; use --output-format json|stream-json instead.",
      });
    }
    yield* validateWorkdirIsDirectory(settings.workdir, fs);
    projectRef = yield* resolver.resolve(flags.projectRef);
    const ref = projectRef;
    const yes = yield* resolveYes;
    const directory = path.join(settings.workdir, "supabase");
    let initialized = Option.contains(
      initialization.configPath,
      path.join(directory, "config.toml"),
    );
    if (
      !(yield* fs.exists(path.join(directory, "config.json"))) &&
      !(yield* fs.exists(path.join(directory, "config.toml")))
    ) {
      const result = yield* initProject({
        cwd: settings.workdir,
        force: false,
        useOrioledb: false,
        interactive: false,
        yes,
        withVscodeSettings: false,
        withIntellijSettings: false,
      });
      initialized = result.created;
    }

    // Keep each command's diagnostics and prompts, but collect its machine
    // result so the composition emits exactly one final success envelope.
    const results: Record<string, Record<string, unknown> | undefined> = {};
    const stepOutput = (step: string) =>
      Output.of({
        ...output,
        success: (message, data) =>
          Effect.gen(function* () {
            results[step] = data;
            if (output.format === "text") yield* output.success(message, data);
          }),
      });
    const source = yield* openConfigPullSource();
    const config = yield* runConfigPull({
      target: { ref, branch: undefined },
      remoteLabel: undefined,
      dryRun: false,
      // The init template was created by this invocation; existing configs
      // retain config pull's ordinary git guard.
      force: flags.force || initialized,
      yes,
      source,
    }).pipe(Effect.provideService(Output, stepOutput("config")));
    if (config.declined) {
      yield* output.success("Project pull cancelled.", {
        project_ref: ref,
        declined: true,
        config: results.config,
      });
      return;
    }

    yield* pullDatabaseSchema(
      {
        name: Option.none(),
        declarative: Option.some(true),
        usePgDelta: Option.none(),
        diffEngine: Option.none(),
        strictCoverage: flags.strictCoverage,
        schema: [],
        dbUrl: Option.none(),
        linked: Option.some(true),
        local: Option.none(),
        projectRef: Option.some(ref),
        password: flags.password,
      },
      { skipFinishedLine: true },
    ).pipe(Effect.provideService(Output, stepOutput("database")));

    yield* downloadProjectFunctions({
      functionName: Option.none(),
      projectRef: Option.some(ref),
      useApi: flags.useApi,
      useDocker: true,
      legacyBundle: false,
    }).pipe(Effect.provideService(Output, stepOutput("functions")));

    const secrets = yield* listProjectSecrets(ref);
    for (const secret of secrets) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secret.name)) {
        return yield* new PullSecretNameError({
          message:
            "A remote secret name cannot be represented as an environment variable in functions/.env.example.",
        });
      }
    }
    const functionsDirectory = path.join(directory, "functions");
    yield* fs.makeDirectory(functionsDirectory, { recursive: true });
    const envExample = path.join(functionsDirectory, ".env.example");
    yield* fs.writeFileString(
      envExample,
      "# Fill in these values locally. Secret values cannot be downloaded.\n" +
        secrets.map(({ name }) => `${name}=\n`).join(""),
    );

    const existingLink = yield* readProjectRefFile(fs, path, settings.workdir);
    let linked = Option.contains(existingLink, ref);
    if (!linked) {
      const shouldLink = Option.isSome(flags.link)
        ? flags.link.value
        : yield* promptYesNo(
            output,
            yes,
            Option.isSome(existingLink)
              ? `Replace this folder's existing link with project ${ref}?`
              : `Link this folder to project ${ref}?`,
            false,
          );
      if (shouldLink) {
        yield* linkProject({
          refOrBranch: Option.none(),
          projectRef: Option.some(ref),
          password: flags.password,
          skipPooler: false,
        }).pipe(Effect.provideService(Output, stepOutput("link")));
        linked = true;
      }
    }

    yield* output.success("Project pulled into supabase/.", {
      project_ref: ref,
      directory,
      linked,
      ...results,
      secrets: { names: secrets.map(({ name }) => name), env_example: envExample },
    });
  }).pipe(
    // The composition owns finalization, including failures before a child
    // starts. Child handlers must not flush or populate the same cache again.
    Effect.provideService(LinkedProjectCache, { cache: () => Effect.void }),
    Effect.provideService(TelemetryState, { ...telemetry, flush: Effect.void }),
    Effect.ensuring(
      Effect.suspend(() => (projectRef === undefined ? Effect.void : cache.cache(projectRef))),
    ),
    Effect.ensuring(telemetry.flush),
  );
});
