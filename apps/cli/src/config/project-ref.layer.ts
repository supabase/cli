import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";
import { readProjectRefFile } from "../command-internal/temp-paths.ts";
import { CommandSettings } from "./command-settings.service.ts";
import {
  InvalidProjectRefError,
  ProjectRefNotLinkedError,
  ProjectRefRequiredError,
} from "./project-ref.errors.ts";
import {
  INVALID_PROJECT_REF_MESSAGE,
  ProjectRefResolver,
  PROJECT_NOT_LINKED_MESSAGE,
  PROJECT_REF_PATTERN,
} from "./project-ref.service.ts";

function assertValid(ref: string): Effect.Effect<string, InvalidProjectRefError> {
  if (PROJECT_REF_PATTERN.test(ref)) {
    return Effect.succeed(ref);
  }
  return Effect.fail(new InvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE }));
}

export const projectRefLayer = Layer.effect(
  ProjectRefResolver,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliSettings = yield* CommandSettings;
    const tty = yield* Tty;
    const output = yield* Output;
    const platformApi = yield* CommandPlatformApiFactory;

    const readRefFile = readProjectRefFile(fs, path, cliSettings.workdir);

    const promptForProjectRef = Effect.fnUntraced(function* (title: string) {
      const api = yield* platformApi.make.pipe(
        Effect.mapError(
          (cause) =>
            new ProjectRefNotLinkedError({
              message: `${PROJECT_NOT_LINKED_MESSAGE}\n  Reason: failed to retrieve projects: ${String(
                cause,
              )}`,
            }),
        ),
      );
      const projects = yield* api.v1.listAllProjects().pipe(
        Effect.mapError(
          (cause) =>
            new ProjectRefNotLinkedError({
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
            new ProjectRefNotLinkedError({
              message: `${PROJECT_NOT_LINKED_MESSAGE}\n  Reason: ${cause.detail}`,
            }),
        ),
      );
      // In text mode `output.info` writes to stderr; in json/stream-json modes it's a no-op.
      yield* output.info(`Selected project: ${chosen}`);
      return chosen;
    });

    return ProjectRefResolver.of({
      resolve: (flagValue) =>
        Effect.gen(function* () {
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return yield* assertValid(flagValue.value);
          }
          if (Option.isSome(cliSettings.projectId)) {
            return yield* assertValid(cliSettings.projectId.value);
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
            new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }),
          );
        }),
      resolveForLink: (flagValue) =>
        Effect.gen(function* () {
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return yield* assertValid(flagValue.value);
          }
          if (Option.isSome(cliSettings.projectId)) {
            return yield* assertValid(cliSettings.projectId.value);
          }
          // `resolveForLink` skips the ref-file fallback that `resolve` uses.
          if (tty.stdinIsTty && output.interactive) {
            const chosen = yield* promptForProjectRef("Select a project:");
            return yield* assertValid(chosen);
          }
          return yield* Effect.fail(
            new ProjectRefRequiredError({
              message: `required flag(s) "project-ref" not set`,
            }),
          );
        }),
      resolveOptional: (flagValue) =>
        Effect.gen(function* () {
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return Option.some(flagValue.value);
          }
          if (Option.isSome(cliSettings.projectId)) {
            return cliSettings.projectId;
          }
          // A ref-file read error degrades to "not linked" here, unlike `resolve`/
          // `loadProjectRef`, since `projects list` only uses the value as a display marker.
          return yield* readRefFile.pipe(Effect.orElseSucceed(() => Option.none<string>()));
        }),
      loadProjectRef: (flagValue) =>
        Effect.gen(function* () {
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return yield* assertValid(flagValue.value);
          }
          if (Option.isSome(cliSettings.projectId)) {
            return yield* assertValid(cliSettings.projectId.value);
          }
          const fileValue = yield* readRefFile;
          if (Option.isSome(fileValue)) {
            return yield* assertValid(fileValue.value);
          }
          return yield* Effect.fail(
            new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }),
          );
        }),
      promptProjectRef: promptForProjectRef,
    });
  }),
);
