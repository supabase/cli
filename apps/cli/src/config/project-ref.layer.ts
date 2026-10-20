import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CommandTarget } from "../shared/output/command-target.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";
import { readProjectRefFile } from "../shared/config/temp-paths.ts";
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
  type ProjectRefSource,
  type ResolvedProjectRef,
} from "./project-ref.service.ts";
import { block } from "../command-internal/command-permissions/model.ts";
import { readCachedLinkedProject } from "../command-internal/parent-project-ref.ts";
import { describeLinkedTarget } from "../command-internal/target/target-identity.ts";

/** `ProjectRefResolver`'s interactive picker, reached only when no ref comes from a flag, env or the linked workdir. */
export const projectRefPicker = block("project-ref", [
  {
    operationId: "v1-list-all-projects",
    kind: "required",
    when: [{ selector: ["none", "bare"] }],
    context:
      "an interactive terminal (stdin and stdout are TTYs, output format not json), no SUPABASE_PROJECT_ID and no supabase/.temp/project-ref (`link` ignores that file)",
  },
]);

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
    const commandTarget = yield* CommandTarget;

    const readRefFile = readProjectRefFile(fs, path, cliSettings.workdir);

    const pickProject = Effect.fnUntraced(function* (title: string) {
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
      const names = new Map(projects.map((project) => [project.id, project.name] as const));
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
      return { ref: chosen, name: names.get(chosen) };
    });

    const promptForProjectRef = (title: string) =>
      pickProject(title).pipe(Effect.map((picked) => picked.ref));

    const announceLinked = Effect.fnUntraced(function* (
      ref: string,
      identity: { readonly name?: string; readonly linkedRef?: Option.Option<string> } = {},
    ) {
      const cache = yield* readCachedLinkedProject(fs, path, cliSettings.workdir);
      yield* commandTarget.announce(describeLinkedTarget({ ref, cache, ...identity }));
    });

    const resolveRef = Effect.fnUntraced(function* (flagValue: Option.Option<string>) {
      let resolved: {
        readonly ref: string;
        readonly source: ProjectRefSource;
        readonly name?: string;
      };
      let linkedRef = Option.none<string>();
      if (Option.isSome(flagValue) && flagValue.value.length > 0) {
        resolved = { ref: yield* assertValid(flagValue.value), source: "flag" };
      } else if (Option.isSome(cliSettings.projectId)) {
        resolved = { ref: yield* assertValid(cliSettings.projectId.value), source: "env" };
      } else {
        linkedRef = yield* readRefFile;
        if (Option.isSome(linkedRef)) {
          resolved = { ref: yield* assertValid(linkedRef.value), source: "file" };
        } else if (tty.stdinIsTty && output.interactive) {
          const picked = yield* pickProject("Select a project:");
          resolved = {
            ref: yield* assertValid(picked.ref),
            source: "picker",
            ...(picked.name === undefined ? {} : { name: picked.name }),
          };
        } else {
          return yield* new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE });
        }
      }
      if (resolved.source === "flag" || resolved.source === "env") {
        linkedRef = yield* readRefFile.pipe(Effect.orElseSucceed(() => Option.none<string>()));
      }
      yield* announceLinked(resolved.ref, {
        linkedRef,
        ...(resolved.name === undefined ? {} : { name: resolved.name }),
      });
      return {
        ref: resolved.ref,
        source: resolved.source,
        matchesLinkedRef: Option.isSome(linkedRef) && linkedRef.value === resolved.ref,
      } satisfies ResolvedProjectRef;
    });

    return ProjectRefResolver.of({
      resolveRef,
      resolve: (flagValue) => resolveRef(flagValue).pipe(Effect.map((resolved) => resolved.ref)),
      resolveForLink: (flagValue) =>
        Effect.gen(function* () {
          let resolved: { readonly ref: string; readonly name?: string };
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            resolved = { ref: yield* assertValid(flagValue.value) };
          } else if (Option.isSome(cliSettings.projectId)) {
            resolved = { ref: yield* assertValid(cliSettings.projectId.value) };
          } else if (tty.stdinIsTty && output.interactive) {
            // `resolveForLink` skips the ref-file fallback that `resolveRef` uses.
            const picked = yield* pickProject("Select a project:");
            resolved = {
              ref: yield* assertValid(picked.ref),
              ...(picked.name === undefined ? {} : { name: picked.name }),
            };
          } else {
            return yield* new ProjectRefRequiredError({
              message: `required flag(s) "project-ref" not set`,
            });
          }
          yield* announceLinked(
            resolved.ref,
            resolved.name === undefined ? {} : { name: resolved.name },
          );
          return resolved.ref;
        }),
      resolveOptional: (flagValue) =>
        Effect.gen(function* () {
          if (Option.isSome(flagValue) && flagValue.value.length > 0) {
            return Option.some(flagValue.value);
          }
          if (Option.isSome(cliSettings.projectId)) {
            return cliSettings.projectId;
          }
          // A ref-file read error degrades to "not linked" here, unlike `resolve`,
          // since `projects list` only uses the value as a display marker.
          return yield* readRefFile.pipe(Effect.orElseSucceed(() => Option.none<string>()));
        }),
      promptProjectRef: promptForProjectRef,
    });
  }),
);
