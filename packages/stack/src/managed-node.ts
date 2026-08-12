import {
  createManagedStackServiceWith,
  type CreateManagedStackServiceOptions,
} from "./managed/create-service.ts";
import { openNodeSqliteManagedStackRepository } from "./managed/sqlite-node.ts";

export * from "./managed.ts";
export { openNodeSqliteManagedStackRepository };
export type { CreateManagedStackServiceOptions };

export const createManagedStackService = (options: CreateManagedStackServiceOptions = {}) =>
  createManagedStackServiceWith(openNodeSqliteManagedStackRepository, options);
