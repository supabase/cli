import type { SchemaIndexNode } from "../schema-index-core.ts";

export interface CompiledValidator {
  (data: unknown): boolean;
  errors?: ReadonlyArray<{
    readonly instancePath: string;
    readonly keyword: string;
    readonly message?: string;
    readonly params: Readonly<Record<string, unknown>>;
  }> | null;
}

export const root: CompiledValidator;
export const remotes: CompiledValidator;
export const schemaIndex: SchemaIndexNode;
