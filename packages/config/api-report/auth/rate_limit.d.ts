import { Schema } from "effect";
export declare const rate_limit: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly email_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly sms_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly anonymous_users: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly token_refresh: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly sign_in_sign_ups: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly token_verifications: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly web3: Schema.withDecodingDefaultKey<Schema.Number, never>;
}>, never>;
