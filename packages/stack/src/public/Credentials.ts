import { Schema } from "effect";

export const DatabaseCredentialsSchema = Schema.Struct({
  url: Schema.String,
  password: Schema.String,
});
export type DatabaseCredentials = Schema.Schema.Type<typeof DatabaseCredentialsSchema>;

export const ApiCredentialsSchema = Schema.Struct({
  publishableKey: Schema.String,
  secretKey: Schema.String,
  anonJwt: Schema.String,
  serviceRoleJwt: Schema.String,
});
export type ApiCredentials = Schema.Schema.Type<typeof ApiCredentialsSchema>;

export const StorageCredentialsSchema = Schema.Struct({
  endpoint: Schema.String,
  region: Schema.String,
  accessKeyId: Schema.String,
  secretAccessKey: Schema.String,
});
export type StorageCredentials = Schema.Schema.Type<typeof StorageCredentialsSchema>;

export const EmptyServiceCredentialsSchema = Schema.Struct({ kind: Schema.Literal("none") });
export type EmptyServiceCredentials = Schema.Schema.Type<typeof EmptyServiceCredentialsSchema>;

export const EffectStackCredentialsSchema = Schema.Struct({
  database: Schema.optionalKey(
    Schema.Struct({
      url: Schema.Redacted(Schema.String),
      password: Schema.Redacted(Schema.String),
    }),
  ),
  api: Schema.optionalKey(
    Schema.Struct({
      publishableKey: Schema.String,
      secretKey: Schema.Redacted(Schema.String),
      anonJwt: Schema.String,
      serviceRoleJwt: Schema.Redacted(Schema.String),
    }),
  ),
  storage: Schema.optionalKey(
    Schema.Struct({
      endpoint: Schema.String,
      region: Schema.String,
      accessKeyId: Schema.String,
      secretAccessKey: Schema.Redacted(Schema.String),
    }),
  ),
});
export type EffectStackCredentials = Schema.Schema.Type<typeof EffectStackCredentialsSchema>;

export const PromiseStackCredentialsSchema = Schema.Struct({
  database: Schema.optionalKey(Schema.Struct({ url: Schema.String, password: Schema.String })),
  api: Schema.optionalKey(
    Schema.Struct({
      publishableKey: Schema.String,
      secretKey: Schema.String,
      anonJwt: Schema.String,
      serviceRoleJwt: Schema.String,
    }),
  ),
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
