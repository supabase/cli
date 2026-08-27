import { Schema } from "effect";
export declare const hook: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly mfa_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly uri: Schema.optionalKey<Schema.String>;
        readonly secrets: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly password_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly uri: Schema.optionalKey<Schema.String>;
        readonly secrets: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly custom_access_token: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly uri: Schema.optionalKey<Schema.String>;
        readonly secrets: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly send_sms: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly uri: Schema.optionalKey<Schema.String>;
        readonly secrets: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly send_email: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly uri: Schema.optionalKey<Schema.String>;
        readonly secrets: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly before_user_created: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly uri: Schema.optionalKey<Schema.String>;
        readonly secrets: Schema.optionalKey<Schema.String>;
    }>, never>;
}>, never>;
