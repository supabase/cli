import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { CommandTarget } from "../shared/output/command-target.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { Tty } from "../shared/runtime/tty.service.ts";
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
import {
  type LinkSnapshot,
  readLinkSnapshot,
  readLinkSnapshotSoft,
} from "../shared/config/link-snapshot.ts";
import {
  describeLinkedTarget,
  renderBranchTarget,
} from "../command-internal/target/target-identity.ts";

/** `ProjectRefResolver`'s interactive picker, reached only when no ref comes from a flag, env or the linked workdir. */
export const projectRefPicker = block("project-ref", [
  {
    operationId: "v1-list-all-projects",
    kind: "required",
    when: [{ selector: ["none", "bare"] }],
    context:
      "an interactive terminal (stdin and stdout are TTYs, output format not json), no SUPABASE_PROJECT_ID and no linked project in supabase/.link.json or supabase/.temp (`link` ignores the link)",
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

    const readSnapshot = readLinkSnapshot(fs, path, cliSettings.workdir);
    const readSnapshotSoft = readLinkSnapshotSoft(fs, path, cliSettings.workdir);

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
      snapshot: LinkSnapshot,
      identity: { readonly name?: string; readonly compareWithLink?: boolean } = {},
    ) {
      const parent = Option.getOrUndefined(snapshot.parent);
      const isLinkedBranch =
        Option.contains(snapshot.ref, ref) &&
        Option.isSome(snapshot.branchName) &&
        parent !== undefined &&
        parent.ref !== ref;
      yield* commandTarget.announce(
        isLinkedBranch
          ? renderBranchTarget({
              branch: snapshot.branchName,
              ref,
              parentRef: Option.some(parent.ref),
              parentName: parent.name,
              isDefault: false,
            })
          : describeLinkedTarget({
              ref,
              cache: snapshot.parent,
              ...(identity.name === undefined ? {} : { name: identity.name }),
              ...(identity.compareWithLink === true ? { linkedRef: snapshot.ref } : {}),
            }),
      );
    });

    const resolveRef = Effect.fn("ProjectRefResolver.resolveRef")(function* (
      flagValue: Option.Option<string>,
    ) {
      let resolved: {
        readonly ref: string;
        readonly source: ProjectRefSource;
        readonly name?: string;
      };
      let snapshot: LinkSnapshot | undefined;
      if (Option.isSome(flagValue) && flagValue.value.length > 0) {
        resolved = { ref: yield* assertValid(flagValue.value), source: "flag" };
      } else if (Option.isSome(cliSettings.projectId)) {
        resolved = { ref: yield* assertValid(cliSettings.projectId.value), source: "env" };
      } else {
        snapshot = yield* readSnapshot;
        if (Option.isSome(snapshot.ref)) {
          resolved = { ref: yield* assertValid(snapshot.ref.value), source: "file" };
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
      const linked = snapshot ?? (yield* readSnapshotSoft);
      const matchesLinkedRef = Option.contains(linked.ref, resolved.ref);
      const poolerUrl = matchesLinkedRef
        ? Option.getOrUndefined(Option.filter(linked.poolerUrl, (url) => url.length > 0))
        : undefined;
      yield* Effect.annotateCurrentSpan({
        "project_ref.source": resolved.source,
        "project_ref.matches_linked": matchesLinkedRef,
      });
      yield* announceLinked(resolved.ref, linked, {
        compareWithLink: true,
        ...(resolved.name === undefined ? {} : { name: resolved.name }),
      });
      return {
        ref: resolved.ref,
        source: resolved.source,
        matchesLinkedRef,
        ...(poolerUrl === undefined ? {} : { poolerUrl }),
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
            yield* readSnapshotSoft,
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
          // A link read error degrades to "not linked" here, unlike `resolve`,
          // since `projects list` only uses the value as a display marker.
          return (yield* readSnapshotSoft).ref;
        }),
      promptProjectRef: promptForProjectRef,
    });
  }),
);
