import { Schema } from "effect";
export declare const sessions: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly timebox: Schema.optionalKey<Schema.String>;
    readonly inactivity_timeout: Schema.optionalKey<Schema.String>;
}>, never>;
