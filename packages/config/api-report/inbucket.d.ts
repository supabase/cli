import { Schema } from "effect";
export declare const inbucket: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly smtp_port: Schema.optionalKey<Schema.Number>;
    readonly pop3_port: Schema.optionalKey<Schema.Number>;
    readonly admin_email: Schema.optionalKey<Schema.String>;
    readonly sender_name: Schema.optionalKey<Schema.String>;
}>, never>;
