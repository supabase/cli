import { Schema } from "effect";

const Hook = Schema.Struct({
  enabled: Schema.Boolean,
  uri: Schema.optionalKey(Schema.String),
  secrets: Schema.optionalKey(Schema.String),
});

const Factor = Schema.Struct({
  enroll_enabled: Schema.Boolean,
  verify_enabled: Schema.Boolean,
});

const External = Schema.Struct({
  enabled: Schema.Boolean,
  client_id: Schema.String,
  secret: Schema.optionalKey(Schema.String),
  url: Schema.String,
  redirect_uri: Schema.String,
  skip_nonce_check: Schema.Boolean,
  email_optional: Schema.Boolean,
});

const Twilio = Schema.Struct({
  enabled: Schema.Boolean,
  account_sid: Schema.optionalKey(Schema.String),
  auth_token: Schema.optionalKey(Schema.String),
  message_service_sid: Schema.optionalKey(Schema.String),
  content_sid: Schema.optionalKey(Schema.String),
});

const Messagebird = Schema.Struct({
  enabled: Schema.Boolean,
  access_key: Schema.optionalKey(Schema.String),
  originator: Schema.optionalKey(Schema.String),
});

const Textlocal = Schema.Struct({
  enabled: Schema.Boolean,
  api_key: Schema.optionalKey(Schema.String),
  sender: Schema.optionalKey(Schema.String),
});

const Vonage = Schema.Struct({
  enabled: Schema.Boolean,
  api_key: Schema.optionalKey(Schema.String),
  api_secret: Schema.optionalKey(Schema.String),
  from: Schema.optionalKey(Schema.String),
});

const Template = Schema.Struct({
  subject: Schema.optionalKey(Schema.String),
});

const Notification = Schema.Struct({
  enabled: Schema.Boolean,
  subject: Schema.optionalKey(Schema.String),
});

const Email = Schema.Struct({
  enable_signup: Schema.Boolean,
  double_confirm_changes: Schema.Boolean,
  enable_confirmations: Schema.Boolean,
  secure_password_change: Schema.Boolean,
  max_frequency: Schema.String,
  otp_length: Schema.Finite,
  otp_expiry: Schema.Finite,
  template: Schema.Record(Schema.String, Template),
  notification: Schema.Record(Schema.String, Notification),
});

const Sms = Schema.Struct({
  enable_signup: Schema.Boolean,
  enable_confirmations: Schema.Boolean,
  max_frequency: Schema.String,
  otp_length: Schema.Finite,
  otp_expiry: Schema.Finite,
  template: Schema.String,
  test_otp: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  twilio: Twilio,
  twilio_verify: Twilio,
  messagebird: Messagebird,
  textlocal: Textlocal,
  vonage: Vonage,
});

const Mfa = Schema.Struct({
  totp: Factor,
  web_authn: Factor,
  phone: Schema.Struct({
    ...Factor.fields,
    otp_length: Schema.Finite,
    template: Schema.String,
    max_frequency: Schema.String,
  }),
  max_enrolled_factors: Schema.Finite,
});

const RateLimit = Schema.Struct({
  email_sent: Schema.optionalKey(Schema.Finite),
  sms_sent: Schema.optionalKey(Schema.Finite),
  anonymous_users: Schema.optionalKey(Schema.Finite),
  token_refresh: Schema.optionalKey(Schema.Finite),
  sign_in_sign_ups: Schema.optionalKey(Schema.Finite),
  token_verifications: Schema.optionalKey(Schema.Finite),
  web3: Schema.optionalKey(Schema.Finite),
});

const Captcha = Schema.Struct({
  enabled: Schema.Boolean,
  provider: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.String),
});

const Sessions = Schema.Struct({
  timebox: Schema.optionalKey(Schema.String),
  inactivity_timeout: Schema.optionalKey(Schema.String),
});

const Web3 = Schema.Struct({
  solana: Schema.Struct({ enabled: Schema.Boolean }),
  ethereum: Schema.Struct({ enabled: Schema.Boolean }),
});

const OAuthServer = Schema.Struct({
  enabled: Schema.Boolean,
  authorization_url_path: Schema.String,
  allow_dynamic_registration: Schema.Boolean,
});

/** Authentication policy passed to the Auth process. */
export const Settings = Schema.Struct({
  additionalRedirectUrls: Schema.optionalKey(Schema.String),
  enableRefreshTokenRotation: Schema.optionalKey(Schema.Boolean),
  refreshTokenReuseInterval: Schema.optionalKey(Schema.Finite),
  enableManualLinking: Schema.optionalKey(Schema.Boolean),
  enableAnonymousSignIns: Schema.optionalKey(Schema.Boolean),
  minimumPasswordLength: Schema.optionalKey(Schema.Finite),
  passwordRequirements: Schema.optionalKey(Schema.String),
  jwtIssuer: Schema.optionalKey(Schema.String),
  rateLimit: Schema.optionalKey(RateLimit),
  email: Schema.optionalKey(Email),
  sms: Schema.optionalKey(Sms),
  captcha: Schema.optionalKey(Captcha),
  hooks: Schema.optionalKey(Schema.Record(Schema.String, Hook)),
  mfa: Schema.optionalKey(Mfa),
  sessions: Schema.optionalKey(Sessions),
  external: Schema.optionalKey(Schema.Record(Schema.String, External)),
  web3: Schema.optionalKey(Web3),
  oauthServer: Schema.optionalKey(OAuthServer),
});
export interface Settings extends Schema.Schema.Type<typeof Settings> {}

/** Converts Auth policy into the upstream process configuration. */
export const settingsEnvironment = (
  settings: Settings | undefined,
  externalUrl: string,
): Record<string, string> => {
  if (settings === undefined) return {};
  const env: Record<string, string> = {};
  const put = (name: string, value: string | boolean | number | undefined) => {
    if (value !== undefined) env[name] = String(value);
  };
  put("GOTRUE_URI_ALLOW_LIST", settings.additionalRedirectUrls);
  put("GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED", settings.enableRefreshTokenRotation);
  put("GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL", settings.refreshTokenReuseInterval);
  put("GOTRUE_SECURITY_MANUAL_LINKING_ENABLED", settings.enableManualLinking);
  put("GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED", settings.enableAnonymousSignIns);
  put("GOTRUE_PASSWORD_MIN_LENGTH", settings.minimumPasswordLength);
  put("GOTRUE_PASSWORD_REQUIRED_CHARACTERS", settings.passwordRequirements);
  put("GOTRUE_JWT_ISSUER", settings.jwtIssuer);
  if (settings.email !== undefined) {
    const email = settings.email;
    put("GOTRUE_EXTERNAL_EMAIL_ENABLED", email.enable_signup);
    put("GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED", email.double_confirm_changes);
    put("GOTRUE_MAILER_AUTOCONFIRM", !email.enable_confirmations);
    put("GOTRUE_SECURITY_UPDATE_PASSWORD_REQUIRE_REAUTHENTICATION", email.secure_password_change);
    put("GOTRUE_MAILER_OTP_LENGTH", email.otp_length);
    put("GOTRUE_MAILER_OTP_EXP", email.otp_expiry);
    put("GOTRUE_SMTP_MAX_FREQUENCY", email.max_frequency);
    for (const [name, template] of Object.entries(email.template))
      put(`GOTRUE_MAILER_SUBJECTS_${name.toUpperCase()}`, template.subject);
    for (const [name, notification] of Object.entries(email.notification)) {
      put(`GOTRUE_MAILER_NOTIFICATIONS_${name.toUpperCase()}_ENABLED`, notification.enabled);
      put(`GOTRUE_MAILER_SUBJECTS_${name.toUpperCase()}_NOTIFICATION`, notification.subject);
    }
  }
  if (settings.rateLimit !== undefined) {
    const limits = settings.rateLimit;
    put("GOTRUE_RATE_LIMIT_EMAIL_SENT", limits.email_sent);
    put("GOTRUE_RATE_LIMIT_SMS_SENT", limits.sms_sent);
    put("GOTRUE_RATE_LIMIT_ANONYMOUS_USERS", limits.anonymous_users);
    put("GOTRUE_RATE_LIMIT_TOKEN_REFRESH", limits.token_refresh);
    put("GOTRUE_RATE_LIMIT_OTP", limits.sign_in_sign_ups);
    put("GOTRUE_RATE_LIMIT_VERIFY", limits.token_verifications);
    put("GOTRUE_RATE_LIMIT_WEB3", limits.web3);
  }
  if (settings.sms !== undefined) {
    const sms = settings.sms;
    put("GOTRUE_EXTERNAL_PHONE_ENABLED", sms.enable_signup);
    put("GOTRUE_SMS_AUTOCONFIRM", !sms.enable_confirmations);
    put("GOTRUE_SMS_MAX_FREQUENCY", sms.max_frequency);
    put("GOTRUE_SMS_OTP_LENGTH", sms.otp_length);
    put("GOTRUE_SMS_OTP_EXP", sms.otp_expiry);
    put("GOTRUE_SMS_TEMPLATE", sms.template);
    put(
      "GOTRUE_SMS_TEST_OTP",
      Object.entries(sms.test_otp ?? {})
        .map(([phone, code]) => `${phone}:${code}`)
        .join(","),
    );
    const providers = {
      twilio: sms.twilio,
      twilio_verify: sms.twilio_verify,
      messagebird: sms.messagebird,
      textlocal: sms.textlocal,
      vonage: sms.vonage,
    };
    for (const [name, provider] of Object.entries(providers)) {
      if (!provider.enabled) continue;
      put("GOTRUE_SMS_PROVIDER", name);
      for (const [key, value] of Object.entries(provider))
        if (key !== "enabled") put(`GOTRUE_SMS_${name.toUpperCase()}_${key.toUpperCase()}`, value);
      break;
    }
  }
  if (settings.captcha !== undefined) {
    put("GOTRUE_SECURITY_CAPTCHA_ENABLED", settings.captcha.enabled);
    put("GOTRUE_SECURITY_CAPTCHA_PROVIDER", settings.captcha.provider);
    put("GOTRUE_SECURITY_CAPTCHA_SECRET", settings.captcha.secret);
  }
  for (const [name, hook] of Object.entries(settings.hooks ?? {})) {
    put(`GOTRUE_HOOK_${name.toUpperCase()}_ENABLED`, hook.enabled);
    if (hook.enabled) {
      put(`GOTRUE_HOOK_${name.toUpperCase()}_URI`, hook.uri);
      put(`GOTRUE_HOOK_${name.toUpperCase()}_SECRETS`, hook.secrets);
    }
  }
  if (settings.mfa !== undefined) {
    const mfa = settings.mfa;
    for (const [name, factor] of Object.entries({
      totp: mfa.totp,
      phone: mfa.phone,
      web_authn: mfa.web_authn,
    })) {
      put(`GOTRUE_MFA_${name.toUpperCase()}_ENROLL_ENABLED`, factor.enroll_enabled);
      put(`GOTRUE_MFA_${name.toUpperCase()}_VERIFY_ENABLED`, factor.verify_enabled);
    }
    put("GOTRUE_MFA_MAX_ENROLLED_FACTORS", mfa.max_enrolled_factors);
    put("GOTRUE_MFA_PHONE_TEMPLATE", mfa.phone.template);
    put("GOTRUE_MFA_PHONE_OTP_LENGTH", mfa.phone.otp_length);
    put("GOTRUE_MFA_PHONE_MAX_FREQUENCY", mfa.phone.max_frequency);
  }
  put("GOTRUE_SESSIONS_TIMEBOX", settings.sessions?.timebox);
  put("GOTRUE_SESSIONS_INACTIVITY_TIMEOUT", settings.sessions?.inactivity_timeout);
  for (const [name, provider] of Object.entries(settings.external ?? {})) {
    const prefix = `GOTRUE_EXTERNAL_${name.toUpperCase()}`;
    put(`${prefix}_ENABLED`, provider.enabled);
    if (!provider.enabled) continue;
    put(`${prefix}_CLIENT_ID`, provider.client_id);
    put(`${prefix}_SECRET`, provider.secret);
    put(`${prefix}_URL`, provider.url || undefined);
    put(
      `${prefix}_REDIRECT_URI`,
      provider.redirect_uri || `${externalUrl.replace(/\/+$/u, "")}/callback`,
    );
    put(`${prefix}_SKIP_NONCE_CHECK`, provider.skip_nonce_check);
    put(`${prefix}_EMAIL_OPTIONAL`, provider.email_optional);
  }
  put("GOTRUE_EXTERNAL_WEB3_SOLANA_ENABLED", settings.web3?.solana.enabled);
  put("GOTRUE_EXTERNAL_WEB3_ETHEREUM_ENABLED", settings.web3?.ethereum.enabled);
  put("GOTRUE_OAUTH_SERVER_ENABLED", settings.oauthServer?.enabled);
  put("GOTRUE_OAUTH_SERVER_AUTHORIZATION_PATH", settings.oauthServer?.authorization_url_path);
  put(
    "GOTRUE_OAUTH_SERVER_ALLOW_DYNAMIC_REGISTRATION",
    settings.oauthServer?.allow_dynamic_registration,
  );
  return env;
};
