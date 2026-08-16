import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { LegacyPlatformApiFactory } from "../auth/legacy-platform-api-factory.service.ts";
import { emitRemoteTarget } from "../../shared/remotes/emit-remote-target.ts";
import { resolveRemoteRef } from "../../shared/remotes/remote-lookup.ts";
import { resolveRequestedRemoteName } from "../../shared/remotes/resolve-remote-selection.ts";
import { Output } from "../../shared/output/output.service.ts";
import { Tty } from "../../shared/runtime/tty.service.ts";
import { legacyResolveRemoteFlag } from "../../shared/legacy/global-flags.ts";
import { legacyReadProjectRefFile } from "../shared/legacy-temp-paths.ts";
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

    const readRefFile = legacyReadProjectRefFile(fs, path, cliConfig.workdir);

    /**
     * Resolves `--remote`/`SUPABASE_REMOTE` ahead of every other resolution
     * method's own flag-value precedence, and — when a remote was requested
     * — substitutes its ref in place of `flagValue`, so the rest of each
     * method's existing chain (env → ref file → prompt) runs completely
     * unchanged. This is the ONE place `--remote` plugs into ref resolution
     * (`shared/legacy/global-flags.ts`'s `LegacyRemoteFlag` doc comment) —
     * every one of the leaf commands that call `LegacyProjectRefResolver`
     * gets `--remote` support from this single file, never a per-command edit.
     * `--remote` + an explicit `flagValue` (the command's own `--project-ref`)
     * is a conflict; prints the `Target:` echo before returning.
     */
    const resolveEffectiveFlagValue = Effect.fnUntraced(function* (
      flagValue: Option.Option<string>,
    ) {
      const remoteFlag = yield* legacyResolveRemoteFlag;
      const requested = yield* resolveRequestedRemoteName({
        remoteFlag,
        remoteEnv: process.env["SUPABASE_REMOTE"],
        conflictingRefFlagExplicit: Option.isSome(flagValue) && flagValue.value.length > 0,
      });
      if (Option.isNone(requested)) {
        return flagValue;
      }
      // `resolveRemoteRef`/`emitRemoteTarget` independently require FileSystem/Path/Output
      // re-provide the SAME instances this layer already captured above.
      const ref = yield* resolveRemoteRef(cliConfig.workdir, requested.value).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      yield* emitRemoteTarget(requested.value, ref).pipe(Effect.provideService(Output, output));
      return Option.some(ref);
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
      resolve: (rawFlagValue) =>
        Effect.gen(function* () {
          const flagValue = yield* resolveEffectiveFlagValue(rawFlagValue);
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
      resolveForLink: (rawFlagValue) =>
        Effect.gen(function* () {
          const flagValue = yield* resolveEffectiveFlagValue(rawFlagValue);
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
      resolveOptional: (rawFlagValue) =>
        Effect.gen(function* () {
          const flagValue = yield* resolveEffectiveFlagValue(rawFlagValue);
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return Option.some(flagValue.value);
          }
          if (Option.isSome(cliConfig.projectId)) {
            return cliConfig.projectId;
          }
          // Soft load: `projects list` ignores ALL project-ref resolution
          // errors and only uses the value as a "linked" marker, so a real
          // ref-file read error degrades to "not linked" here (unlike the
          // hard `resolve`/`loadProjectRef` paths, which surface it).
          return yield* readRefFile.pipe(Effect.orElseSucceed(() => Option.none<string>()));
        }),
      loadProjectRef: (rawFlagValue) =>
        Effect.gen(function* () {
          const flagValue = yield* resolveEffectiveFlagValue(rawFlagValue);
          // Resolution order: flag → env → ref file → hard "not linked"
          // failure, with format validation, and NO interactive prompt.
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
          return yield* Effect.fail(
            new LegacyProjectNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE }),
          );
        }),
      promptProjectRef: promptForProjectRef,
    });
  }),
);
