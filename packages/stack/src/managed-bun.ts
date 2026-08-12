import { BunFileSystem } from "@effect/platform-bun";
import {
  createManagedStackServiceWith,
  makeManagedStackServiceWith,
  type CreateManagedStackServiceOptions,
  type MakeManagedStackServiceOptions,
  type ManagedStackServiceHandle,
} from "./managed/create-service.ts";
import { bunSqliteManagedStackRepositoryLayer } from "./managed/sqlite-bun.ts";

export * from "./managed.ts";
export { bunSqliteManagedStackRepositoryLayer };

export const createManagedStackService = (
  options: CreateManagedStackServiceOptions = {},
): ManagedStackServiceHandle =>
  createManagedStackServiceWith(BunFileSystem.layer, bunSqliteManagedStackRepositoryLayer, options);

export const makeManagedStackService = (
  options: MakeManagedStackServiceOptions,
): ManagedStackServiceHandle => makeManagedStackServiceWith(BunFileSystem.layer, options);
