import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { LegacyPlatformApi } from "../auth/legacy-platform-api.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";
import {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
} from "./legacy-project-ref.errors.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  LegacyProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
  PROJECT_REF_PATTERN,
} from "./legacy-project-ref.service.ts";

function assertValid(ref: string): Effect.Effect<string, LegacyInvalidProjectRefError> {
  if (PROJECT_REF_PATTERN.test(ref)) {
    return Effect.succeed(ref);
  }
  return Effect.fail(
    new LegacyInvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE }),
  );
}

export const legacyProjectRefLayer = Layer.effect(
  LegacyProjectRefResolver,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliConfig = yield* LegacyCliConfig;
    const tty = yield* Tty;
    const output = yield* Output;
    const api = yield* LegacyPlatformApi;

    const refPath = path.join(cliConfig.workdir, "supabase", ".temp", "project-ref");

    const readRefFile = Effect.gen(function* () {
      const exists = yield* fs.exists(refPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return Option.none<string>();
      const content = yield* fs.readFileString(refPath).pipe(Effect.orElseSucceed(() => ""));
      const trimmed = content.trim();
      return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
    });

    const promptForProjectRef = Effect.gen(function* () {
      const projects = yield* api.v1.listAllProjects().pipe(
        Effect.mapError(
          (cause) =>
            new LegacyProjectNotLinkedError({
              message: `${PROJECT_NOT_LINKED_MESSAGE}\n  Reason: failed to retrieve projects: ${String(
                cause,
              )}`,
            }),
        ),
      );
      const options = projects.map((project) => ({
        value: project.id,
        label: project.id,
        hint: `name: ${project.name}, org: ${project.organization_slug}, region: ${project.region}`,
      }));
      const chosen = yield* output.promptSelect("Select a project:", options).pipe(
        Effect.mapError(
          (cause) =>
            new LegacyProjectNotLinkedError({
              message: `${PROJECT_NOT_LINKED_MESSAGE}\n  Reason: ${cause.detail}`,
            }),
        ),
      );
      // Go writes "Selected project: <ref>" to stderr (project_ref.go:50). In text mode
      // `output.info` lands on stderr; in json/stream-json modes it is a no-op.
      yield* output.info(`Selected project: ${chosen}`);
      return chosen;
    });

    return LegacyProjectRefResolver.of({
      resolve: (flagValue) =>
        Effect.gen(function* () {
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return yield* assertValid(flagValue.value);
          }
          if (Option.isSome(cliConfig.projectId)) {
            return yield* assertValid(cliConfig.projectId.value);
          }
          const fileValue = yield* readRefFile;
          if (Option.isSome(fileValue)) {
            return yield* assertValid(fileValue.value);
          }
          if (tty.stdinIsTty && output.interactive) {
            const chosen = yield* promptForProjectRef;
            return yield* assertValid(chosen);
          }
          return yield* Effect.fail(
            new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }),
          );
        }),
    });
  }),
);
