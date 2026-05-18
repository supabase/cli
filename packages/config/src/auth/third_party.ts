import { Effect, Schema } from "effect";

const tags = ["auth"];

const defaultThirdParty = {};
const defaultEnabled = false;

const enabledField = Schema.Boolean.annotate({
  default: defaultEnabled,
  description: "Enable this third-party auth provider.",
  tags,
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed(defaultEnabled)));

export const third_party = Schema.Struct({
  firebase: Schema.Struct({
    enabled: enabledField,
    project_id: Schema.optionalKey(
      Schema.String.annotate({
        description: "Firebase project ID.",
        tags,
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  auth0: Schema.Struct({
    enabled: enabledField,
    tenant: Schema.optionalKey(
      Schema.String.annotate({
        description: "Auth0 tenant.",
        tags,
      }),
    ),
    tenant_region: Schema.optionalKey(
      Schema.String.annotate({
        description: "Auth0 tenant region.",
        tags,
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  aws_cognito: Schema.Struct({
    enabled: enabledField,
    user_pool_id: Schema.optionalKey(
      Schema.String.annotate({
        description: "AWS Cognito user pool ID.",
        tags,
      }),
    ),
    user_pool_region: Schema.optionalKey(
      Schema.String.annotate({
        description: "AWS Cognito user pool region.",
        tags,
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  clerk: Schema.Struct({
    enabled: enabledField,
    domain: Schema.optionalKey(
      Schema.String.annotate({
        description: "Clerk domain.",
        tags,
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  workos: Schema.Struct({
    enabled: enabledField,
    issuer_url: Schema.optionalKey(
      Schema.String.annotate({
        description: "WorkOS issuer URL.",
        tags,
      }),
    ),
  }).pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefaultKey(Effect.succeed({ ...defaultThirdParty })));
