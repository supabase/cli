import { Schema } from "effect";
export declare const captcha: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly provider: Schema.optionalKey<Schema.Literals<string[]>>;
    readonly secret: Schema.optionalKey<Schema.String>;
}>, never>;
