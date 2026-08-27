import { Schema } from "effect";
export declare const sms: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly twilio: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly account_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly message_service_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly auth_token: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly twilio_verify: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly account_sid: Schema.optionalKey<Schema.String>;
        readonly message_service_sid: Schema.optionalKey<Schema.String>;
        readonly auth_token: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly messagebird: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly originator: Schema.optionalKey<Schema.String>;
        readonly access_key: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly textlocal: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly sender: Schema.optionalKey<Schema.String>;
        readonly api_key: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly vonage: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly from: Schema.optionalKey<Schema.String>;
        readonly api_key: Schema.optionalKey<Schema.String>;
        readonly api_secret: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly test_otp: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
}>, never>;
