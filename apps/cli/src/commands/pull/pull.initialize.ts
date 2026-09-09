import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";
import { findCliProjectPaths } from "@supabase/config/effect";

import { OutputFlag, WorkdirFlag, resolveYes } from "../../command-internal/global-flags.ts";
import { validateWorkdirIsDirectory } from "../../command-internal/workdir-validation.ts";
import { initProject } from "../../shared/init/project-init.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { readProjectRefFile } from "../../command-internal/temp-paths.ts";
import { PROJECT_REF_PATTERN } from "../../config/project-ref.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { sanitizeInlineName } from "../../command-internal/http-errors.ts";

export class PullInitialization extends Context.Service<
  PullInitialization,
  { readonly configPath: Option.Option<string> }
>()("supabase/pull/PullInitialization") {}

/** Initialize before building any runtime that searches for the project directory. */
export const pullInitializationLayer = Layer.unwrap(
  Effect.gen(function* () {
    // Leave unsupported-output reporting to the handler, without creating files.
    if (Option.isSome(yield* OutputFlag)) {
      return Layer.succeed(PullInitialization, { configPath: Option.none<string>() });
    }

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const runtime = yield* RuntimeInfo;
    const workdir = yield* WorkdirFlag;
    const configured = Option.getOrElse(
      Option.filter(workdir, (value) => value.length > 0),
      () => process.env["SUPABASE_WORKDIR"] || runtime.cwd,
    );
    const cwd = path.resolve(runtime.cwd, configured);
    yield* validateWorkdirIsDirectory(cwd, fs);
    const retainProject = (projectRoot?: string) =>
      Layer.mergeAll(
        Layer.succeed(PullInitialization, { configPath: Option.none<string>() }),
        Layer.succeed(WorkdirFlag, projectRoot === undefined ? workdir : Option.some(projectRoot)),
      );
    // A real config is sufficient to reuse a project, whether linked or not.
    // Anchor all component runtimes to the same root, including JSON configs.
    if ((yield* findCliProjectPaths(cwd, { search: false })) !== null) {
      return retainProject(cwd);
    }
    const localLink = yield* readProjectRefFile(fs, path, cwd);
    const hasDirectory = yield* fs.exists(path.join(cwd, "supabase"));
    const explicitWorkdir =
      (Option.isSome(workdir) && workdir.value.length > 0) ||
      (process.env["SUPABASE_WORKDIR"]?.length ?? 0) > 0;
    if (!hasDirectory && !explicitWorkdir) {
      const existing = yield* findCliProjectPaths(cwd);
      if (existing !== null) {
        const linkedRef = yield* readProjectRefFile(fs, path, existing.projectRoot);
        if (Option.isSome(linkedRef) && PROJECT_REF_PATTERN.test(linkedRef.value)) {
          const output = yield* Output;
          yield* output.info(
            `Using linked project at ${sanitizeInlineName(existing.projectRoot)}.`,
          );
          return retainProject(existing.projectRoot);
        }
      }
    }
    if (hasDirectory && Option.isNone(localLink)) {
      return retainProject();
    }
    const result = yield* initProject({
      cwd,
      force: false,
      useOrioledb: false,
      interactive: false,
      yes: yield* resolveYes,
      withVscodeSettings: false,
      withIntellijSettings: false,
    });
    return Layer.mergeAll(
      Layer.succeed(PullInitialization, {
        configPath: result.created ? Option.some(result.configPath) : Option.none<string>(),
      }),
      Layer.succeed(WorkdirFlag, Option.some(cwd)),
    );
  }),
);
