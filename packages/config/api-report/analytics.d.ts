import { Schema } from "effect";
export declare const analytics: Schema.withDecodingDefaultKey<Schema.Struct<{
    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
    readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
    readonly backend: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
    readonly vector_port: Schema.optionalKey<Schema.Number>;
    readonly gcp_project_id: Schema.optionalKey<Schema.String>;
    readonly gcp_project_number: Schema.optionalKey<Schema.String>;
    readonly gcp_jwt_path: Schema.optionalKey<Schema.String>;
}>, never>;
