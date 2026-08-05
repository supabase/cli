import type { ProjectConfig, ProjectEnvironment } from "@supabase/config";
import {
  defaultJwtSecret,
  type AuthConfig,
  type AuthExternalProviderConfig,
  type AuthHookConfig,
  type AuthSmsConfig,
  type LocalCredentials,
  type LocalJwtSigningKey,
  type LocalJwtSigningMaterial,
  type PasswordRequirements,
  validateLocalJwtSigningKeys,
} from "@supabase/stack/effect";
import { Data, Effect, Schema } from "effect";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export class AuthStackConfigError extends Data.TaggedError("AuthStackConfigError")<{
  readonly path: string;
  readonly detail: string;
  readonly suggestion: string;
}> {}

const LocalJwtSigningKeySchema = Schema.Struct({
  kty: Schema.String,
  kid: Schema.optionalKey(Schema.String),
  use: Schema.optionalKey(Schema.String),
  key_ops: Schema.optionalKey(Schema.Array(Schema.String)),
  alg: Schema.optionalKey(Schema.String),
  ext: Schema.optionalKey(Schema.Boolean),
  n: Schema.optionalKey(Schema.String),
  e: Schema.optionalKey(Schema.String),
  d: Schema.optionalKey(Schema.String),
  p: Schema.optionalKey(Schema.String),
  q: Schema.optionalKey(Schema.String),
  dp: Schema.optionalKey(Schema.String),
  dq: Schema.optionalKey(Schema.String),
  qi: Schema.optionalKey(Schema.String),
  crv: Schema.optionalKey(Schema.String),
  x: Schema.optionalKey(Schema.String),
  y: Schema.optionalKey(Schema.String),
});
const decodeSigningKeys = Schema.decodeUnknownSync(Schema.Array(LocalJwtSigningKeySchema));

function missingRequired(path: string): AuthStackConfigError {
  return new AuthStackConfigError({
    path,
    detail: `Auth configuration is incomplete at ${path}.`,
    suggestion: "Provide the required project configuration value; use env() for secrets.",
  });
}

function required(value: string | undefined, path: string): string {
  if (value === undefined || value.length === 0) throw missingRequired(path);
  return value;
}

function requiredNumber(value: number | undefined, path: string): number {
  if (value === undefined) throw missingRequired(path);
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function environmentOverride(
  environment: ProjectEnvironment | null,
  name: string,
  configured: string | undefined,
): string | undefined {
  const value = environment?.values[name];
  if (value === undefined || value.length === 0) return configured;
  const match = /^env\(([^)]+)\)$/.exec(value);
  if (match === null) return value;
  const referencedName = match[1];
  if (referencedName === undefined) return value;
  const referenced = environment?.values[referencedName];
  return referenced === undefined || referenced.length === 0 ? value : referenced;
}

function invalidOverride(path: string, suggestion: string): AuthStackConfigError {
  return new AuthStackConfigError({
    path,
    detail: `Invalid Auth environment override at ${path}.`,
    suggestion,
  });
}

const GO_BOOLEAN_VALUES: Readonly<Record<string, boolean>> = {
  "1": true,
  t: true,
  T: true,
  TRUE: true,
  true: true,
  True: true,
  "0": false,
  f: false,
  F: false,
  FALSE: false,
  false: false,
  False: false,
};

function envBoolean(input: {
  readonly environment: ProjectEnvironment | null;
  readonly name: string;
  readonly configured: boolean;
  readonly path: string;
  readonly enabled?: boolean;
}): boolean {
  if (input.enabled === false) return input.configured;
  const value = environmentOverride(input.environment, input.name, undefined);
  if (value === undefined) return input.configured;
  const parsed = GO_BOOLEAN_VALUES[value];
  if (parsed === undefined) {
    throw invalidOverride(input.path, "Use a Go-compatible boolean such as true, false, 1, or 0.");
  }
  return parsed;
}

function parseGoUnsigned(value: string): number | undefined {
  const signless = value.startsWith("+") ? value.slice(1) : value;
  if (signless.length === 0 || signless.startsWith("-")) return undefined;
  let base = 10;
  let digits = signless;
  if (/^0[xX]/.test(signless)) {
    base = 16;
    digits = signless.slice(2);
  } else if (/^0[oO]/.test(signless)) {
    base = 8;
    digits = signless.slice(2);
  } else if (/^0[0-7]+$/.test(signless)) {
    base = 8;
    digits = signless.slice(1);
  }
  if (digits.length === 0) return undefined;
  const validDigits = base === 16 ? /^[0-9a-fA-F]+$/ : base === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!validDigits.test(digits)) return undefined;
  const parsed = Number.parseInt(digits, base);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function envNumber(input: {
  readonly environment: ProjectEnvironment | null;
  readonly name: string;
  readonly configured: number | undefined;
  readonly path: string;
  readonly max?: number;
  readonly enabled?: boolean;
}): number | undefined {
  if (input.enabled === false) return input.configured;
  const value = environmentOverride(input.environment, input.name, undefined);
  if (value === undefined) return input.configured;
  const parsed = parseGoUnsigned(value);
  if (parsed === undefined || (input.max !== undefined && parsed > input.max)) {
    throw invalidOverride(input.path, "Use a non-negative integer in the supported range.");
  }
  return parsed;
}

function envString(input: {
  readonly environment: ProjectEnvironment | null;
  readonly name: string;
  readonly configured: string | undefined;
  readonly enabled?: boolean;
}): string | undefined {
  return input.enabled === false
    ? input.configured
    : environmentOverride(input.environment, input.name, input.configured);
}

function envList(input: {
  readonly environment: ProjectEnvironment | null;
  readonly name: string;
  readonly configured: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const value = environmentOverride(input.environment, input.name, undefined);
  return value === undefined ? input.configured : value.length === 0 ? [] : value.split(",");
}

function resolvePasswordRequirements(value: string): PasswordRequirements {
  switch (value) {
    case "":
    case "letters_digits":
    case "lower_upper_letters_digits":
    case "lower_upper_letters_digits_symbols":
      return value;
    default:
      throw new AuthStackConfigError({
        path: "auth.password_requirements",
        detail: "The configured Auth password requirements are not supported.",
        suggestion: "Use one of the password requirement policies accepted by project config.",
      });
  }
}

function resolveSmsProvider(input: {
  readonly sms: ProjectConfig["auth"]["sms"];
  readonly authDocument: Readonly<Record<string, unknown>> | undefined;
  readonly environment: ProjectEnvironment | null;
}): AuthSmsConfig["provider"] {
  const smsDocument = isRecord(input.authDocument?.sms) ? input.authDocument.sms : undefined;
  const providerPresent = (name: string) => name === "twilio" || isRecord(smsDocument?.[name]);
  const enabled = (name: string, configured: boolean) =>
    envBoolean({
      environment: input.environment,
      name: `SUPABASE_AUTH_SMS_${name.toUpperCase()}_ENABLED`,
      configured,
      path: `auth.sms.${name}.enabled`,
      enabled: providerPresent(name),
    });
  const providerString = (
    name: string,
    field: string,
    configured: string | undefined,
  ): string | undefined =>
    envString({
      environment: input.environment,
      name: `SUPABASE_AUTH_SMS_${name.toUpperCase()}_${field.toUpperCase()}`,
      configured,
      enabled: providerPresent(name),
    });
  const { sms } = input;
  if (enabled("twilio", sms.twilio.enabled)) {
    return {
      _tag: "twilio",
      accountSid:
        providerString("twilio", "account_sid", sms.twilio.account_sid) ?? sms.twilio.account_sid,
      messageServiceSid:
        providerString("twilio", "message_service_sid", sms.twilio.message_service_sid) ??
        sms.twilio.message_service_sid,
      authToken: required(
        providerString("twilio", "auth_token", sms.twilio.auth_token),
        "auth.sms.twilio.auth_token",
      ),
    };
  }
  if (enabled("twilio_verify", sms.twilio_verify.enabled)) {
    return {
      _tag: "twilio-verify",
      accountSid: required(
        providerString("twilio_verify", "account_sid", sms.twilio_verify.account_sid),
        "auth.sms.twilio_verify.account_sid",
      ),
      messageServiceSid: required(
        providerString(
          "twilio_verify",
          "message_service_sid",
          sms.twilio_verify.message_service_sid,
        ),
        "auth.sms.twilio_verify.message_service_sid",
      ),
      authToken: required(
        providerString("twilio_verify", "auth_token", sms.twilio_verify.auth_token),
        "auth.sms.twilio_verify.auth_token",
      ),
    };
  }
  if (enabled("messagebird", sms.messagebird.enabled)) {
    return {
      _tag: "messagebird",
      originator: required(
        providerString("messagebird", "originator", sms.messagebird.originator),
        "auth.sms.messagebird.originator",
      ),
      accessKey: required(
        providerString("messagebird", "access_key", sms.messagebird.access_key),
        "auth.sms.messagebird.access_key",
      ),
    };
  }
  if (enabled("textlocal", sms.textlocal.enabled)) {
    return {
      _tag: "textlocal",
      sender: required(
        providerString("textlocal", "sender", sms.textlocal.sender),
        "auth.sms.textlocal.sender",
      ),
      apiKey: required(
        providerString("textlocal", "api_key", sms.textlocal.api_key),
        "auth.sms.textlocal.api_key",
      ),
    };
  }
  if (enabled("vonage", sms.vonage.enabled)) {
    return {
      _tag: "vonage",
      from: required(providerString("vonage", "from", sms.vonage.from), "auth.sms.vonage.from"),
      apiKey: required(
        providerString("vonage", "api_key", sms.vonage.api_key),
        "auth.sms.vonage.api_key",
      ),
      apiSecret: required(
        providerString("vonage", "api_secret", sms.vonage.api_secret),
        "auth.sms.vonage.api_secret",
      ),
    };
  }
  return undefined;
}

function resolveExternalProviders(input: {
  readonly external: ProjectConfig["auth"]["external"];
  readonly authDocument: Readonly<Record<string, unknown>> | undefined;
  readonly environment: ProjectEnvironment | null;
}): Readonly<Record<string, AuthExternalProviderConfig>> {
  const externalDocument = isRecord(input.authDocument?.external)
    ? input.authDocument.external
    : undefined;
  return Object.fromEntries(
    Object.entries(input.external).map(([name, provider]) => {
      const sectionPresent = name === "apple" || isRecord(externalDocument?.[name]);
      const prefix = `SUPABASE_AUTH_EXTERNAL_${name.toUpperCase()}`;
      const stringField = (field: string, configured: string | undefined) =>
        envString({
          environment: input.environment,
          name: `${prefix}_${field.toUpperCase()}`,
          configured,
          enabled: sectionPresent,
        });
      const booleanField = (field: string, configured: boolean) =>
        envBoolean({
          environment: input.environment,
          name: `${prefix}_${field.toUpperCase()}`,
          configured,
          path: `auth.external.${name}.${field}`,
          enabled: sectionPresent,
        });
      return [
        name,
        {
          enabled: booleanField("enabled", provider.enabled),
          clientId: stringField("client_id", provider.client_id) ?? provider.client_id,
          secret: stringField("secret", provider.secret),
          url: stringField("url", provider.url) ?? provider.url,
          redirectUri: stringField("redirect_uri", provider.redirect_uri),
          skipNonceCheck: booleanField("skip_nonce_check", provider.skip_nonce_check),
          emailOptional: booleanField("email_optional", provider.email_optional),
        },
      ];
    }),
  );
}

function resolveHooks(input: {
  readonly hooks: ProjectConfig["auth"]["hook"];
  readonly authDocument: Readonly<Record<string, unknown>> | undefined;
  readonly environment: ProjectEnvironment | null;
}): Readonly<Record<string, AuthHookConfig>> {
  const hookDocument = isRecord(input.authDocument?.hook) ? input.authDocument.hook : undefined;
  return Object.fromEntries(
    Object.entries(input.hooks).map(([name, hook]) => {
      const sectionPresent = isRecord(hookDocument?.[name]);
      const prefix = `SUPABASE_AUTH_HOOK_${name.toUpperCase()}`;
      return [
        name,
        {
          enabled: envBoolean({
            environment: input.environment,
            name: `${prefix}_ENABLED`,
            configured: hook.enabled,
            path: `auth.hook.${name}.enabled`,
            enabled: sectionPresent,
          }),
          uri: envString({
            environment: input.environment,
            name: `${prefix}_URI`,
            configured: hook.uri,
            enabled: sectionPresent,
          }),
          secrets: envString({
            environment: input.environment,
            name: `${prefix}_SECRETS`,
            configured: hook.secrets,
            enabled: sectionPresent,
          }),
        },
      ];
    }),
  );
}

function decodeSigningKeyFile(
  contents: string,
): readonly [LocalJwtSigningKey, ...ReadonlyArray<LocalJwtSigningKey>] {
  const decoded = decodeSigningKeys(JSON.parse(contents)).map((key) => ({
    ...key,
    key_ops: key.key_ops === undefined ? undefined : [...key.key_ops],
  }));
  const [first, ...rest] = decoded;
  if (first === undefined) {
    throw new Error("signing key file must contain at least one key");
  }
  const keys = [first, ...rest];
  validateLocalJwtSigningKeys(keys);
  return keys;
}

function readSigningKeys(
  configDir: string,
  configuredPath: string,
): Effect.Effect<
  readonly [LocalJwtSigningKey, ...ReadonlyArray<LocalJwtSigningKey>],
  AuthStackConfigError
> {
  const path = isAbsolute(configuredPath) ? configuredPath : join(configDir, configuredPath);
  return Effect.tryPromise({
    try: async () => decodeSigningKeyFile(await readFile(path, "utf8")),
    catch: () =>
      new AuthStackConfigError({
        path: "auth.signing_keys_path",
        detail: "Unable to read or validate the configured Auth signing keys.",
        suggestion: "Provide a readable JSON array containing at least one RS256 or ES256 key.",
      }),
  });
}

interface TranslatedAuthStackConfig {
  readonly auth: AuthConfig | false;
  readonly credentials: LocalCredentials;
}

export const translateAuthStackConfig = Effect.fnUntraced(function* (input: {
  readonly projectConfig: ProjectConfig;
  readonly rawDocument?: Readonly<Record<string, unknown>>;
  readonly projectEnvironment: ProjectEnvironment | null;
  readonly configDir: string;
  readonly authEnabled: boolean;
}) {
  const { auth } = input.projectConfig;
  const authDocument = isRecord(input.rawDocument?.auth) ? input.rawDocument.auth : undefined;
  const authEnabled = input.authEnabled;
  const flatString = (field: string, configured: string | undefined) =>
    envString({
      environment: input.projectEnvironment,
      name: `SUPABASE_AUTH_${field.toUpperCase()}`,
      configured,
    });
  const flatBoolean = (field: string, configured: boolean) =>
    envBoolean({
      environment: input.projectEnvironment,
      name: `SUPABASE_AUTH_${field.toUpperCase()}`,
      configured,
      path: `auth.${field}`,
    });
  const flatNumber = (field: string, configured: number) =>
    envNumber({
      environment: input.projectEnvironment,
      name: `SUPABASE_AUTH_${field.toUpperCase()}`,
      configured,
      path: `auth.${field}`,
    }) ?? configured;
  const jwtSecret = flatString("jwt_secret", auth.jwt_secret) ?? defaultJwtSecret;
  const signingKeysPath = flatString("signing_keys_path", auth.signing_keys_path);
  let signing: LocalJwtSigningMaterial;
  if (signingKeysPath !== undefined && signingKeysPath.length > 0) {
    signing = {
      _tag: "AsymmetricJwtKeys",
      keys: yield* readSigningKeys(input.configDir, signingKeysPath),
      legacySecret: jwtSecret,
    };
  } else {
    signing = { _tag: "SymmetricJwtSecret", secret: jwtSecret };
  }

  const credentials: LocalCredentials = {
    signing,
    publishableKey: flatString("publishable_key", auth.publishable_key),
    secretKey: flatString("secret_key", auth.secret_key),
    anonKey: flatString("anon_key", auth.anon_key),
    serviceRoleKey: flatString("service_role_key", auth.service_role_key),
  };

  if (!authEnabled) return { auth: false, credentials } satisfies TranslatedAuthStackConfig;

  const smtpDocument = isRecord(authDocument?.email)
    ? isRecord(authDocument.email.smtp)
      ? authDocument.email.smtp
      : undefined
    : undefined;
  const smtpPresent = smtpDocument !== undefined;
  const smtpEnabled =
    smtpPresent &&
    envBoolean({
      environment: input.projectEnvironment,
      name: "SUPABASE_AUTH_EMAIL_SMTP_ENABLED",
      configured: smtpDocument.enabled === undefined ? true : auth.email.smtp?.enabled === true,
      path: "auth.email.smtp.enabled",
    });
  const smtpString = (field: string, configured: string | undefined) =>
    envString({
      environment: input.projectEnvironment,
      name: `SUPABASE_AUTH_EMAIL_SMTP_${field.toUpperCase()}`,
      configured,
      enabled: smtpPresent,
    });
  const smtp = smtpEnabled
    ? {
        host: required(smtpString("host", auth.email.smtp?.host), "auth.email.smtp.host"),
        port: requiredNumber(
          envNumber({
            environment: input.projectEnvironment,
            name: "SUPABASE_AUTH_EMAIL_SMTP_PORT",
            configured: auth.email.smtp?.port,
            path: "auth.email.smtp.port",
            max: 65_535,
            enabled: smtpPresent,
          }),
          "auth.email.smtp.port",
        ),
        user: required(smtpString("user", auth.email.smtp?.user), "auth.email.smtp.user"),
        pass: required(smtpString("pass", auth.email.smtp?.pass), "auth.email.smtp.pass"),
        adminEmail: required(
          smtpString("admin_email", auth.email.smtp?.admin_email),
          "auth.email.smtp.admin_email",
        ),
        senderName: smtpString("sender_name", auth.email.smtp?.sender_name),
      }
    : undefined;

  return {
    credentials,
    auth: {
      siteUrl: flatString("site_url", auth.site_url) ?? auth.site_url,
      additionalRedirectUrls: envList({
        environment: input.projectEnvironment,
        name: "SUPABASE_AUTH_ADDITIONAL_REDIRECT_URLS",
        configured: auth.additional_redirect_urls,
      }),
      jwtExpiry: flatNumber("jwt_expiry", auth.jwt_expiry),
      jwtIssuer: flatString("jwt_issuer", auth.jwt_issuer),
      enableSignup: flatBoolean("enable_signup", auth.enable_signup),
      enableAnonymousSignIns: flatBoolean(
        "enable_anonymous_sign_ins",
        auth.enable_anonymous_sign_ins,
      ),
      enableRefreshTokenRotation: flatBoolean(
        "enable_refresh_token_rotation",
        auth.enable_refresh_token_rotation,
      ),
      refreshTokenReuseInterval: flatNumber(
        "refresh_token_reuse_interval",
        auth.refresh_token_reuse_interval,
      ),
      enableManualLinking: flatBoolean("enable_manual_linking", auth.enable_manual_linking),
      minimumPasswordLength: flatNumber("minimum_password_length", auth.minimum_password_length),
      passwordRequirements: resolvePasswordRequirements(
        flatString("password_requirements", auth.password_requirements) ??
          auth.password_requirements,
      ),
      email: {
        enableSignup: envBoolean({
          environment: input.projectEnvironment,
          name: "SUPABASE_AUTH_EMAIL_ENABLE_SIGNUP",
          configured: auth.email.enable_signup,
          path: "auth.email.enable_signup",
        }),
        doubleConfirmChanges: envBoolean({
          environment: input.projectEnvironment,
          name: "SUPABASE_AUTH_EMAIL_DOUBLE_CONFIRM_CHANGES",
          configured: auth.email.double_confirm_changes,
          path: "auth.email.double_confirm_changes",
        }),
        enableConfirmations: envBoolean({
          environment: input.projectEnvironment,
          name: "SUPABASE_AUTH_EMAIL_ENABLE_CONFIRMATIONS",
          configured: auth.email.enable_confirmations,
          path: "auth.email.enable_confirmations",
        }),
        securePasswordChange: envBoolean({
          environment: input.projectEnvironment,
          name: "SUPABASE_AUTH_EMAIL_SECURE_PASSWORD_CHANGE",
          configured: auth.email.secure_password_change,
          path: "auth.email.secure_password_change",
        }),
        maxFrequency:
          envString({
            environment: input.projectEnvironment,
            name: "SUPABASE_AUTH_EMAIL_MAX_FREQUENCY",
            configured: auth.email.max_frequency,
          }) ?? auth.email.max_frequency,
        otpLength:
          envNumber({
            environment: input.projectEnvironment,
            name: "SUPABASE_AUTH_EMAIL_OTP_LENGTH",
            configured: auth.email.otp_length,
            path: "auth.email.otp_length",
          }) ?? auth.email.otp_length,
        otpExpiry:
          envNumber({
            environment: input.projectEnvironment,
            name: "SUPABASE_AUTH_EMAIL_OTP_EXPIRY",
            configured: auth.email.otp_expiry,
            path: "auth.email.otp_expiry",
          }) ?? auth.email.otp_expiry,
        smtp,
      },
      sms: {
        enableSignup: envBoolean({
          environment: input.projectEnvironment,
          name: "SUPABASE_AUTH_SMS_ENABLE_SIGNUP",
          configured: auth.sms.enable_signup,
          path: "auth.sms.enable_signup",
        }),
        enableConfirmations: envBoolean({
          environment: input.projectEnvironment,
          name: "SUPABASE_AUTH_SMS_ENABLE_CONFIRMATIONS",
          configured: auth.sms.enable_confirmations,
          path: "auth.sms.enable_confirmations",
        }),
        template:
          envString({
            environment: input.projectEnvironment,
            name: "SUPABASE_AUTH_SMS_TEMPLATE",
            configured: auth.sms.template,
          }) ?? auth.sms.template,
        maxFrequency:
          envString({
            environment: input.projectEnvironment,
            name: "SUPABASE_AUTH_SMS_MAX_FREQUENCY",
            configured: auth.sms.max_frequency,
          }) ?? auth.sms.max_frequency,
        testOtp: auth.sms.test_otp,
        provider: resolveSmsProvider({
          sms: auth.sms,
          authDocument,
          environment: input.projectEnvironment,
        }),
      },
      externalProviders: resolveExternalProviders({
        external: auth.external,
        authDocument,
        environment: input.projectEnvironment,
      }),
      hooks: resolveHooks({
        hooks: auth.hook,
        authDocument,
        environment: input.projectEnvironment,
      }),
    },
  } satisfies TranslatedAuthStackConfig;
});
