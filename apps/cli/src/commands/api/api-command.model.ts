import type { OperationId } from "@supabase/api/effect";

/** Where a generated command's input lands in the API request. */
export type ApiCommandBinding =
  | {
      readonly location: "path";
      /** Path parameter name. */
      readonly name: string;
      /** The value comes from the command target (`--project-ref` or the linked project), not a flag. */
      readonly source: "target";
    }
  | {
      readonly location: "path";
      readonly name: string;
      /** The value comes from the command's positional argument. */
      readonly source: "argument";
      /** Name of the positional argument that supplies the value. */
      readonly argument: string;
    }
  | {
      readonly location: "query";
      /** Query parameter name. */
      readonly name: string;
      readonly source: "flag";
      /** Name of the flag that supplies the value. */
      readonly flag: string;
    }
  | {
      readonly location: "header";
      /** Header name as declared in the spec. */
      readonly name: string;
      readonly source: "flag";
      readonly flag: string;
    }
  | {
      readonly location: "body";
      /** Body field name. */
      readonly name: string;
      /** JSON Pointer to the field in the whole request body, e.g. `/data/attributes/schema`. */
      readonly pointer: string;
      readonly source: "flag";
      readonly flag: string;
    };

/** One flag of a generated command, derived from a query parameter, a header parameter or a request body field. */
export interface ApiCommandFlag {
  /** Kebab-case flag name without the leading dashes. */
  readonly name: string;
  readonly type: "string" | "integer" | "number" | "boolean";
  readonly choices?: readonly string[];
  readonly repeatable: boolean;
  readonly required: boolean;
  /** A body field reviewed as a secret; its value is never echoed or recorded. */
  readonly sensitive?: true;
  readonly description?: string;
}

/** What `--wait` polls after a change and when it is done. */
export interface ApiCommandWait {
  /** Operation id of the read operation to poll; the command's own when it polls itself. */
  readonly read: string;
  /** Read parameter name to JSON pointer into the change response. */
  readonly params: Readonly<Record<string, string>>;
  /** JSON pointer to the status in the read response. */
  readonly status: string;
  readonly succeeded: readonly string[];
  readonly failed: readonly string[];
  /** JSON pointer to the failure reason in the read response. */
  readonly error?: string;
}

/** A generated command as plain data; the runtime turns each entry into a CLI command. */
export interface ApiCommandEntry {
  /** Noun, optional sub-groups and the verb, e.g. `["warehouse", "enable"]`. */
  readonly command: readonly string[];
  /** Kebab-case operation id from the OpenAPI spec. */
  readonly operationId: string;
  /** Key of the operation in the typed client's `operationDefinitions`. */
  readonly definition: OperationId;
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly apiPath: string;
  readonly summary: string;
  readonly description?: string;
  readonly readOnly: boolean;
  /** Feature that gates the command's noun. */
  readonly feature: string;
  /** Request body shape; `json-envelope` bodies wrap fields in `data.attributes`. */
  readonly body?: {
    readonly contentType: "application/json";
    readonly kind: "json-object" | "json-envelope";
    /** The envelope's `data.type` value. */
    readonly type?: string;
  };
  /** Success response shape from the first 2xx response. */
  readonly response: {
    readonly status: number;
    readonly kind: "json" | "text" | "empty";
  };
  /** The positional argument that carries the operation's one non-`ref` path parameter. */
  readonly argument?: {
    readonly name: string;
    readonly description?: string;
  };
  readonly flags: readonly ApiCommandFlag[];
  readonly bindings: readonly ApiCommandBinding[];
  readonly wait?: ApiCommandWait;
}

/** OpenAPI schemas of one operation with every `$ref` inlined. */
export interface ApiCommandSchemas {
  readonly request?: { readonly contentType: "application/json"; readonly schema: unknown };
  readonly result: unknown;
}
