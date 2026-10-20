import { Cache, Effect, FileSystem, Layer, Option, Path } from "effect";

import { CommandPlatformApiFactory } from "../auth/command-platform-api-factory.service.ts";
import { block } from "../command-internal/command-permissions/model.ts";
import {
  type LinkSnapshot,
  readLinkSnapshot,
  readLinkSnapshotSoft,
} from "../command-internal/link-snapshot.ts";
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
  type ParentRefResolution,
  PROJECT_NOT_LINKED_MESSAGE,
  PROJECT_REF_PATTERN,
  RemoteTarget,
  type RemoteTargetSource,
  type ResolvedRemoteTarget,
} from "./remote-target.service.ts";

/** `RemoteTarget`'s interactive picker, reached only when no ref comes from a flag, env or the link. */
export const projectRefPicker = block("project-ref", [
  {
    operationId: "v1-list-all-projects",
    kind: "required",
    when: [{ flag: "project-ref", present: false }],
    context:
      "an interactive terminal (stdin and stdout are TTYs, output format not json), no SUPABASE_PROJECT_ID and no linked project in supabase/.link.json or supabase/.temp (`link` ignores the link)",
  },
]);

const CACHE_CAPACITY = 8;

function assertValid(ref: string): Effect.Effect<string, InvalidProjectRefError> {
  if (PROJECT_REF_PATTERN.test(ref)) {
    return Effect.succeed(ref);
  }
  return Effect.fail(new InvalidProjectRefError({ ref, message: INVALID_PROJECT_REF_MESSAGE }));
}

const nonEmpty = (value: Option.Option<string>): Option.Option<string> =>
  Option.filter(value, (text) => text.length > 0);

/** Attaches the link's metadata when `ref` is the linked ref, since it describes only that ref. */
function targetFor(
  ref: string,
  source: RemoteTargetSource,
  snapshot: LinkSnapshot,
): ResolvedRemoteTarget {
  if (!Option.exists(snapshot.ref, (linkedRef) => linkedRef === ref)) return { ref, source };
  const parentRef = Option.filter(
    Option.map(snapshot.parent, (parent) => parent.ref),
    (parent) => parent !== ref,
  );
  const poolerUrl = nonEmpty(snapshot.poolerUrl);
  return {
    ref,
    source,
    ...(Option.isSome(parentRef)
      ? {
          parentRef: parentRef.value,
          ...(Option.isSome(snapshot.branchName) ? { branchName: snapshot.branchName.value } : {}),
        }
      : {}),
    ...(Option.isSome(poolerUrl) ? { poolerUrl: poolerUrl.value } : {}),
  };
}

export const remoteTargetLayer = Layer.effect(
  RemoteTarget,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cliSettings = yield* CommandSettings;
    const tty = yield* Tty;
    const output = yield* Output;
    const platformApi = yield* CommandPlatformApiFactory;

    const readSnapshot = readLinkSnapshot(fs, path, cliSettings.workdir);
    const readSnapshotSoft = readLinkSnapshotSoft(fs, path, cliSettings.workdir);
    const envRef = nonEmpty(cliSettings.projectId);

    const prompt = Effect.fn("RemoteTarget.prompt")(function* (title: string) {
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

    const canPrompt = tty.stdinIsTty && output.interactive;

    const resolveSources = Effect.fn("RemoteTarget.resolve")(function* (
      flagKey: string,
      withPicker: boolean,
    ) {
      yield* Effect.annotateCurrentSpan("remote_target.picker", withPicker);
      const done = Effect.fnUntraced(function* (target: ResolvedRemoteTarget) {
        yield* Effect.annotateCurrentSpan({
          "remote_target.source": target.source,
          "project.ref": target.ref,
          "remote_target.is_branch": target.parentRef !== undefined,
        });
        return target;
      });
      if (flagKey.length > 0) {
        const ref = yield* assertValid(flagKey);
        return yield* done(targetFor(ref, "flag", yield* readSnapshotSoft));
      }
      if (Option.isSome(envRef)) {
        const ref = yield* assertValid(envRef.value);
        return yield* done(targetFor(ref, "env", yield* readSnapshotSoft));
      }
      const snapshot = yield* readSnapshot;
      if (Option.isSome(snapshot.ref)) {
        const ref = yield* assertValid(snapshot.ref.value);
        return yield* done(targetFor(ref, "link", snapshot));
      }
      if (withPicker && canPrompt) {
        const chosen = yield* prompt("Select a project:");
        const ref = yield* assertValid(chosen);
        return yield* done({ ref, source: "flag" });
      }
      return yield* new ProjectRefNotLinkedError({ message: PROJECT_NOT_LINKED_MESSAGE });
    });

    const flagKeyOf = (flagValue: Option.Option<string>): string =>
      Option.getOrElse(nonEmpty(flagValue), () => "");

    // One cache per entry point: a command reaching the same target twice reads the link once.
    const resolveCache = yield* Cache.make({
      capacity: CACHE_CAPACITY,
      lookup: (flagKey: string) => resolveSources(flagKey, true),
    });
    const loadCache = yield* Cache.make({
      capacity: CACHE_CAPACITY,
      lookup: (flagKey: string) => resolveSources(flagKey, false),
    });

    const resolve = (flagValue: Option.Option<string>) =>
      Cache.get(resolveCache, flagKeyOf(flagValue));
    const load = (flagValue: Option.Option<string>) => Cache.get(loadCache, flagKeyOf(flagValue));

    const resolveForLink = Effect.fn("RemoteTarget.resolveForLink")(function* (
      flagValue: Option.Option<string>,
    ) {
      const flagRef = nonEmpty(flagValue);
      if (Option.isSome(flagRef)) {
        return { ref: yield* assertValid(flagRef.value), source: "flag" } as const;
      }
      if (Option.isSome(envRef)) {
        return { ref: yield* assertValid(envRef.value), source: "env" } as const;
      }
      if (canPrompt) {
        const chosen = yield* prompt("Select a project:");
        return { ref: yield* assertValid(chosen), source: "flag" } as const;
      }
      return yield* new ProjectRefRequiredError({
        message: `required flag(s) "project-ref" not set`,
      });
    });

    const resolveOptional = Effect.fn("RemoteTarget.resolveOptional")(function* (
      flagValue: Option.Option<string>,
    ) {
      const flagRef = nonEmpty(flagValue);
      if (Option.isSome(flagRef)) {
        return Option.some(targetFor(flagRef.value, "flag", yield* readSnapshotSoft));
      }
      if (Option.isSome(envRef)) {
        return Option.some(targetFor(envRef.value, "env", yield* readSnapshotSoft));
      }
      const snapshot = yield* readSnapshotSoft;
      return Option.map(snapshot.ref, (ref) => targetFor(ref, "link", snapshot));
    });

    const parent = Effect.gen(function* () {
      const snapshot = yield* readSnapshotSoft;
      const linkedRef = snapshot.ref;
      // The recorded parent alone is not proof a link completed, since `link` writes it on
      // failure as well, so it counts only when the linked ref confirms the link.
      const recordedParent = Option.isSome(linkedRef)
        ? Option.map(snapshot.parent, (record) => record.ref)
        : Option.none<string>();
      // An env value restating the linked ref carries no parent information. Only a valid value
      // is dropped, so a malformed env equal to a malformed link still reads as invalid.
      const env =
        Option.isSome(envRef) &&
        Option.isSome(linkedRef) &&
        envRef.value === linkedRef.value &&
        PROJECT_REF_PATTERN.test(envRef.value)
          ? Option.none<string>()
          : envRef;
      const candidates = [
        [env, "env"],
        [recordedParent, "link"],
        [linkedRef, "link"],
      ] as const;
      // The first present candidate decides: a malformed higher-priority one is `invalid`
      // instead of falling through to a lower-priority project, which could run a mutation
      // against the wrong project.
      for (const [candidate, source] of candidates) {
        if (Option.isSome(candidate)) {
          return PROJECT_REF_PATTERN.test(candidate.value)
            ? ({ kind: "resolved", ref: candidate.value, source } as const)
            : ({ kind: "invalid" } as const);
        }
      }
      return { kind: "absent" } as const satisfies ParentRefResolution;
    }).pipe(Effect.withSpan("RemoteTarget.parent"));

    const resolveParentScoped = Effect.fn("RemoteTarget.resolveParentScoped")(function* (
      flagValue: Option.Option<string>,
    ) {
      if (Option.isSome(nonEmpty(flagValue))) {
        yield* Effect.annotateCurrentSpan("remote_target.parent_scope", "flag");
        return yield* resolve(flagValue);
      }
      const linkedParent = yield* parent;
      yield* Effect.annotateCurrentSpan("remote_target.linked_parent", linkedParent.kind);
      if (linkedParent.kind === "resolved") {
        yield* Effect.annotateCurrentSpan("remote_target.parent_scope", "linked_parent");
        return { ref: linkedParent.ref, source: linkedParent.source } as const;
      }
      yield* Effect.annotateCurrentSpan("remote_target.parent_scope", "resolver");
      return yield* resolve(Option.none());
    });

    return RemoteTarget.of({
      resolve,
      load,
      resolveForLink,
      resolveOptional,
      prompt,
      parent,
      resolveParentScoped,
    });
  }),
);
