import { Schema } from "effect";
export declare const realtime: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly ip_version: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
    readonly max_header_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
}>, never>;
