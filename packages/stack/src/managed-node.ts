import { NodeFileSystem } from "@effect/platform-node";
import {
  createManagedStackServiceWith,
  makeManagedStackServiceWith,
  type CreateManagedStackServiceOptions,
  type MakeManagedStackServiceOptions,
  type ManagedStackServiceHandle,
} from "./managed/create-service.ts";
import { nodeSqliteManagedStackRepositoryLayer } from "./managed/sqlite-node.ts";

export * from "./managed.ts";
export { nodeSqliteManagedStackRepositoryLayer };

export const createManagedStackService = (
  options: CreateManagedStackServiceOptions = {},
): Promise<ManagedStackServiceHandle> =>
  createManagedStackServiceWith(
    NodeFileSystem.layer,
    nodeSqliteManagedStackRepositoryLayer,
    options,
  );

export const makeManagedStackService = (
  options: MakeManagedStackServiceOptions,
): Promise<ManagedStackServiceHandle> => makeManagedStackServiceWith(NodeFileSystem.layer, options);
