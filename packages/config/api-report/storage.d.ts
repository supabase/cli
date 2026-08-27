import { Schema } from "effect";
export declare const storage: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly file_size_limit: Schema.withDecodingDefaultKey<Schema.decodeTo<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number]>, never, never>, never>;
    readonly image_transformation: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>>;
    readonly buckets: Schema.optionalKey<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
        readonly public: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly file_size_limit: Schema.withDecodingDefaultKey<Schema.decodeTo<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number]>, never, never>, never>;
        readonly allowed_mime_types: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly objects_path: Schema.withDecodingDefaultKey<Schema.String, never>;
    }>, never>>>;
    readonly s3_protocol: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly analytics: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly max_namespaces: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly max_tables: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly max_catalogs: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly buckets: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{}>, never>>, never>;
    }>, never>;
    readonly vector: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly max_buckets: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly max_indexes: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly buckets: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{}>, never>>, never>;
    }>, never>;
}>, never>;
