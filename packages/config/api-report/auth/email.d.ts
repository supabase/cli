import { Schema } from "effect";
export declare const email: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly double_confirm_changes: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly secure_password_change: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly otp_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly smtp: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly host: Schema.optionalKey<Schema.String>;
        readonly port: Schema.optionalKey<Schema.Number>;
        readonly user: Schema.optionalKey<Schema.String>;
        readonly pass: Schema.optionalKey<Schema.String>;
        readonly admin_email: Schema.optionalKey<Schema.String>;
        readonly sender_name: Schema.optionalKey<Schema.String>;
    }>, never>>;
    readonly template: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
        readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
    }>, never>>, never>;
    readonly notification: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
    }>, never>>, never>;
}>, never>;
