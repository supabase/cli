import { managedRegistryPath, resolveManagedStateRoot } from "./managed/paths.ts";
import type { ManagedStackRepository } from "./managed/repository.ts";
import { makeManagedStackService } from "./managed/service.ts";
import { openBunSqliteManagedStackRepository } from "./managed/sqlite-bun.ts";

export * from "./managed.ts";
export { openBunSqliteManagedStackRepository };

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

export const createManagedStackService = (options: CreateManagedStackServiceOptions = {}) => {
  const stateRoot = resolveManagedStateRoot(options);
  const repository =
    options.repository ?? openBunSqliteManagedStackRepository(managedRegistryPath(stateRoot));
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
