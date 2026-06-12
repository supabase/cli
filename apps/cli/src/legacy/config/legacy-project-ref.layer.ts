import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { legacyTempPaths } from "../shared/legacy-temp-paths.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";
import {
  LegacyInvalidProjectRefError,
  LegacyProjectNotLinkedError,
  LegacyProjectRefRequiredError,
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
    const platformApi = yield* LegacyPlatformApiFactory;

    const refPath = legacyTempPaths(path, cliConfig.workdir).projectRef;

    const readRefFile = Effect.gen(function* () {
      const exists = yield* fs.exists(refPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return Option.none<string>();
      const content = yield* fs.readFileString(refPath).pipe(Effect.orElseSucceed(() => ""));
      const trimmed = content.trim();
      return trimmed.length === 0 ? Option.none<string>() : Option.some(trimmed);
    });

    const promptForProjectRef = Effect.fnUntraced(function* (title: string) {
      const api = yield* platformApi.make.pipe(
        Effect.mapError(
          (cause) =>
            new LegacyProjectNotLinkedError({
              message: `${PROJECT_NOT_LINKED_MESSAGE}\n  Reason: failed to retrieve projects: ${String(
                cause,
              )}`,
            }),
        ),
      );
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
      const chosen = yield* output.promptSelect(title, options).pipe(
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
            const chosen = yield* promptForProjectRef("Select a project:");
            return yield* assertValid(chosen);
          }
          return yield* Effect.fail(
            new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }),
          );
        }),
      resolveForLink: (flagValue) =>
        Effect.gen(function* () {
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return yield* assertValid(flagValue.value);
          }
          if (Option.isSome(cliConfig.projectId)) {
            return yield* assertValid(cliConfig.projectId.value);
          }
          // Go skips the ref-file fallback for link (MemMapFs at link.go:30).
          if (tty.stdinIsTty && output.interactive) {
            const chosen = yield* promptForProjectRef("Select a project:");
            return yield* assertValid(chosen);
          }
          return yield* Effect.fail(
            new LegacyProjectRefRequiredError({
              message: `required flag(s) "project-ref" not set`,
            }),
          );
        }),
      resolveOptional: (flagValue) =>
        Effect.gen(function* () {
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return Option.some(flagValue.value);
          }
          if (Option.isSome(cliConfig.projectId)) {
            return cliConfig.projectId;
          }
          return yield* readRefFile;
        }),
      promptProjectRef: promptForProjectRef,
    });
  }),
);
