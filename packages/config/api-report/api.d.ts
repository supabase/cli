import { Schema } from "effect";
export declare const api: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly schemas: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
    readonly extra_search_path: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
    readonly max_rows: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly auto_expose_new_tables: Schema.optionalKey<Schema.Boolean>;
    readonly tls: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly cert_path: Schema.optionalKey<Schema.String>;
        readonly key_path: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly external_url: Schema.optionalKey<Schema.String>;
}>, never>;
