import { Schema } from "effect";
export declare const experimental: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly orioledb_version: Schema.optionalKey<Schema.String>;
    readonly s3_host: Schema.optionalKey<Schema.String>;
    readonly s3_region: Schema.optionalKey<Schema.String>;
    readonly s3_access_key: Schema.optionalKey<Schema.String>;
    readonly s3_secret_key: Schema.optionalKey<Schema.String>;
    readonly webhooks: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>>;
    readonly pgdelta: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly declarative_schema_path: Schema.optionalKey<Schema.String>;
        readonly format_options: Schema.optionalKey<Schema.String>;
    }>, never>>;
    readonly inspect: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly rules: Schema.withDecodingDefaultKey<Schema.$Array<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly query: Schema.optionalKey<Schema.String>;
            readonly name: Schema.optionalKey<Schema.String>;
            readonly pass: Schema.optionalKey<Schema.String>;
            readonly fail: Schema.optionalKey<Schema.String>;
        }>, never>>, never>;
    }>, never>>;
}>, never>;
