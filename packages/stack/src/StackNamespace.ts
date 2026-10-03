import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { namespaceError, type NamespaceError } from "./namespace/Capabilities.ts";
import * as FsDriver from "./namespace/drivers/FileSystem.ts";
import * as Lease from "./namespace/Lease.ts";
import * as Registry from "./namespace/Registry.ts";
import { restrictDirectoryToOwner } from "./runtime/postgres-user.ts";

export { NamespaceError } from "./namespace/Capabilities.ts";
export { LeaseHeldError, LeaseHolder } from "./namespace/Lease.ts";
export {
  PortClaim,
  SavedStack,
  StackCredentials,
  StackKeysInput,
  StackLifetime,
  type StackClaims,
} from "./namespace/Registry.ts";

export interface Interface extends Registry.Interface, Lease.Interface {}

export class Service extends Context.Service<Service, Interface>()(
  "@supabase/stack/StackNamespace",
) {}

export interface Options {
  readonly root: string;
  readonly platform?: NodeJS.Platform;
  readonly onInvalidState?: (id: string, error: NamespaceError) => Effect.Effect<void>;
  /** Observes a lease request that found the lease held and is waiting for it. */
  readonly onLeaseContended?: (id: string) => Effect.Effect<void>;
}

const make = Effect.fn("Namespace.acquire")(function* (
  options: Options,
): Effect.fn.Return<Interface, NamespaceError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.normalize(options.root);
  yield* fs
    .makeDirectory(root, { recursive: true })
    .pipe(Effect.mapError((cause) => namespaceError("root", cause)));
  yield* restrictDirectoryToOwner(fs, root).pipe(
    Effect.mapError((cause) => namespaceError("root", cause)),
  );
  yield* FsDriver.assertHardLinkSupport(fs, path, root);
  const registry = yield* Registry.make({
    root,
    platform: options.platform,
    onInvalidState: options.onInvalidState,
  });
  const lease = yield* Lease.make({
    root,
    platform: options.platform,
    onLeaseContended: options.onLeaseContended,
    isRegistered: (id) => registry.read(id).pipe(Effect.map((saved) => saved !== undefined)),
  });
  return { ...registry, ...lease };
});

export const layer = (options: Options) =>
  Layer.effect(Service, make(options).pipe(Effect.map(Service.of)));
