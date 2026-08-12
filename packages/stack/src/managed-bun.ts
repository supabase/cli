import {
  createManagedStackServiceWith,
  type CreateManagedStackServiceOptions,
} from "./managed/create-service.ts";
import { openBunSqliteManagedStackRepository } from "./managed/sqlite-bun.ts";

export * from "./managed.ts";
export { openBunSqliteManagedStackRepository };
export type { CreateManagedStackServiceOptions };

export const createManagedStackService = (options: CreateManagedStackServiceOptions = {}) =>
  createManagedStackServiceWith(openBunSqliteManagedStackRepository, options);
