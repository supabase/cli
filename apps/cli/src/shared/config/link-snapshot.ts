import { Effect, type FileSystem, Option, type Path } from "effect";

import { readLegacyProjectRef } from "./legacy-project-state.layer.ts";
import { legacyProjectStatePaths } from "./legacy-project-state.paths.ts";
import { type LinkedProjectRefReadError, readProjectLinkFile } from "./project-link.ts";
import { currentProjectStateMode } from "./project-state-mode.ts";

/**
 * The parent project's record: `ref`, plus `name`, `organizationSlug` and `organizationId` when
 * the source holds a non-empty string for them.
 */
export interface CachedLinkedProject {
  readonly ref: string;
  readonly name?: string;
  readonly organizationSlug?: string;
  readonly organizationId?: string;
}

/**
 * Everything the checkout records about its hosted link, read from `supabase/.temp` in legacy
 * mode or `supabase/.link.json` in stack mode. `ref` is the ref commands act on, unvalidated.
 */
export interface LinkSnapshot {
  readonly ref: Option.Option<string>;
  readonly parent: Option.Option<CachedLinkedProject>;
  readonly branchName: Option.Option<string>;
  readonly poolerUrl: Option.Option<string>;
}

/** The snapshot of a checkout with no link. */
const emptyLinkSnapshot: LinkSnapshot = {
  ref: Option.none(),
  parent: Option.none(),
  branchName: Option.none(),
  poolerUrl: Option.none(),
};

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parses `.temp/linked-project.json`; a malformed document or an empty `ref` reads as `None`. */
export function parseCachedLinkedProject(content: string): Option.Option<CachedLinkedProject> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed)) {
      const ref = parsed.ref;
      if (typeof ref === "string" && ref.length > 0) {
        const name = readOptionalString(parsed, "name");
        const organizationSlug = readOptionalString(parsed, "organization_slug");
        const organizationId = readOptionalString(parsed, "organization_id");
        return Option.some({
          ref,
          ...(name === undefined ? {} : { name }),
          ...(organizationSlug === undefined ? {} : { organizationSlug }),
          ...(organizationId === undefined ? {} : { organizationId }),
        });
      }
    }
  } catch {
    // A malformed document reads as no parent, like a missing file.
  }
  return Option.none();
}

const readLegacySnapshot = Effect.fn("LinkSnapshot.readLegacy")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  strict: boolean,
): Effect.fn.Return<LinkSnapshot, LinkedProjectRefReadError> {
  const paths = legacyProjectStatePaths(path, workdir);
  const ref = strict
    ? yield* readLegacyProjectRef(fs, path, workdir)
    : yield* readLegacyProjectRef(fs, path, workdir).pipe(
        Effect.orElseSucceed(() => Option.none<string>()),
      );
  const parent = yield* fs.readFileString(paths.linkedProjectCache).pipe(
    Effect.map(parseCachedLinkedProject),
    Effect.orElseSucceed(() => Option.none<CachedLinkedProject>()),
  );
  const poolerUrl = yield* fs.readFileString(paths.poolerUrl).pipe(Effect.option);
  return { ref, parent, branchName: Option.none(), poolerUrl };
});

const readStackSnapshot = Effect.fn("LinkSnapshot.readStack")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.fn.Return<LinkSnapshot, LinkedProjectRefReadError> {
  const link = yield* readProjectLinkFile(fs, path, workdir);
  if (Option.isNone(link)) return emptyLinkSnapshot;
  const { project, active_branch: active } = link.value;
  const isBranch = active.ref !== project.ref;
  return {
    ref: Option.some(active.ref),
    parent: Option.some({
      ref: project.ref,
      ...(project.name === undefined ? {} : { name: project.name }),
      ...(project.organization_slug === undefined
        ? {}
        : { organizationSlug: project.organization_slug }),
      ...(project.organization_id === undefined ? {} : { organizationId: project.organization_id }),
    }),
    branchName: isBranch ? Option.fromNullishOr(active.name) : Option.none(),
    poolerUrl: Option.fromNullishOr(active.pooler_url),
  };
});

const readSnapshot = Effect.fn("LinkSnapshot.read")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  strict: boolean,
): Effect.fn.Return<LinkSnapshot, LinkedProjectRefReadError> {
  const mode = yield* currentProjectStateMode;
  const snapshot =
    mode === "legacy"
      ? yield* readLegacySnapshot(fs, path, workdir, strict)
      : yield* readStackSnapshot(fs, path, workdir);
  yield* Effect.annotateCurrentSpan({
    "project_state.mode": mode,
    "link.linked": Option.isSome(snapshot.ref),
  });
  return snapshot;
});

/**
 * Reads the hosted link recorded in the checkout: the legacy `supabase/.temp` files, or the
 * stack-mode `supabase/.link.json`. Only a failure to read the linked ref fails; the parent
 * record and pooler URL degrade to `None`. Commands resolve their target through
 * `ProjectRefResolver`; this is for readers that run without it.
 */
export const readLinkSnapshot = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.Effect<LinkSnapshot, LinkedProjectRefReadError, never> =>
  readSnapshot(fs, path, workdir, true);

/**
 * {@link readLinkSnapshot} for best-effort readers. An unreadable legacy ref file reads as no ref
 * while the parent record and pooler URL still load; an unreadable `.link.json` reads as unlinked.
 */
export const readLinkSnapshotSoft = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
): Effect.Effect<LinkSnapshot> =>
  readSnapshot(fs, path, workdir, false).pipe(Effect.orElseSucceed(() => emptyLinkSnapshot));

/** Whether `SUPABASE_PROJECT_ID` or the checkout's link names a project; an unreadable link is unlinked. */
export const isCheckoutLinked = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workdir: string,
  projectId: Option.Option<string> = Option.none(),
): Effect.Effect<boolean> =>
  Option.isSome(projectId)
    ? Effect.succeed(true)
    : readLinkSnapshotSoft(fs, path, workdir).pipe(
        Effect.map((snapshot) => Option.isSome(snapshot.ref)),
      );
