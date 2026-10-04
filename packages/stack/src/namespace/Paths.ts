import { Effect, FileSystem, Path } from "effect";
import { lstatPath } from "./drivers/FileSystem.ts";

const BorrowedPathBrand: unique symbol = Symbol("Namespace.BorrowedPath");

/**
 * A caller-supplied path the namespace only reads or mounts, never deletes. The brand makes
 * {@link borrow} the only way to construct one: a service that needs a caller path in `prepare`,
 * `mounts`, `env`, or `args` must hold a `BorrowedPath`, so a path that was never validated against
 * the stack's data root cannot be used in its place.
 */
export interface BorrowedPath {
  readonly path: string;
  readonly [BorrowedPathBrand]: true;
}

/**
 * Resolves `target`'s real path, walking up to its nearest existing ancestor and rejoining the
 * remaining segments when it (or an ancestor) does not exist yet, so a symlinked ancestor cannot
 * smuggle a not-yet-created path inside an owned root.
 */
const resolveReal = <E>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
  onError: (operation: string, cause: unknown) => E,
): Effect.Effect<string, E> =>
  Effect.gen(function* () {
    const exists = yield* fs
      .exists(target)
      .pipe(Effect.mapError((cause) => onError("configure", cause)));
    if (exists)
      return yield* fs
        .realPath(target)
        .pipe(Effect.mapError((cause) => onError("configure", cause)));
    const parent = path.dirname(target);
    if (parent === target) return path.resolve(target);
    const realParent = yield* resolveReal(fs, path, parent, onError);
    return path.join(realParent, path.basename(target));
  });

/**
 * The only way to construct a {@link BorrowedPath}. Ownership is by location: everything under the
 * stack's data root belongs to the stack, so a borrowed (read-only) caller path must resolve
 * neither to it nor inside it — checked by real path, equality included, after resolving through
 * any ancestor symlink. Call before preparation or launch uses `candidate`.
 */
export const borrow = Effect.fn("Namespace.Paths.borrow")(
  <E>(
    fs: FileSystem.FileSystem,
    path: Path.Path,
    candidate: string,
    dataRoot: string,
    onError: (operation: string, cause: unknown) => E,
  ): Effect.Effect<BorrowedPath, E> =>
    Effect.gen(function* () {
      const [realCandidate, realDataRoot] = yield* Effect.all([
        resolveReal(fs, path, candidate, onError),
        resolveReal(fs, path, dataRoot, onError),
      ]);
      if (realCandidate === realDataRoot || realCandidate.startsWith(`${realDataRoot}${path.sep}`))
        return yield* Effect.fail(
          onError("configure", `${candidate} resolves inside the owned data root ${dataRoot}`),
        );
      return { path: candidate, [BorrowedPathBrand]: true };
    }),
);

/** Reports whether `candidate`'s real path is inside, or equal to, the real path of any of `roots`. */
export const isWithinOwnedRoots = Effect.fn("Namespace.Paths.isWithinOwnedRoots")(
  <E>(
    fs: FileSystem.FileSystem,
    path: Path.Path,
    candidate: string,
    roots: ReadonlyArray<string>,
    onError: (operation: string, cause: unknown) => E,
  ): Effect.Effect<boolean, E> =>
    Effect.gen(function* () {
      const realCandidate = yield* resolveReal(fs, path, candidate, onError);
      for (const root of roots) {
        const realRoot = yield* resolveReal(fs, path, root, onError);
        if (realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`))
          return true;
      }
      return false;
    }),
);

/** The container mount target for an instance-scoped directory owned on the host. */
export const containerInstancePath = "/instance";

/** Owned per-launch environment-file directory name under a stack's data root. */
export const CONTAINER_ENV_DIRNAME = ".container-env";

/**
 * Confirms `root` is a real directory (not a symlink or junction) whose real path resolves inside
 * `parentRoot`'s real path. {@link destroyOwnedRoot} runs this before any destructive step,
 * including the `keep` branch, so a symlink planted at `root` (or replacing it between launches)
 * is refused rather than traversed or removed.
 */
const confirmRealOwnedDirectory = <E>(
  fs: FileSystem.FileSystem,
  path: Path.Path,
  root: string,
  parentRoot: string,
  onError: (operation: string, cause: unknown) => E,
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const info = yield* lstatPath(root).pipe(Effect.mapError((cause) => onError("destroy", cause)));
    if (info?.type === "SymbolicLink")
      return yield* Effect.fail(onError("destroy", `${root} is a symlink, not an owned directory`));
    if (info === undefined || info.type !== "Directory")
      return yield* Effect.fail(onError("destroy", `${root} is not a directory`));
    const realRoot = yield* fs
      .realPath(root)
      .pipe(Effect.mapError((cause) => onError("destroy", cause)));
    const realParent = yield* fs
      .realPath(parentRoot)
      .pipe(Effect.mapError((cause) => onError("destroy", cause)));
    if (realRoot !== realParent && !realRoot.startsWith(`${realParent}${path.sep}`))
      return yield* Effect.fail(onError("destroy", `${root} resolves outside ${parentRoot}`));
  });

/**
 * Destroys the owned root `root` (a child of `parentRoot`), confirming it first in every branch,
 * including `keep`, and before `removeData` runs. `removeData` always runs, even when `root` was
 * never created on disk, since a recipe's data may live entirely outside the host filesystem (an
 * engine volume, for example). One race is accepted and left unguarded: an ancestor directory
 * replaced between the confirmation below and the removal that follows it — a stack's own owner is
 * the only writer of its roots.
 */
export const destroyOwnedRoot = Effect.fn("Namespace.Paths.destroyOwnedRoot")(
  <E>(
    fs: FileSystem.FileSystem,
    path: Path.Path,
    root: string,
    parentRoot: string,
    removeData: Effect.Effect<void, E>,
    onError: (operation: string, cause: unknown) => E,
    /** Root entries kept after removeData; when empty the root itself is removed. */
    keep: ReadonlyArray<string> = [],
  ): Effect.Effect<void, E> =>
    Effect.gen(function* () {
      const exists = yield* fs
        .exists(root)
        .pipe(Effect.mapError((cause) => onError("destroy", cause)));
      if (exists) yield* confirmRealOwnedDirectory(fs, path, root, parentRoot, onError);
      yield* removeData;
      if (!exists) return;
      if (keep.length === 0) {
        yield* fs
          .remove(root, { recursive: true, force: true })
          .pipe(Effect.mapError((cause) => onError("destroy", cause)));
        return;
      }
      const names = yield* fs
        .readDirectory(root)
        .pipe(Effect.mapError((cause) => onError("destroy", cause)));
      for (const name of names)
        if (!keep.includes(name))
          yield* fs
            .remove(path.join(root, name), { recursive: true, force: true })
            .pipe(Effect.mapError((cause) => onError("destroy", cause)));
    }),
);
