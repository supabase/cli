import { Schema } from "effect";
export declare const functions: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly verify_jwt: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly import_map: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly entrypoint: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly static_files: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
    readonly env: Schema.withDecodingDefaultKey<Schema.$Record<Schema.String, Schema.String>, never>;
}>, never>>, never>;
