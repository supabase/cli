import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import { namespaceError, type NamespaceError } from "./Capabilities.ts";
import * as Publication from "./Publication.ts";

/**
 * A resource the stack is about to create outside its own process lifetime: a container or a
 * directory whose creation can be interrupted partway. Identity is exact, so reconciliation never
 * guesses by name or label. `daemonId` records which engine daemon a container claim belongs to,
 * so reconcile never removes (or mistakes) an identity recorded against a different daemon.
 */
export const ResourceClaim = Schema.Struct({
  kind: Schema.Literals(["container", "directory"]),
  id: Schema.String,
  daemonId: Schema.optionalKey(Schema.String),
});
export interface ResourceClaim extends Schema.Schema.Type<typeof ResourceClaim> {}

const ClaimsDocument = Schema.Struct({ claims: Schema.Array(ResourceClaim) });

/** The claims document file name, relative to a stack's own directory under the namespace root. */
export const CLAIMS_FILE = "claims.json";

export interface Interface {
  /** Journals `claim` before the resource it names is created; idempotent on a repeated identity. */
  readonly claim: (stackId: string, claim: ResourceClaim) => Effect.Effect<void, NamespaceError>;
  /** Drops `claim` once its resource is removed, or once something else now owns its cleanup. */
  readonly unclaim: (stackId: string, claim: ResourceClaim) => Effect.Effect<void, NamespaceError>;
  /** Every resource claim still recorded for `stackId`. */
  readonly readClaims: (
    stackId: string,
  ) => Effect.Effect<ReadonlyArray<ResourceClaim>, NamespaceError>;
}

export interface Options {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
}

const sameClaim = (left: ResourceClaim, right: ResourceClaim) =>
  left.kind === right.kind && left.id === right.id;

export const make = (
  options: Options,
): Effect.Effect<Interface, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stackRoot = (id: string) => path.join(options.root, id);
    const claimsPath = (id: string) => path.join(stackRoot(id), CLAIMS_FILE);
    // Claims mutate only from within the single owner process that holds a stack's lease, so an
    // in-process mutex per stack id is enough to serialize its read-modify-write cycle.
    const locks = new Map<string, Semaphore.Semaphore>();
    const lockFor = (id: string): Semaphore.Semaphore => {
      const existing = locks.get(id);
      if (existing !== undefined) return existing;
      const created = Semaphore.makeUnsafe(1);
      locks.set(id, created);
      return created;
    };

    const readDocument = (id: string) =>
      fs.readFileString(claimsPath(id)).pipe(
        Effect.mapError((cause) => namespaceError("read", cause)),
        Effect.flatMap((text) =>
          Schema.decodeEffect(Schema.fromJsonString(ClaimsDocument))(text).pipe(
            Effect.mapError((cause) => namespaceError("decode", cause)),
          ),
        ),
        Effect.map((document) => document.claims),
      );
    const read = (id: string): Effect.Effect<ReadonlyArray<ResourceClaim>, NamespaceError> =>
      fs.exists(claimsPath(id)).pipe(
        Effect.mapError((cause) => namespaceError("read", cause)),
        Effect.flatMap((exists) => (exists ? readDocument(id) : Effect.succeed([]))),
      );

    const write = (
      id: string,
      claims: ReadonlyArray<ResourceClaim>,
    ): Effect.Effect<void, NamespaceError> =>
      fs.makeDirectory(stackRoot(id), { recursive: true, mode: 0o700 }).pipe(
        Effect.mapError((cause) => namespaceError("write", cause)),
        Effect.andThen(
          Schema.encodeEffect(Schema.fromJsonString(ClaimsDocument))({ claims }).pipe(
            Effect.mapError((cause) => namespaceError("encode", cause)),
          ),
        ),
        Effect.flatMap((content) =>
          Publication.publish(fs, path, {
            target: claimsPath(id),
            content,
            platform: options.platform,
          }),
        ),
      );

    const update = (
      id: string,
      next: (current: ReadonlyArray<ResourceClaim>) => ReadonlyArray<ResourceClaim>,
    ) =>
      lockFor(id).withPermits(1)(
        read(id).pipe(
          Effect.flatMap((current) => {
            const updated = next(current);
            // An unclaim (or a no-op) that still finds nothing recorded must not recreate the
            // stack's directory: the stack may already be fully destroyed, with this call only a
            // finalizer running after that, racing the directory it would otherwise resurrect.
            if (current.length === 0 && updated.length === 0) return Effect.void;
            return write(id, updated);
          }),
        ),
      );

    const claim = Effect.fn("Namespace.Claims.claim")((stackId: string, claimed: ResourceClaim) =>
      update(stackId, (current) =>
        current.some((entry) => sameClaim(entry, claimed)) ? current : [...current, claimed],
      ),
    );
    const unclaim = Effect.fn("Namespace.Claims.unclaim")(
      (stackId: string, claimed: ResourceClaim) =>
        update(stackId, (current) => current.filter((entry) => !sameClaim(entry, claimed))),
    );
    const readClaims = Effect.fn("Namespace.Claims.readClaims")((stackId: string) => read(stackId));

    return { claim, unclaim, readClaims };
  });

/** A narrow capability a container runtime uses to journal exact container identities. */
export interface ContainerClaims {
  /** `daemonId`, when known, is recorded so reconcile never drops a claim seen from another daemon. */
  readonly claim: (id: string, daemonId?: string) => Effect.Effect<void, NamespaceError>;
  readonly unclaim: (id: string) => Effect.Effect<void, NamespaceError>;
}

/** A narrow capability for journaling a directory outside the owner's normal data tree. */
export interface DirectoryClaims {
  readonly claim: (directoryPath: string) => Effect.Effect<void, NamespaceError>;
  readonly unclaim: (directoryPath: string) => Effect.Effect<void, NamespaceError>;
}

/** Scopes the claims journal to one stack, exposing only its container and directory operations. */
export const forStack = (
  state: Interface,
  stackId: string,
): { readonly containers: ContainerClaims; readonly directories: DirectoryClaims } => ({
  containers: {
    claim: (id, daemonId) =>
      state.claim(stackId, {
        kind: "container",
        id,
        ...(daemonId === undefined ? {} : { daemonId }),
      }),
    unclaim: (id) => state.unclaim(stackId, { kind: "container", id }),
  },
  directories: {
    claim: (directoryPath) => state.claim(stackId, { kind: "directory", id: directoryPath }),
    unclaim: (directoryPath) => state.unclaim(stackId, { kind: "directory", id: directoryPath }),
  },
});

/**
 * Reads a stack's recorded claims and, for each one still present, asks `remove` to reconcile it:
 * `"removed"` drops the claim, `"kept"` leaves it (for example a container claim recorded against
 * a different daemon than the one reconcile is currently running against). A claim whose removal
 * fails stays recorded, along with every claim after it, for the next acquisition to retry; it
 * reports the first failure.
 */
export const reconcile = Effect.fn("Namespace.Claims.reconcile")(function* <E, R>(
  claimsInterface: Pick<Interface, "readClaims" | "unclaim">,
  stackId: string,
  remove: (claim: ResourceClaim) => Effect.Effect<"removed" | "kept", E, R>,
): Effect.fn.Return<void, E | NamespaceError, R> {
  for (const claim of yield* claimsInterface.readClaims(stackId)) {
    const outcome = yield* remove(claim);
    if (outcome === "removed") yield* claimsInterface.unclaim(stackId, claim);
  }
});
