import { Schema } from "effect";
export declare const edge_runtime: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly policy: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
    readonly inspector_port: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly deno_version: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly secrets: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
}>, never>;
