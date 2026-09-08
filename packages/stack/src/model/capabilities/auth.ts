import { Schema } from "effect";
import { release, workload, type CapabilityModule } from "../CapabilityModule.ts";
import { catalogEntryFor } from "../WorkloadCatalog.ts";
import { NetworkPortSchema } from "../../public/Status.ts";

const version = catalogEntryFor("auth:auth").defaultVersion;

const Secret = Schema.Redacted(Schema.String);
const OptionalString = Schema.optionalKey(Schema.String);
const OptionalBoolean = Schema.optionalKey(Schema.Boolean);
const OptionalNumber = Schema.optionalKey(Schema.Finite);

const ProviderSchema = Schema.Struct({
  enabled: OptionalBoolean,
  client_id: OptionalString,
  secret: Schema.optionalKey(Secret),
  url: OptionalString,
  redirect_uri: OptionalString,
  skip_nonce_check: OptionalBoolean,
  email_optional: OptionalBoolean,
});

const ExternalSchema = Schema.Struct({
  apple: Schema.optionalKey(ProviderSchema),
  azure: Schema.optionalKey(ProviderSchema),
  bitbucket: Schema.optionalKey(ProviderSchema),
  discord: Schema.optionalKey(ProviderSchema),
  facebook: Schema.optionalKey(ProviderSchema),
  github: Schema.optionalKey(ProviderSchema),
  gitlab: Schema.optionalKey(ProviderSchema),
  google: Schema.optionalKey(ProviderSchema),
  kakao: Schema.optionalKey(ProviderSchema),
  keycloak: Schema.optionalKey(ProviderSchema),
  linkedin_oidc: Schema.optionalKey(ProviderSchema),
  notion: Schema.optionalKey(ProviderSchema),
  twitch: Schema.optionalKey(ProviderSchema),
  twitter: Schema.optionalKey(ProviderSchema),
  x: Schema.optionalKey(ProviderSchema),
  slack_oidc: Schema.optionalKey(ProviderSchema),
  spotify: Schema.optionalKey(ProviderSchema),
  workos: Schema.optionalKey(ProviderSchema),
  zoom: Schema.optionalKey(ProviderSchema),
});

const HookSchema = Schema.Struct({
  enabled: OptionalBoolean,
  uri: OptionalString,
  secrets: Schema.optionalKey(Secret),
});

const EmailTemplateSchema = Schema.Struct({
  subject: OptionalString,
  content_path: OptionalString,
});
const EmailNotificationSchema = Schema.Struct({
  enabled: OptionalBoolean,
  subject: OptionalString,
  content_path: OptionalString,
});
const SmtpSchema = Schema.Struct({
  enabled: OptionalBoolean,
  host: OptionalString,
  port: Schema.optionalKey(NetworkPortSchema),
  user: OptionalString,
  pass: Schema.optionalKey(Secret),
  admin_email: OptionalString,
  sender_name: OptionalString,
});

const Twilio = Schema.Struct({
  enabled: OptionalBoolean,
  account_sid: OptionalString,
  message_service_sid: OptionalString,
  auth_token: Schema.optionalKey(Secret),
});
const TwilioVerify = Schema.Struct({
  enabled: OptionalBoolean,
  account_sid: OptionalString,
  message_service_sid: OptionalString,
  auth_token: Schema.optionalKey(Secret),
});
const Messagebird = Schema.Struct({
  enabled: OptionalBoolean,
  originator: OptionalString,
  access_key: Schema.optionalKey(Secret),
});
const Textlocal = Schema.Struct({
  enabled: OptionalBoolean,
  sender: OptionalString,
  api_key: Schema.optionalKey(Secret),
});
const Vonage = Schema.Struct({
  enabled: OptionalBoolean,
  from: OptionalString,
  api_key: Schema.optionalKey(Secret),
  api_secret: Schema.optionalKey(Secret),
});

const SmsSchema = Schema.Struct({
  enable_signup: OptionalBoolean,
  enable_confirmations: OptionalBoolean,
  template: OptionalString,
  max_frequency: OptionalString,
  twilio: Schema.optionalKey(Twilio),
  twilio_verify: Schema.optionalKey(TwilioVerify),
  messagebird: Schema.optionalKey(Messagebird),
  textlocal: Schema.optionalKey(Textlocal),
  vonage: Schema.optionalKey(Vonage),
  test_otp: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const MfaSchema = Schema.Struct({
  totp: Schema.optionalKey(
    Schema.Struct({ enroll_enabled: OptionalBoolean, verify_enabled: OptionalBoolean }),
  ),
  phone: Schema.optionalKey(
    Schema.Struct({
      enroll_enabled: OptionalBoolean,
      verify_enabled: OptionalBoolean,
      otp_length: OptionalNumber,
      template: OptionalString,
      max_frequency: OptionalString,
    }),
  ),
  web_authn: Schema.optionalKey(
    Schema.Struct({ enroll_enabled: OptionalBoolean, verify_enabled: OptionalBoolean }),
  ),
  max_enrolled_factors: OptionalNumber,
});

const EmailSchema = Schema.Struct({
  enable_signup: OptionalBoolean,
  double_confirm_changes: OptionalBoolean,
  enable_confirmations: OptionalBoolean,
  secure_password_change: OptionalBoolean,
  max_frequency: OptionalString,
  otp_length: OptionalNumber,
  otp_expiry: OptionalNumber,
  smtp: Schema.optionalKey(SmtpSchema),
  template: Schema.optionalKey(Schema.Record(Schema.String, EmailTemplateSchema)),
  notification: Schema.optionalKey(Schema.Record(Schema.String, EmailNotificationSchema)),
});

const EnabledFlag = Schema.Struct({ enabled: OptionalBoolean });
const Web3Schema = Schema.Struct({
  solana: Schema.optionalKey(EnabledFlag),
  ethereum: Schema.optionalKey(EnabledFlag),
});
const CaptchaSchema = Schema.Struct({
  enabled: OptionalBoolean,
  provider: Schema.optionalKey(Schema.Literals(["hcaptcha", "turnstile"] as const)),
  secret: Schema.optionalKey(Secret),
});
const RateLimitSchema = Schema.Struct({
  email_sent: OptionalNumber,
  sms_sent: OptionalNumber,
  anonymous_users: OptionalNumber,
  token_refresh: OptionalNumber,
  sign_in_sign_ups: OptionalNumber,
  token_verifications: OptionalNumber,
  web3: OptionalNumber,
});
const SessionsSchema = Schema.Struct({
  timebox: OptionalString,
  inactivity_timeout: OptionalString,
});
const ThirdPartySchema = Schema.Struct({
  firebase: Schema.optionalKey(
    Schema.Struct({ enabled: OptionalBoolean, project_id: OptionalString }),
  ),
  auth0: Schema.optionalKey(
    Schema.Struct({
      enabled: OptionalBoolean,
      tenant: OptionalString,
      tenant_region: OptionalString,
    }),
  ),
  aws_cognito: Schema.optionalKey(
    Schema.Struct({
      enabled: OptionalBoolean,
      user_pool_id: OptionalString,
      user_pool_region: OptionalString,
    }),
  ),
  clerk: Schema.optionalKey(Schema.Struct({ enabled: OptionalBoolean, domain: OptionalString })),
  workos: Schema.optionalKey(
    Schema.Struct({ enabled: OptionalBoolean, issuer_url: OptionalString }),
  ),
});

export const AuthSettingsSchema = Schema.Struct({
  site_url: OptionalString,
  additional_redirect_urls: Schema.optionalKey(Schema.Array(Schema.String)),
  jwt_expiry: OptionalNumber,
  jwt_issuer: OptionalString,
  signing_keys_path: OptionalString,
  enable_refresh_token_rotation: OptionalBoolean,
  refresh_token_reuse_interval: OptionalNumber,
  enable_manual_linking: OptionalBoolean,
  enable_signup: OptionalBoolean,
  enable_anonymous_sign_ins: OptionalBoolean,
  minimum_password_length: OptionalNumber,
  password_requirements: Schema.optionalKey(
    Schema.Literals([
      "",
      "letters_digits",
      "lower_upper_letters_digits",
      "lower_upper_letters_digits_symbols",
    ] as const),
  ),
  publishable_key: Schema.optionalKey(Secret),
  secret_key: Schema.optionalKey(Secret),
  jwt_secret: Schema.optionalKey(Secret),
  anon_key: Schema.optionalKey(Secret),
  service_role_key: Schema.optionalKey(Secret),
  rate_limit: Schema.optionalKey(RateLimitSchema),
  captcha: Schema.optionalKey(CaptchaSchema),
  hook: Schema.optionalKey(
    Schema.Struct({
      mfa_verification_attempt: Schema.optionalKey(HookSchema),
      password_verification_attempt: Schema.optionalKey(HookSchema),
      custom_access_token: Schema.optionalKey(HookSchema),
      send_sms: Schema.optionalKey(HookSchema),
      send_email: Schema.optionalKey(HookSchema),
      before_user_created: Schema.optionalKey(HookSchema),
    }),
  ),
  mfa: Schema.optionalKey(MfaSchema),
  sessions: Schema.optionalKey(SessionsSchema),
  email: Schema.optionalKey(EmailSchema),
  sms: Schema.optionalKey(SmsSchema),
  external: Schema.optionalKey(ExternalSchema),
  web3: Schema.optionalKey(Web3Schema),
  oauth_server: Schema.optionalKey(
    Schema.Struct({
      enabled: OptionalBoolean,
      authorization_url_path: OptionalString,
      allow_dynamic_registration: OptionalBoolean,
    }),
  ),
  third_party: Schema.optionalKey(ThirdPartySchema),
});
export type AuthSettings = Schema.Schema.Type<typeof AuthSettingsSchema>;

const providerDefaults = {
  enabled: false,
  client_id: "",
  secret: undefined,
  url: "",
  redirect_uri: "",
  skip_nonce_check: false,
  email_optional: false,
};
const providers = {
  apple: providerDefaults,
  azure: providerDefaults,
  bitbucket: providerDefaults,
  discord: providerDefaults,
  facebook: providerDefaults,
  github: providerDefaults,
  gitlab: providerDefaults,
  google: providerDefaults,
  kakao: providerDefaults,
  keycloak: providerDefaults,
  linkedin_oidc: providerDefaults,
  notion: providerDefaults,
  twitch: providerDefaults,
  twitter: providerDefaults,
  x: providerDefaults,
  slack_oidc: providerDefaults,
  spotify: providerDefaults,
  workos: providerDefaults,
  zoom: providerDefaults,
} satisfies AuthSettings["external"];

const hooks = {
  mfa_verification_attempt: { enabled: false, uri: undefined, secrets: undefined },
  password_verification_attempt: { enabled: false, uri: undefined, secrets: undefined },
  custom_access_token: { enabled: false, uri: undefined, secrets: undefined },
  send_sms: { enabled: false, uri: undefined, secrets: undefined },
  send_email: { enabled: false, uri: undefined, secrets: undefined },
  before_user_created: { enabled: false, uri: undefined, secrets: undefined },
} satisfies AuthSettings["hook"];

const materializeAuthSettings = (settings: AuthSettings): AuthSettings => ({
  ...settings,
  email:
    settings.email === undefined
      ? settings.email
      : {
          ...settings.email,
          template: Object.fromEntries(
            Object.entries(settings.email.template ?? {}).map(([name, template]) => [
              name,
              { subject: undefined, content_path: undefined, ...template },
            ]),
          ),
          notification: Object.fromEntries(
            Object.entries(settings.email.notification ?? {}).map(([name, notification]) => [
              name,
              { enabled: false, subject: undefined, content_path: undefined, ...notification },
            ]),
          ),
        },
});

export const AuthModule: CapabilityModule<AuthSettings> = {
  name: "auth",
  settings: AuthSettingsSchema,
  defaultSettings: {
    site_url: "http://127.0.0.1:3000",
    additional_redirect_urls: ["https://127.0.0.1:3000"],
    jwt_expiry: 3600,
    jwt_issuer: undefined,
    signing_keys_path: undefined,
    enable_refresh_token_rotation: true,
    refresh_token_reuse_interval: 10,
    enable_manual_linking: false,
    enable_signup: true,
    enable_anonymous_sign_ins: false,
    minimum_password_length: 6,
    password_requirements: "",
    publishable_key: undefined,
    secret_key: undefined,
    jwt_secret: undefined,
    anon_key: undefined,
    service_role_key: undefined,
    rate_limit: {
      email_sent: 2,
      sms_sent: 30,
      anonymous_users: 30,
      token_refresh: 150,
      sign_in_sign_ups: 30,
      token_verifications: 30,
      web3: 30,
    },
    captcha: { enabled: false, provider: undefined, secret: undefined },
    hook: hooks,
    mfa: {
      totp: { enroll_enabled: false, verify_enabled: false },
      phone: {
        enroll_enabled: false,
        verify_enabled: false,
        otp_length: 6,
        template: "Your code is {{ .Code }}",
        max_frequency: "5s",
      },
      web_authn: { enroll_enabled: false, verify_enabled: false },
      max_enrolled_factors: 10,
    },
    sessions: { timebox: undefined, inactivity_timeout: undefined },
    email: {
      enable_signup: true,
      double_confirm_changes: true,
      enable_confirmations: false,
      secure_password_change: false,
      max_frequency: "1s",
      otp_length: 6,
      otp_expiry: 3600,
      smtp: { enabled: false },
      template: {},
      notification: {},
    },
    sms: {
      enable_signup: false,
      enable_confirmations: false,
      template: "Your code is {{ .Code }}",
      max_frequency: "5s",
      twilio: { enabled: false, account_sid: "", message_service_sid: "", auth_token: undefined },
      twilio_verify: {
        enabled: false,
        account_sid: undefined,
        message_service_sid: undefined,
        auth_token: undefined,
      },
      messagebird: { enabled: false, originator: undefined, access_key: undefined },
      textlocal: { enabled: false, sender: undefined, api_key: undefined },
      vonage: { enabled: false, from: undefined, api_key: undefined, api_secret: undefined },
      test_otp: undefined,
    },
    external: providers,
    web3: { solana: { enabled: false }, ethereum: { enabled: false } },
    oauth_server: {
      enabled: false,
      authorization_url_path: "/oauth/consent",
      allow_dynamic_registration: false,
    },
    third_party: {
      firebase: { enabled: false },
      auth0: { enabled: false },
      aws_cognito: { enabled: false },
      clerk: { enabled: false },
      workos: { enabled: false },
    },
  },
  defaultEnabled: true,
  defaultActivation: "lazy",
  defaultVersion: version,
  dependencies: ["database"],
  releases: {
    [version]: release(version, [
      workload("auth", "auth", {
        dependencies: ["database:database"],
        readiness: { portField: "api" },
      }),
    ]),
  },
  routes: [{ listener: "api", protocol: "http" }],
  secretPolicy: (path) =>
    [
      "auth.settings.publishable_key",
      "auth.settings.secret_key",
      "auth.settings.jwt_secret",
      "auth.settings.anon_key",
      "auth.settings.service_role_key",
    ].includes(path)
      ? "managed"
      : "passthrough",
  managedSecretSlots: [
    "auth.settings.publishable_key",
    "auth.settings.secret_key",
    "auth.settings.jwt_secret",
    "auth.settings.anon_key",
    "auth.settings.service_role_key",
  ],
  materialize: materializeAuthSettings,
};
