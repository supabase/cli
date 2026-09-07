import { Schema } from "effect";
import type * as Redacted from "effect/Redacted";

const EffectDatabaseCredentialsSchema = Schema.Struct({
  url: Schema.RedactedFromValue(Schema.String),
  password: Schema.RedactedFromValue(Schema.String),
});

const EffectApiCredentialsSchema = Schema.Struct({
  publishableKey: Schema.String,
  secretKey: Schema.RedactedFromValue(Schema.String),
  anonJwt: Schema.String,
  serviceRoleJwt: Schema.RedactedFromValue(Schema.String),
});

const EffectStorageCredentialsSchema = Schema.Struct({
  endpoint: Schema.String,
  region: Schema.String,
  accessKeyId: Schema.String,
  secretAccessKey: Schema.RedactedFromValue(Schema.String),
});

export const EffectStackCredentialsSchema = Schema.Struct({
  database: EffectDatabaseCredentialsSchema,
  api: EffectApiCredentialsSchema,
  storage: Schema.optionalKey(EffectStorageCredentialsSchema),
});
export interface EffectStackCredentials {
  readonly database: {
    readonly url: Redacted.Redacted<string>;
    readonly password: Redacted.Redacted<string>;
  };
  readonly api: {
    readonly publishableKey: string;
    readonly secretKey: Redacted.Redacted<string>;
    readonly anonJwt: string;
    readonly serviceRoleJwt: Redacted.Redacted<string>;
  };
  readonly storage?: {
    readonly endpoint: string;
    readonly region: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: Redacted.Redacted<string>;
  };
}

export const PromiseStackCredentialsSchema = Schema.Struct({
  database: Schema.Struct({
    url: Schema.String,
    password: Schema.String,
  }),
  api: Schema.Struct({
    publishableKey: Schema.String,
    secretKey: Schema.String,
    anonJwt: Schema.String,
    serviceRoleJwt: Schema.String,
  }),
  storage: Schema.optionalKey(
    Schema.Struct({
      endpoint: Schema.String,
      region: Schema.String,
      accessKeyId: Schema.String,
      secretAccessKey: Schema.String,
    }),
  ),
});
export type PromiseStackCredentials = Schema.Schema.Type<typeof PromiseStackCredentialsSchema>;
