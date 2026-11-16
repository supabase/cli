import type { OpenApiOperationId } from "@supabase/api/effect";

export interface ApiField {
  readonly name: string;
  readonly path: ReadonlyArray<string>;
  readonly type: "string" | "number" | "integer" | "boolean";
  readonly required: boolean;
  readonly repeatable: boolean;
  readonly description: string;
  readonly choices?: ReadonlyArray<string>;
}

interface ApiWait {
  readonly read: OpenApiOperationId;
  readonly params: Readonly<Record<string, string>>;
  readonly status: string;
  readonly succeeded: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<string>;
  readonly error?: string;
}

export interface ApiCommandData {
  readonly operationId: OpenApiOperationId;
  readonly httpMethod: string;
  readonly path: string;
  readonly group: string;
  readonly method: string;
  readonly summary: string;
  readonly description: string;
  readonly experimental: boolean;
  readonly fields: ReadonlyArray<ApiField>;
  readonly constants: ReadonlyArray<{
    readonly path: ReadonlyArray<string>;
    readonly value: string;
  }>;
  readonly wait?: ApiWait;
}
