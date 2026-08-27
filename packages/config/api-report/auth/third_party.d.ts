import { Schema } from "effect";
export declare const third_party: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly firebase: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly project_id: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly auth0: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly tenant: Schema.optionalKey<Schema.String>;
        readonly tenant_region: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly aws_cognito: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly user_pool_id: Schema.optionalKey<Schema.String>;
        readonly user_pool_region: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly clerk: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly domain: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly workos: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly issuer_url: Schema.optionalKey<Schema.String>;
    }>, never>;
}>, never>;
