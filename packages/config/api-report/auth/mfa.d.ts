import { Schema } from "effect";
export declare const mfa: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly totp: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly phone: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
    }>, never>;
    readonly web_authn: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly max_enrolled_factors: Schema.withDecodingDefaultKey<Schema.Number, never>;
}>, never>;
