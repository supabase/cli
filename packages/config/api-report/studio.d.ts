import { Schema } from "effect";
export declare const studio: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly api_url: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly openai_api_key: Schema.optionalKey<Schema.String>;
}>, never>;
