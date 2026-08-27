import { Schema } from "effect";
export declare const web3: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly solana: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
    readonly ethereum: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    }>, never>;
}>, never>;
