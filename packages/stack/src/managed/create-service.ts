import { managedRegistryPath, resolveManagedStateRoot } from "./paths.ts";
import type { ManagedStackRepository } from "./repository.ts";
import { makeManagedStackService, type ManagedStackService } from "./service.ts";

export interface CreateManagedStackServiceOptions {
  readonly stateRoot?: string;
  readonly repository?: ManagedStackRepository;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  readonly ownerPid?: number;
  readonly publicationTimeoutMs?: number;
  readonly publicationPollMs?: number;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
}

/**
 * The whole body of every runtime entrypoint's `createManagedStackService`,
 * parameterized only by how a registry file is opened. Keeping it here — rather
 * than duplicating it per entrypoint — makes option drift between the Bun and
 * Node entries structurally impossible, and lets the Bun test suite cover the
 * plumbing that the Node entry (which imports `node:sqlite`) shares.
 */
export const createManagedStackServiceWith = (
  openRepository: (registryPath: string) => ManagedStackRepository,
  options: CreateManagedStackServiceOptions,
): ManagedStackService => {
  const stateRoot = resolveManagedStateRoot(options);
  const repository = options.repository ?? openRepository(managedRegistryPath(stateRoot));
  return makeManagedStackService({
    repository,
    stateRoot,
    idFactory: options.idFactory,
    clock: options.clock,
    ownerPid: options.ownerPid,
    publicationTimeoutMs: options.publicationTimeoutMs,
    publicationPollMs: options.publicationPollMs,
    isProcessAlive: options.isProcessAlive,
  });
};
