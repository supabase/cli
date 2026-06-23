/**
 * Push-subset sync helpers for the `auth` service.
 *
 * Port of Go `pkg/config/auth.go`: `ToUpdateAuthConfigBody`, `FromRemoteAuthConfig`,
 * `DiffWithRemote`, and the `ToTomlBytes` serialisation of the `auth` struct.
 *
 * The BurntSushi-parity TOML encoder (`encodeToml`) drives serialisation; all
 * duration fields are pre-converted to their Go `.String()` representation and
 * stored as `string` nodes, and all Secret fields are serialised via `secretHash`.
 */

import type { ProjectConfig } from "@supabase/config";

import { diff } from "./config-sync.diff.ts";
import { type TomlField, type TomlValue, encodeToml } from "./config-sync.toml.ts";
import { intToUint } from "../../../../shared/legacy-size-units.ts";
import { durationString, parseDuration, secondsToDurationString } from "./config-sync.duration.ts";
import { secretHash } from "./config-sync.secret.ts";

// ---------------------------------------------------------------------------
// Sub-types
// ---------------------------------------------------------------------------

interface ProviderSubset {
  readonly enabled: boolean;
  readonly client_id: string;
  /** Pre-serialised: "hash:…" or "". */
  readonly secret: string;
  readonly url: string;
  readonly redirect_uri: string;
  readonly skip_nonce_check: boolean;
  readonly email_optional: boolean;
}

interface HookConfigSubset {
  readonly enabled: boolean;
  readonly uri: string;
  /** Pre-serialised: "hash:…" or "". */
  readonly secrets: string;
}

interface EmailTemplateSubset {
  readonly subject: string | undefined;
  readonly content: string | undefined;
  readonly content_path: string;
}

interface NotificationSubset {
  readonly enabled: boolean;
  readonly subject: string | undefined;
  readonly content: string | undefined;
  readonly content_path: string;
}

interface SmtpSubset {
  readonly enabled: boolean;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** Pre-serialised. */
  readonly pass: string;
  readonly admin_email: string;
  readonly sender_name: string;
}

interface SessionsSubset {
  /** Pre-serialised duration string. */
  readonly timebox: string;
  /** Pre-serialised duration string. */
  readonly inactivity_timeout: string;
}

interface TpaFirebaseSubset {
  readonly enabled: boolean;
  readonly project_id: string;
}

interface TpaAuth0Subset {
  readonly enabled: boolean;
  readonly tenant: string;
  readonly tenant_region: string;
}

interface TpaCognitoSubset {
  readonly enabled: boolean;
  readonly user_pool_id: string;
  readonly user_pool_region: string;
}

interface TpaClerkSubset {
  readonly enabled: boolean;
  readonly domain: string;
}

interface TpaWorkOsSubset {
  readonly enabled: boolean;
  readonly issuer_url: string;
}

// ---------------------------------------------------------------------------
// Public AuthSubset
// ---------------------------------------------------------------------------

export interface AuthSubset {
  readonly enabled: boolean;
  readonly site_url: string;
  readonly external_url: string;
  readonly additional_redirect_urls: ReadonlyArray<string>;
  readonly jwt_expiry: number;
  readonly jwt_issuer: string;
  readonly enable_refresh_token_rotation: boolean;
  readonly refresh_token_reuse_interval: number;
  readonly enable_manual_linking: boolean;
  readonly enable_signup: boolean;
  readonly enable_anonymous_sign_ins: boolean;
  readonly minimum_password_length: number;
  /** "", "letters_digits", "lower_upper_letters_digits", "lower_upper_letters_digits_symbols". */
  readonly password_requirements: string;
  readonly signing_keys_path: string;
  /** nil ptr → undefined → omitted in TOML. */
  readonly passkey: { readonly enabled: boolean } | undefined;
  readonly webauthn:
    | {
        readonly rp_display_name: string;
        readonly rp_id: string;
        readonly rp_origins: ReadonlyArray<string>;
      }
    | undefined;
  readonly rate_limit: {
    readonly anonymous_users: number;
    readonly token_refresh: number;
    readonly sign_in_sign_ups: number;
    readonly token_verifications: number;
    readonly email_sent: number;
    readonly sms_sent: number;
    readonly web3: number;
  };
  /** nil ptr → undefined → omitted. */
  readonly captcha:
    | {
        readonly enabled: boolean;
        readonly provider: string;
        /** Pre-serialised. */
        readonly secret: string;
      }
    | undefined;
  readonly hook: {
    readonly mfa_verification_attempt: HookConfigSubset | undefined;
    readonly password_verification_attempt: HookConfigSubset | undefined;
    readonly custom_access_token: HookConfigSubset | undefined;
    readonly send_sms: HookConfigSubset | undefined;
    readonly send_email: HookConfigSubset | undefined;
    readonly before_user_created: HookConfigSubset | undefined;
  };
  readonly mfa: {
    readonly totp: { readonly enroll_enabled: boolean; readonly verify_enabled: boolean };
    readonly phone: {
      readonly enroll_enabled: boolean;
      readonly verify_enabled: boolean;
      readonly otp_length: number;
      readonly template: string;
      /** Pre-serialised. */
      readonly max_frequency: string;
    };
    readonly web_authn: { readonly enroll_enabled: boolean; readonly verify_enabled: boolean };
    readonly max_enrolled_factors: number;
  };
  readonly sessions: SessionsSubset;
  readonly email: {
    readonly enable_signup: boolean;
    readonly double_confirm_changes: boolean;
    readonly enable_confirmations: boolean;
    readonly secure_password_change: boolean;
    /** Pre-serialised. */
    readonly max_frequency: string;
    readonly otp_length: number;
    readonly otp_expiry: number;
    readonly smtp: SmtpSubset | undefined;
    readonly template: Readonly<Record<string, EmailTemplateSubset>> | undefined;
    readonly notification: Readonly<Record<string, NotificationSubset>> | undefined;
  };
  readonly sms: {
    readonly enable_signup: boolean;
    readonly enable_confirmations: boolean;
    readonly template: string;
    /** Pre-serialised. */
    readonly max_frequency: string;
    readonly twilio: {
      readonly enabled: boolean;
      readonly account_sid: string;
      readonly message_service_sid: string;
      /** Pre-serialised. */
      readonly auth_token: string;
    };
    readonly twilio_verify: {
      readonly enabled: boolean;
      readonly account_sid: string;
      readonly message_service_sid: string;
      /** Pre-serialised. */
      readonly auth_token: string;
    };
    readonly messagebird: {
      readonly enabled: boolean;
      readonly originator: string;
      /** Pre-serialised. */
      readonly access_key: string;
    };
    readonly textlocal: {
      readonly enabled: boolean;
      readonly sender: string;
      /** Pre-serialised. */
      readonly api_key: string;
    };
    readonly vonage: {
      readonly enabled: boolean;
      readonly from: string;
      readonly api_key: string;
      /** Pre-serialised. */
      readonly api_secret: string;
    };
    readonly test_otp: Readonly<Record<string, string>>;
  };
  /** map[string]provider — sorted keys in TOML. */
  readonly external: Readonly<Record<string, ProviderSubset>>;
  readonly web3: {
    readonly solana: { readonly enabled: boolean };
    readonly ethereum: { readonly enabled: boolean };
  };
  readonly oauth_server: {
    readonly enabled: boolean;
    readonly allow_dynamic_registration: boolean;
    readonly authorization_url_path: string;
  };
  /** Pre-serialised. */
  readonly publishable_key: string;
  /** Pre-serialised. */
  readonly secret_key: string;
  /** Pre-serialised. */
  readonly jwt_secret: string;
  /** Pre-serialised. */
  readonly anon_key: string;
  /** Pre-serialised. */
  readonly service_role_key: string;
  readonly third_party: {
    readonly firebase: TpaFirebaseSubset;
    readonly auth0: TpaAuth0Subset;
    readonly aws_cognito: TpaCognitoSubset;
    readonly clerk: TpaClerkSubset;
    readonly workos: TpaWorkOsSubset;
  };
  /**
   * Raw (plaintext) secret values for the update body. Go's
   * `ToUpdateAuthConfigBody` sends `Secret.Value` (plaintext), while the diff
   * serialises `Secret.MarshalText` (`hash:<sha256>`). The subset's secret
   * fields hold the hashed form for the diff; this bag holds the plaintext so
   * `authToUpdateBody` can send the value the API actually expects. Not part of
   * `AUTH_FIELDS`, so it never appears in the diff. Gated by the hashed field's
   * presence (mirrors Go's `if len(Secret.SHA256) > 0`).
   */
  readonly rawSecrets: AuthRawSecrets;
}

interface AuthRawSecrets {
  readonly captcha: string;
  readonly hooks: Readonly<Record<string, string>>;
  readonly smtp_pass: string;
  readonly sms: {
    readonly twilio: string;
    readonly twilio_verify: string;
    readonly messagebird: string;
    readonly textlocal: string;
    readonly vonage: string;
  };
  readonly providers: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// RemoteAuthConfig — subset of AuthConfigResponse fields Go reads
// ---------------------------------------------------------------------------

export interface RemoteAuthConfig {
  readonly site_url?: string | null;
  readonly uri_allow_list?: string | null;
  readonly jwt_exp?: number | null;
  readonly refresh_token_rotation_enabled?: boolean | null;
  readonly security_refresh_token_reuse_interval?: number | null;
  readonly security_manual_linking_enabled?: boolean | null;
  readonly disable_signup?: boolean | null;
  readonly external_anonymous_users_enabled?: boolean | null;
  readonly password_min_length?: number | null;
  readonly password_required_characters?: string | null;
  // rate limits
  readonly rate_limit_anonymous_users?: number | null;
  readonly rate_limit_token_refresh?: number | null;
  readonly rate_limit_otp?: number | null;
  readonly rate_limit_verify?: number | null;
  readonly rate_limit_email_sent?: number | null;
  readonly rate_limit_sms_sent?: number | null;
  readonly rate_limit_web3?: number | null;
  // passkey / webauthn
  readonly passkey_enabled?: boolean;
  readonly webauthn_rp_display_name?: string | null;
  readonly webauthn_rp_id?: string | null;
  readonly webauthn_rp_origins?: string | null;
  // captcha
  readonly security_captcha_enabled?: boolean | null;
  readonly security_captcha_provider?: string | null;
  readonly security_captcha_secret?: string | null;
  // hooks
  readonly hook_mfa_verification_attempt_enabled?: boolean | null;
  readonly hook_mfa_verification_attempt_uri?: string | null;
  readonly hook_mfa_verification_attempt_secrets?: string | null;
  readonly hook_password_verification_attempt_enabled?: boolean | null;
  readonly hook_password_verification_attempt_uri?: string | null;
  readonly hook_password_verification_attempt_secrets?: string | null;
  readonly hook_custom_access_token_enabled?: boolean | null;
  readonly hook_custom_access_token_uri?: string | null;
  readonly hook_custom_access_token_secrets?: string | null;
  readonly hook_send_sms_enabled?: boolean | null;
  readonly hook_send_sms_uri?: string | null;
  readonly hook_send_sms_secrets?: string | null;
  readonly hook_send_email_enabled?: boolean | null;
  readonly hook_send_email_uri?: string | null;
  readonly hook_send_email_secrets?: string | null;
  readonly hook_before_user_created_enabled?: boolean | null;
  readonly hook_before_user_created_uri?: string | null;
  readonly hook_before_user_created_secrets?: string | null;
  // mfa
  readonly mfa_max_enrolled_factors?: number | null;
  readonly mfa_totp_enroll_enabled?: boolean | null;
  readonly mfa_totp_verify_enabled?: boolean | null;
  readonly mfa_phone_enroll_enabled?: boolean | null;
  readonly mfa_phone_verify_enabled?: boolean | null;
  readonly mfa_phone_otp_length?: number;
  readonly mfa_phone_template?: string | null;
  readonly mfa_phone_max_frequency?: number | null;
  readonly mfa_web_authn_enroll_enabled?: boolean | null;
  readonly mfa_web_authn_verify_enabled?: boolean | null;
  // sessions (hours as float)
  readonly sessions_timebox?: number | null;
  readonly sessions_inactivity_timeout?: number | null;
  // email
  readonly external_email_enabled?: boolean | null;
  readonly mailer_secure_email_change_enabled?: boolean | null;
  readonly mailer_autoconfirm?: boolean | null;
  readonly mailer_otp_length?: number | null;
  readonly mailer_otp_exp?: number;
  readonly security_update_password_require_reauthentication?: boolean | null;
  readonly smtp_max_frequency?: number | null;
  readonly smtp_host?: string | null;
  readonly smtp_port?: string | null;
  readonly smtp_user?: string | null;
  readonly smtp_pass?: string | null;
  readonly smtp_admin_email?: string | null;
  readonly smtp_sender_name?: string | null;
  // email templates
  readonly mailer_subjects_invite?: string | null;
  readonly mailer_templates_invite_content?: string | null;
  readonly mailer_subjects_confirmation?: string | null;
  readonly mailer_templates_confirmation_content?: string | null;
  readonly mailer_subjects_recovery?: string | null;
  readonly mailer_templates_recovery_content?: string | null;
  readonly mailer_subjects_magic_link?: string | null;
  readonly mailer_templates_magic_link_content?: string | null;
  readonly mailer_subjects_email_change?: string | null;
  readonly mailer_templates_email_change_content?: string | null;
  readonly mailer_subjects_reauthentication?: string | null;
  readonly mailer_templates_reauthentication_content?: string | null;
  // notifications
  readonly mailer_notifications_password_changed_enabled?: boolean | null;
  readonly mailer_subjects_password_changed_notification?: string | null;
  readonly mailer_templates_password_changed_notification_content?: string | null;
  readonly mailer_notifications_email_changed_enabled?: boolean | null;
  readonly mailer_subjects_email_changed_notification?: string | null;
  readonly mailer_templates_email_changed_notification_content?: string | null;
  readonly mailer_notifications_phone_changed_enabled?: boolean | null;
  readonly mailer_subjects_phone_changed_notification?: string | null;
  readonly mailer_templates_phone_changed_notification_content?: string | null;
  readonly mailer_notifications_identity_linked_enabled?: boolean | null;
  readonly mailer_subjects_identity_linked_notification?: string | null;
  readonly mailer_templates_identity_linked_notification_content?: string | null;
  readonly mailer_notifications_identity_unlinked_enabled?: boolean | null;
  readonly mailer_subjects_identity_unlinked_notification?: string | null;
  readonly mailer_templates_identity_unlinked_notification_content?: string | null;
  readonly mailer_notifications_mfa_factor_enrolled_enabled?: boolean | null;
  readonly mailer_subjects_mfa_factor_enrolled_notification?: string | null;
  readonly mailer_templates_mfa_factor_enrolled_notification_content?: string | null;
  readonly mailer_notifications_mfa_factor_unenrolled_enabled?: boolean | null;
  readonly mailer_subjects_mfa_factor_unenrolled_notification?: string | null;
  readonly mailer_templates_mfa_factor_unenrolled_notification_content?: string | null;
  // sms
  readonly external_phone_enabled?: boolean | null;
  readonly sms_max_frequency?: number | null;
  readonly sms_autoconfirm?: boolean | null;
  readonly sms_template?: string | null;
  readonly sms_test_otp?: string | null;
  readonly sms_provider?: string | null;
  readonly sms_twilio_auth_token?: string | null;
  readonly sms_twilio_account_sid?: string | null;
  readonly sms_twilio_message_service_sid?: string | null;
  readonly sms_twilio_verify_auth_token?: string | null;
  readonly sms_twilio_verify_account_sid?: string | null;
  readonly sms_twilio_verify_message_service_sid?: string | null;
  readonly sms_messagebird_access_key?: string | null;
  readonly sms_messagebird_originator?: string | null;
  readonly sms_textlocal_api_key?: string | null;
  readonly sms_textlocal_sender?: string | null;
  readonly sms_vonage_api_secret?: string | null;
  readonly sms_vonage_api_key?: string | null;
  readonly sms_vonage_from?: string | null;
  // external providers
  readonly external_apple_enabled?: boolean | null;
  readonly external_apple_client_id?: string | null;
  readonly external_apple_additional_client_ids?: string | null;
  readonly external_apple_secret?: string | null;
  readonly external_apple_email_optional?: boolean | null;
  readonly external_azure_enabled?: boolean | null;
  readonly external_azure_client_id?: string | null;
  readonly external_azure_secret?: string | null;
  readonly external_azure_url?: string | null;
  readonly external_azure_email_optional?: boolean | null;
  readonly external_bitbucket_enabled?: boolean | null;
  readonly external_bitbucket_client_id?: string | null;
  readonly external_bitbucket_secret?: string | null;
  readonly external_bitbucket_email_optional?: boolean | null;
  readonly external_discord_enabled?: boolean | null;
  readonly external_discord_client_id?: string | null;
  readonly external_discord_secret?: string | null;
  readonly external_discord_email_optional?: boolean | null;
  readonly external_facebook_enabled?: boolean | null;
  readonly external_facebook_client_id?: string | null;
  readonly external_facebook_secret?: string | null;
  readonly external_facebook_email_optional?: boolean | null;
  readonly external_figma_enabled?: boolean | null;
  readonly external_figma_client_id?: string | null;
  readonly external_figma_secret?: string | null;
  readonly external_figma_email_optional?: boolean | null;
  readonly external_github_enabled?: boolean | null;
  readonly external_github_client_id?: string | null;
  readonly external_github_secret?: string | null;
  readonly external_github_email_optional?: boolean | null;
  readonly external_gitlab_enabled?: boolean | null;
  readonly external_gitlab_client_id?: string | null;
  readonly external_gitlab_secret?: string | null;
  readonly external_gitlab_url?: string | null;
  readonly external_gitlab_email_optional?: boolean | null;
  readonly external_google_enabled?: boolean | null;
  readonly external_google_client_id?: string | null;
  readonly external_google_additional_client_ids?: string | null;
  readonly external_google_secret?: string | null;
  readonly external_google_skip_nonce_check?: boolean | null;
  readonly external_google_email_optional?: boolean | null;
  readonly external_kakao_enabled?: boolean | null;
  readonly external_kakao_client_id?: string | null;
  readonly external_kakao_secret?: string | null;
  readonly external_kakao_email_optional?: boolean | null;
  readonly external_keycloak_enabled?: boolean | null;
  readonly external_keycloak_client_id?: string | null;
  readonly external_keycloak_secret?: string | null;
  readonly external_keycloak_url?: string | null;
  readonly external_keycloak_email_optional?: boolean | null;
  readonly external_linkedin_oidc_enabled?: boolean | null;
  readonly external_linkedin_oidc_client_id?: string | null;
  readonly external_linkedin_oidc_secret?: string | null;
  readonly external_linkedin_oidc_email_optional?: boolean | null;
  readonly external_notion_enabled?: boolean | null;
  readonly external_notion_client_id?: string | null;
  readonly external_notion_secret?: string | null;
  readonly external_notion_email_optional?: boolean | null;
  readonly external_slack_oidc_enabled?: boolean | null;
  readonly external_slack_oidc_client_id?: string | null;
  readonly external_slack_oidc_secret?: string | null;
  readonly external_slack_oidc_email_optional?: boolean | null;
  readonly external_spotify_enabled?: boolean | null;
  readonly external_spotify_client_id?: string | null;
  readonly external_spotify_secret?: string | null;
  readonly external_spotify_email_optional?: boolean | null;
  readonly external_twitch_enabled?: boolean | null;
  readonly external_twitch_client_id?: string | null;
  readonly external_twitch_secret?: string | null;
  readonly external_twitch_email_optional?: boolean | null;
  readonly external_twitter_enabled?: boolean | null;
  readonly external_twitter_client_id?: string | null;
  readonly external_twitter_secret?: string | null;
  readonly external_twitter_email_optional?: boolean | null;
  readonly external_x_enabled?: boolean | null;
  readonly external_x_client_id?: string | null;
  readonly external_x_secret?: string | null;
  readonly external_x_email_optional?: boolean | null;
  readonly external_workos_enabled?: boolean | null;
  readonly external_workos_client_id?: string | null;
  readonly external_workos_secret?: string | null;
  readonly external_workos_url?: string | null;
  readonly external_zoom_enabled?: boolean | null;
  readonly external_zoom_client_id?: string | null;
  readonly external_zoom_secret?: string | null;
  readonly external_zoom_email_optional?: boolean | null;
  // web3
  readonly external_web3_solana_enabled?: boolean | null;
  readonly external_web3_ethereum_enabled?: boolean | null;
}

/** Body type for the V1 update auth config API call. */
export type RemoteAuthUpdateBody = Record<string, unknown>;

// ---------------------------------------------------------------------------
// TOML field descriptors — mirrors Go struct declaration order (lines 147-188)
// ---------------------------------------------------------------------------

const HOOK_CONFIG_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "uri", node: { kind: "string" } },
  { key: "secrets", node: { kind: "string" } },
];

const HOOK_FIELDS: ReadonlyArray<TomlField> = [
  {
    key: "mfa_verification_attempt",
    node: { kind: "struct", fields: HOOK_CONFIG_FIELDS },
  },
  {
    key: "password_verification_attempt",
    node: { kind: "struct", fields: HOOK_CONFIG_FIELDS },
  },
  {
    key: "custom_access_token",
    node: { kind: "struct", fields: HOOK_CONFIG_FIELDS },
  },
  {
    key: "send_sms",
    node: { kind: "struct", fields: HOOK_CONFIG_FIELDS },
  },
  {
    key: "send_email",
    node: { kind: "struct", fields: HOOK_CONFIG_FIELDS },
  },
  {
    key: "before_user_created",
    node: { kind: "struct", fields: HOOK_CONFIG_FIELDS },
  },
];

const MFA_FIELDS: ReadonlyArray<TomlField> = [
  { key: "max_enrolled_factors", node: { kind: "int" } },
  {
    key: "totp",
    node: {
      kind: "struct",
      fields: [
        { key: "enroll_enabled", node: { kind: "bool" } },
        { key: "verify_enabled", node: { kind: "bool" } },
      ],
    },
  },
  {
    key: "phone",
    node: {
      kind: "struct",
      fields: [
        { key: "enroll_enabled", node: { kind: "bool" } },
        { key: "verify_enabled", node: { kind: "bool" } },
        { key: "otp_length", node: { kind: "int" } },
        { key: "template", node: { kind: "string" } },
        { key: "max_frequency", node: { kind: "string" } },
      ],
    },
  },
  {
    key: "web_authn",
    node: {
      kind: "struct",
      fields: [
        { key: "enroll_enabled", node: { kind: "bool" } },
        { key: "verify_enabled", node: { kind: "bool" } },
      ],
    },
  },
];

const SESSIONS_FIELDS: ReadonlyArray<TomlField> = [
  { key: "timebox", node: { kind: "string" } },
  { key: "inactivity_timeout", node: { kind: "string" } },
];

const EMAIL_TEMPLATE_FIELDS: ReadonlyArray<TomlField> = [
  { key: "subject", node: { kind: "string" } },
  { key: "content", node: { kind: "string" } },
  { key: "content_path", node: { kind: "string" } },
];

const NOTIFICATION_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "subject", node: { kind: "string" } },
  { key: "content", node: { kind: "string" } },
  { key: "content_path", node: { kind: "string" } },
];

const SMTP_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "host", node: { kind: "string" } },
  { key: "port", node: { kind: "int" } },
  { key: "user", node: { kind: "string" } },
  { key: "pass", node: { kind: "string" } },
  { key: "admin_email", node: { kind: "string" } },
  { key: "sender_name", node: { kind: "string" } },
];

const EMAIL_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enable_signup", node: { kind: "bool" } },
  { key: "double_confirm_changes", node: { kind: "bool" } },
  { key: "enable_confirmations", node: { kind: "bool" } },
  { key: "secure_password_change", node: { kind: "bool" } },
  { key: "max_frequency", node: { kind: "string" } },
  { key: "otp_length", node: { kind: "int" } },
  { key: "otp_expiry", node: { kind: "int" } },
  {
    key: "template",
    node: { kind: "map", value: { kind: "struct", fields: EMAIL_TEMPLATE_FIELDS } },
  },
  {
    key: "notification",
    node: { kind: "map", value: { kind: "struct", fields: NOTIFICATION_FIELDS } },
  },
  { key: "smtp", node: { kind: "struct", fields: SMTP_FIELDS } },
];

const SMS_PROVIDER_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "account_sid", node: { kind: "string" } },
  { key: "message_service_sid", node: { kind: "string" } },
  { key: "auth_token", node: { kind: "string" } },
];

const SMS_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enable_signup", node: { kind: "bool" } },
  { key: "enable_confirmations", node: { kind: "bool" } },
  { key: "template", node: { kind: "string" } },
  { key: "max_frequency", node: { kind: "string" } },
  { key: "twilio", node: { kind: "struct", fields: SMS_PROVIDER_FIELDS } },
  { key: "twilio_verify", node: { kind: "struct", fields: SMS_PROVIDER_FIELDS } },
  {
    key: "messagebird",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "originator", node: { kind: "string" } },
        { key: "access_key", node: { kind: "string" } },
      ],
    },
  },
  {
    key: "textlocal",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "sender", node: { kind: "string" } },
        { key: "api_key", node: { kind: "string" } },
      ],
    },
  },
  {
    key: "vonage",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "from", node: { kind: "string" } },
        { key: "api_key", node: { kind: "string" } },
        { key: "api_secret", node: { kind: "string" } },
      ],
    },
  },
  {
    key: "test_otp",
    node: { kind: "map", value: { kind: "string" } },
  },
];

const PROVIDER_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "client_id", node: { kind: "string" } },
  { key: "secret", node: { kind: "string" } },
  { key: "url", node: { kind: "string" } },
  { key: "redirect_uri", node: { kind: "string" } },
  { key: "skip_nonce_check", node: { kind: "bool" } },
  { key: "email_optional", node: { kind: "bool" } },
];

const RATE_LIMIT_FIELDS: ReadonlyArray<TomlField> = [
  { key: "anonymous_users", node: { kind: "int" } },
  { key: "token_refresh", node: { kind: "int" } },
  { key: "sign_in_sign_ups", node: { kind: "int" } },
  { key: "token_verifications", node: { kind: "int" } },
  { key: "email_sent", node: { kind: "int" } },
  { key: "sms_sent", node: { kind: "int" } },
  { key: "web3", node: { kind: "int" } },
];

const CAPTCHA_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "provider", node: { kind: "string" } },
  { key: "secret", node: { kind: "string" } },
];

const PASSKEY_FIELDS: ReadonlyArray<TomlField> = [{ key: "enabled", node: { kind: "bool" } }];

const WEBAUTHN_FIELDS: ReadonlyArray<TomlField> = [
  { key: "rp_display_name", node: { kind: "string" } },
  { key: "rp_id", node: { kind: "string" } },
  { key: "rp_origins", node: { kind: "array", elem: { kind: "string" } } },
];

const WEB3_FIELDS: ReadonlyArray<TomlField> = [
  {
    key: "solana",
    node: { kind: "struct", fields: [{ key: "enabled", node: { kind: "bool" } }] },
  },
  {
    key: "ethereum",
    node: { kind: "struct", fields: [{ key: "enabled", node: { kind: "bool" } }] },
  },
];

const OAUTH_SERVER_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "allow_dynamic_registration", node: { kind: "bool" } },
  { key: "authorization_url_path", node: { kind: "string" } },
];

const THIRD_PARTY_FIELDS: ReadonlyArray<TomlField> = [
  {
    key: "firebase",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "project_id", node: { kind: "string" } },
      ],
    },
  },
  {
    key: "auth0",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "tenant", node: { kind: "string" } },
        { key: "tenant_region", node: { kind: "string" } },
      ],
    },
  },
  {
    key: "aws_cognito",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "user_pool_id", node: { kind: "string" } },
        { key: "user_pool_region", node: { kind: "string" } },
      ],
    },
  },
  {
    key: "clerk",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "domain", node: { kind: "string" } },
      ],
    },
  },
  {
    key: "workos",
    node: {
      kind: "struct",
      fields: [
        { key: "enabled", node: { kind: "bool" } },
        { key: "issuer_url", node: { kind: "string" } },
      ],
    },
  },
];

/**
 * Top-level auth struct field descriptor. Mirrors Go declaration order
 * (auth.go lines 147–188), excluding `toml:"-"` fields (Image, SigningKeys).
 */
const AUTH_FIELDS: ReadonlyArray<TomlField> = [
  { key: "enabled", node: { kind: "bool" } },
  { key: "site_url", node: { kind: "string" } },
  { key: "external_url", node: { kind: "string" } },
  { key: "additional_redirect_urls", node: { kind: "array", elem: { kind: "string" } } },
  { key: "jwt_expiry", node: { kind: "int" } },
  { key: "jwt_issuer", node: { kind: "string" } },
  { key: "enable_refresh_token_rotation", node: { kind: "bool" } },
  { key: "refresh_token_reuse_interval", node: { kind: "int" } },
  { key: "enable_manual_linking", node: { kind: "bool" } },
  { key: "enable_signup", node: { kind: "bool" } },
  { key: "enable_anonymous_sign_ins", node: { kind: "bool" } },
  { key: "minimum_password_length", node: { kind: "int" } },
  { key: "password_requirements", node: { kind: "string" } },
  { key: "signing_keys_path", node: { kind: "string" } },
  // passkey / webauthn are pointer fields → undefined → omitted
  {
    key: "passkey",
    node: { kind: "struct", fields: PASSKEY_FIELDS },
  },
  {
    key: "webauthn",
    node: { kind: "struct", fields: WEBAUTHN_FIELDS },
  },
  { key: "rate_limit", node: { kind: "struct", fields: RATE_LIMIT_FIELDS } },
  { key: "captcha", node: { kind: "struct", fields: CAPTCHA_FIELDS } },
  { key: "hook", node: { kind: "struct", fields: HOOK_FIELDS } },
  { key: "mfa", node: { kind: "struct", fields: MFA_FIELDS } },
  { key: "sessions", node: { kind: "struct", fields: SESSIONS_FIELDS } },
  { key: "email", node: { kind: "struct", fields: EMAIL_FIELDS } },
  { key: "sms", node: { kind: "struct", fields: SMS_FIELDS } },
  {
    key: "external",
    node: { kind: "map", value: { kind: "struct", fields: PROVIDER_FIELDS } },
  },
  { key: "web3", node: { kind: "struct", fields: WEB3_FIELDS } },
  { key: "oauth_server", node: { kind: "struct", fields: OAUTH_SERVER_FIELDS } },
  { key: "publishable_key", node: { kind: "string" } },
  { key: "secret_key", node: { kind: "string" } },
  { key: "jwt_secret", node: { kind: "string" } },
  { key: "anon_key", node: { kind: "string" } },
  { key: "service_role_key", node: { kind: "string" } },
  { key: "third_party", node: { kind: "struct", fields: THIRD_PARTY_FIELDS } },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Go `strToArr`: empty string → `[]`, else comma-split. */
function strToArr(v: string): Array<string> {
  return v.length === 0 ? [] : v.split(",");
}

/** Go `cast.IntToUint`: clamp negatives to 0. */
function valOrDefault<T>(v: T | null | undefined, def: T): T {
  return v == null ? def : v;
}

/** Convert a local duration string (e.g. "5s") to nanoseconds then back via durationString. */
function normalizeDurationStr(s: string | undefined): string {
  if (!s) return durationString(0);
  try {
    return durationString(parseDuration(s));
  } catch {
    return durationString(0);
  }
}

function projectSecret(projectId: string, value: string | undefined): string {
  if (!value) return "";
  return secretHash(projectId, value);
}

/**
 * Mirrors Go `Secret.MarshalText` for values received from the remote API.
 * The remote returns raw SHA256 hex strings; we need to prefix with "hash:".
 * Empty or null → "".
 */
function fromRemoteSecret(sha256: string | null | undefined): string {
  const v = sha256 ?? "";
  return v.length === 0 ? "" : "hash:" + v;
}

// ---------------------------------------------------------------------------
// authSubsetFromConfig — projects local config into AuthSubset
// ---------------------------------------------------------------------------

/**
 * Raw-config presence of the optional `[auth]` sub-sections that Go models as
 * `*pointer`/map fields (nil when absent in `config.toml`). `@supabase/config`
 * decodes them as present-with-defaults, so their true presence can't be
 * recovered from the decoded config; we read it from the raw TOML instead
 * (see `push.raw-presence.ts`) to reproduce Go's "skip when nil" semantics in
 * `ToUpdateAuthConfigBody` (`apps/cli-go/pkg/config/auth.go`).
 *
 * `externalProviders` is the set of `[auth.external.<name>]` blocks declared in
 * the raw config; Go additionally always carries the `apple` default from its
 * embedded template, which {@link authSubsetFromConfig} folds in.
 */
export interface AuthPresence {
  readonly captcha: boolean;
  readonly smtp: boolean;
  readonly hooks: {
    readonly mfa_verification_attempt: boolean;
    readonly password_verification_attempt: boolean;
    readonly custom_access_token: boolean;
    readonly send_sms: boolean;
    readonly send_email: boolean;
    readonly before_user_created: boolean;
  };
  readonly externalProviders: ReadonlyArray<string>;
}

/**
 * Port of the local half of `(*auth).DiffWithRemote`.
 * Projects `config.auth` into the push subset, pre-computing all duration and
 * secret fields.  `projectId` is the HMAC key for secret hashing. `presence`
 * carries raw-config presence for the optional sub-sections Go skips when nil.
 */
export function authSubsetFromConfig(
  config: ProjectConfig,
  projectId: string,
  presence: AuthPresence,
): AuthSubset {
  const a = config.auth;

  // Derived auth URLs — Go computes these during config load (config.go:629-647):
  //   api.external_url  ← `http://<hostname>:<api.port>` when unset
  //   auth.external_url ← trimRight(api.external_url, "/") + "/auth/v1" when unset
  //   auth.jwt_issuer   ← auth.external_url when unset
  // `@supabase/config` performs no such derivation and has no `auth.external_url`
  // or `hostname` field, so we reproduce it here. Hostname falls back to Go's
  // "127.0.0.1" default (no schema field to override it).
  const apiExternalUrl =
    config.api.external_url !== undefined && config.api.external_url.length > 0
      ? config.api.external_url
      : `${config.api.tls.enabled ? "https" : "http"}://127.0.0.1:${config.api.port}`;
  const authExternalUrl = `${apiExternalUrl.replace(/\/+$/, "")}/auth/v1`;
  const jwtIssuer =
    a.jwt_issuer !== undefined && a.jwt_issuer.length > 0 ? a.jwt_issuer : authExternalUrl;

  // Passkey / Webauthn — not in @supabase/config schema → always undefined
  const passkey: AuthSubset["passkey"] = undefined;
  const webauthn: AuthSubset["webauthn"] = undefined;

  // Rate limit
  const rl = a.rate_limit;

  // Captcha — Go gates on `a.Captcha != nil`; absent in raw config → skip.
  const captchaConfig = a.captcha;
  const captcha: AuthSubset["captcha"] =
    !presence.captcha || captchaConfig === undefined
      ? undefined
      : {
          enabled: captchaConfig.enabled ?? false,
          provider: captchaConfig.provider ?? "",
          secret: projectSecret(projectId, captchaConfig.secret ?? ""),
        };

  // Hooks — Go gates each on `hook.<name> != nil`; absent in raw config → skip.
  const h = a.hook;
  function projectHook(
    hc: { enabled: boolean; uri?: string; secrets?: string } | undefined,
    present: boolean,
  ): HookConfigSubset | undefined {
    if (!present || hc === undefined) return undefined;
    return {
      enabled: hc.enabled,
      uri: hc.uri ?? "",
      secrets: projectSecret(projectId, hc.secrets ?? ""),
    };
  }
  const hook: AuthSubset["hook"] = {
    mfa_verification_attempt: projectHook(
      h.mfa_verification_attempt,
      presence.hooks.mfa_verification_attempt,
    ),
    password_verification_attempt: projectHook(
      h.password_verification_attempt,
      presence.hooks.password_verification_attempt,
    ),
    custom_access_token: projectHook(h.custom_access_token, presence.hooks.custom_access_token),
    send_sms: projectHook(h.send_sms, presence.hooks.send_sms),
    send_email: projectHook(h.send_email, presence.hooks.send_email),
    before_user_created: projectHook(h.before_user_created, presence.hooks.before_user_created),
  };

  // MFA
  const m = a.mfa;
  const mfa: AuthSubset["mfa"] = {
    totp: {
      enroll_enabled: m.totp.enroll_enabled,
      verify_enabled: m.totp.verify_enabled,
    },
    phone: {
      enroll_enabled: m.phone.enroll_enabled,
      verify_enabled: m.phone.verify_enabled,
      otp_length: m.phone.otp_length,
      template: m.phone.template,
      max_frequency: normalizeDurationStr(m.phone.max_frequency),
    },
    web_authn: {
      enroll_enabled: m.web_authn.enroll_enabled,
      verify_enabled: m.web_authn.verify_enabled,
    },
    max_enrolled_factors: m.max_enrolled_factors,
  };

  // Sessions — optionalKey in TS, always value struct in Go
  const sessConfig = a.sessions;
  const sessions: SessionsSubset = {
    timebox: normalizeDurationStr(sessConfig?.timebox),
    inactivity_timeout: normalizeDurationStr(sessConfig?.inactivity_timeout),
  };

  // Email templates: TS config has `subject` (string) and `content_path` (string)
  // There is no `content` field in the TS config; content is set only via fromAuthConfig.
  const emailTmplMap = a.email.template;
  const templateEntries: Record<string, EmailTemplateSubset> = {};
  for (const [k, t] of Object.entries(emailTmplMap)) {
    templateEntries[k] = {
      subject: t.subject !== undefined ? t.subject : undefined,
      content: undefined, // TS config has no content field
      content_path: t.content_path ?? "",
    };
  }
  // Nil map (no templates configured) → undefined, mirrors Go nil map behaviour.
  const template = Object.keys(templateEntries).length > 0 ? templateEntries : undefined;

  // Email notifications
  const emailNotifMap = a.email.notification;
  const notificationEntries: Record<string, NotificationSubset> = {};
  for (const [k, n] of Object.entries(emailNotifMap)) {
    notificationEntries[k] = {
      enabled: n.enabled,
      subject: n.subject !== undefined ? n.subject : undefined,
      content: undefined, // TS config has no content field
      content_path: n.content_path ?? "",
    };
  }
  // Nil map (no notifications configured) → undefined.
  const notification =
    Object.keys(notificationEntries).length > 0 ? notificationEntries : undefined;

  // SMTP — Go gates on `a.Email.Smtp != nil`; absent in raw config → skip.
  const smtpConfig = a.email.smtp;
  const smtp: SmtpSubset | undefined =
    !presence.smtp || smtpConfig === undefined
      ? undefined
      : {
          enabled: smtpConfig.enabled,
          host: smtpConfig.host ?? "",
          port: smtpConfig.port ?? 0,
          user: smtpConfig.user ?? "",
          pass: projectSecret(projectId, smtpConfig.pass ?? ""),
          admin_email: smtpConfig.admin_email ?? "",
          sender_name: smtpConfig.sender_name ?? "",
        };

  // SMS
  const s = a.sms;
  function projectTwilio(tc: {
    enabled: boolean;
    account_sid?: string;
    message_service_sid?: string;
    auth_token?: string;
  }): AuthSubset["sms"]["twilio"] {
    return {
      enabled: tc.enabled,
      account_sid: tc.account_sid ?? "",
      message_service_sid: tc.message_service_sid ?? "",
      auth_token: projectSecret(projectId, tc.auth_token ?? ""),
    };
  }
  const sms: AuthSubset["sms"] = {
    enable_signup: s.enable_signup,
    enable_confirmations: s.enable_confirmations,
    template: s.template,
    max_frequency: normalizeDurationStr(s.max_frequency),
    twilio: projectTwilio(s.twilio),
    twilio_verify: projectTwilio(s.twilio_verify),
    messagebird: {
      enabled: s.messagebird.enabled,
      originator: s.messagebird.originator ?? "",
      access_key: projectSecret(projectId, s.messagebird.access_key ?? ""),
    },
    textlocal: {
      enabled: s.textlocal.enabled,
      sender: s.textlocal.sender ?? "",
      api_key: projectSecret(projectId, s.textlocal.api_key ?? ""),
    },
    vonage: {
      enabled: s.vonage.enabled,
      from: s.vonage.from ?? "",
      api_key: s.vonage.api_key ?? "",
      api_secret: projectSecret(projectId, s.vonage.api_secret ?? ""),
    },
    test_otp: s.test_otp ?? {},
  };

  // External providers — Go emits only providers present in its `external` map
  // (`if p, ok := e[name]; ok`). That map is the `apple` default from Go's
  // embedded template plus any `[auth.external.<name>]` blocks in config.toml.
  // @supabase/config defaults *all* providers present, so restrict to Go's set.
  const ext = a.external;
  const providerNames = new Set<string>(["apple", ...presence.externalProviders]);
  const external: Record<string, ProviderSubset> = {};
  for (const [k, p] of Object.entries(ext ?? {})) {
    if (!providerNames.has(k)) continue;
    external[k] = {
      enabled: p.enabled,
      client_id: p.client_id ?? "",
      secret: projectSecret(projectId, p.secret ?? ""),
      url: p.url ?? "",
      redirect_uri: p.redirect_uri ?? "",
      skip_nonce_check: p.skip_nonce_check ?? false,
      email_optional: p.email_optional ?? false,
    };
  }

  // Third-party
  const tp = a.third_party;
  const third_party: AuthSubset["third_party"] = {
    firebase: {
      enabled: tp.firebase.enabled,
      project_id: tp.firebase.project_id ?? "",
    },
    auth0: {
      enabled: tp.auth0.enabled,
      tenant: tp.auth0.tenant ?? "",
      tenant_region: tp.auth0.tenant_region ?? "",
    },
    aws_cognito: {
      enabled: tp.aws_cognito.enabled,
      user_pool_id: tp.aws_cognito.user_pool_id ?? "",
      user_pool_region: tp.aws_cognito.user_pool_region ?? "",
    },
    clerk: {
      enabled: tp.clerk.enabled,
      domain: tp.clerk.domain ?? "",
    },
    workos: {
      enabled: tp.workos.enabled,
      issuer_url: tp.workos.issuer_url ?? "",
    },
  };

  return {
    enabled: a.enabled,
    site_url: a.site_url,
    external_url: authExternalUrl,
    additional_redirect_urls: a.additional_redirect_urls ?? [],
    jwt_expiry: a.jwt_expiry,
    jwt_issuer: jwtIssuer,
    enable_refresh_token_rotation: a.enable_refresh_token_rotation,
    refresh_token_reuse_interval: a.refresh_token_reuse_interval,
    enable_manual_linking: a.enable_manual_linking,
    enable_signup: a.enable_signup,
    enable_anonymous_sign_ins: a.enable_anonymous_sign_ins,
    minimum_password_length: a.minimum_password_length,
    password_requirements: a.password_requirements ?? "",
    signing_keys_path: a.signing_keys_path ?? "",
    passkey,
    webauthn,
    rate_limit: {
      anonymous_users: rl.anonymous_users,
      token_refresh: rl.token_refresh,
      sign_in_sign_ups: rl.sign_in_sign_ups,
      token_verifications: rl.token_verifications,
      email_sent: rl.email_sent,
      sms_sent: rl.sms_sent,
      web3: rl.web3,
    },
    captcha,
    hook,
    mfa,
    sessions,
    email: {
      enable_signup: a.email.enable_signup,
      double_confirm_changes: a.email.double_confirm_changes,
      enable_confirmations: a.email.enable_confirmations,
      secure_password_change: a.email.secure_password_change,
      max_frequency: normalizeDurationStr(a.email.max_frequency),
      otp_length: a.email.otp_length,
      otp_expiry: a.email.otp_expiry,
      smtp,
      template,
      notification,
    },
    sms,
    external,
    web3: {
      solana: { enabled: a.web3.solana.enabled },
      ethereum: { enabled: a.web3.ethereum.enabled },
    },
    oauth_server: {
      enabled: a.oauth_server.enabled,
      allow_dynamic_registration: a.oauth_server.allow_dynamic_registration,
      authorization_url_path: a.oauth_server.authorization_url_path,
    },
    publishable_key: projectSecret(projectId, a.publishable_key ?? ""),
    secret_key: projectSecret(projectId, a.secret_key ?? ""),
    jwt_secret: projectSecret(projectId, a.jwt_secret ?? ""),
    anon_key: projectSecret(projectId, a.anon_key ?? ""),
    service_role_key: projectSecret(projectId, a.service_role_key ?? ""),
    third_party,
    // Raw plaintext secrets for the update body (see AuthRawSecrets). Sourced
    // from the same config accessors used for hashing above.
    rawSecrets: {
      captcha: captchaConfig?.secret ?? "",
      hooks: {
        mfa_verification_attempt: h.mfa_verification_attempt?.secrets ?? "",
        password_verification_attempt: h.password_verification_attempt?.secrets ?? "",
        custom_access_token: h.custom_access_token?.secrets ?? "",
        send_sms: h.send_sms?.secrets ?? "",
        send_email: h.send_email?.secrets ?? "",
        before_user_created: h.before_user_created?.secrets ?? "",
      },
      smtp_pass: smtpConfig?.pass ?? "",
      sms: {
        twilio: s.twilio.auth_token ?? "",
        twilio_verify: s.twilio_verify.auth_token ?? "",
        messagebird: s.messagebird.access_key ?? "",
        textlocal: s.textlocal.api_key ?? "",
        vonage: s.vonage.api_secret ?? "",
      },
      providers: Object.fromEntries(Object.entries(ext ?? {}).map(([k, p]) => [k, p.secret ?? ""])),
    },
  };
}

/** Returns `config.auth.enabled`. */
export function authEnabled(config: ProjectConfig): boolean {
  return config.auth.enabled;
}

// ---------------------------------------------------------------------------
// applyRemoteAuthConfig — port of Go `(*auth).FromRemoteAuthConfig`
// ---------------------------------------------------------------------------

/**
 * Maps the local config `password_requirements` enum to the API
 * `password_required_characters` value (Go `PasswordRequirements.ToChar`).
 *
 * The values MUST match the `@supabase/api` `V1{Get,Update}AuthServiceConfig`
 * `password_required_characters` literals (`packages/api/src/generated/contracts.ts`).
 * They are the real API values (Go API enum), NOT the oapi-codegen constant *names* —
 * the `:` separators between character-class groups are significant, and the generated
 * client rejects any value that is not one of these literals.
 */
const PASSWORD_REQUIREMENTS_TO_CHAR: Record<string, string> = {
  letters_digits: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits: "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
  lower_upper_letters_digits_symbols:
    "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
};

/** Inverse of {@link PASSWORD_REQUIREMENTS_TO_CHAR} (Go `NewPasswordRequirement`). */
const CHAR_TO_PASSWORD_REQUIREMENTS: Record<string, string> = Object.fromEntries(
  Object.entries(PASSWORD_REQUIREMENTS_TO_CHAR).map(([requirement, char]) => [char, requirement]),
);

/**
 * Returns a copy of `local` with remote-derived fields applied.
 * Mirrors Go `(*auth).FromRemoteAuthConfig`.
 */
export function applyRemoteAuthConfig(local: AuthSubset, remote: RemoteAuthConfig): AuthSubset {
  // password_required_characters → password_requirements (inverse of Go ToChar)
  function remoteToPasswordRequirements(prc: string): string {
    return CHAR_TO_PASSWORD_REQUIREMENTS[prc] ?? "";
  }

  // Base scalar fields
  const siteUrl = valOrDefault(remote.site_url, "");
  const additionalRedirectUrls = strToArr(valOrDefault(remote.uri_allow_list, ""));
  const jwtExpiry = intToUint(valOrDefault(remote.jwt_exp, 0));
  const enableRefreshTokenRotation = valOrDefault(remote.refresh_token_rotation_enabled, false);
  const refreshTokenReuseInterval = intToUint(
    valOrDefault(remote.security_refresh_token_reuse_interval, 0),
  );
  const enableManualLinking = valOrDefault(remote.security_manual_linking_enabled, false);
  const enableSignup = !valOrDefault(remote.disable_signup, false);
  const enableAnonymousSignIns = valOrDefault(remote.external_anonymous_users_enabled, false);
  const minimumPasswordLength = intToUint(valOrDefault(remote.password_min_length, 0));
  const prc = valOrDefault(remote.password_required_characters, "");
  const passwordRequirements = remoteToPasswordRequirements(prc);

  // Passkey / Webauthn (only update if local has them set)
  let passkey = local.passkey;
  if (passkey !== undefined) {
    passkey = { enabled: remote.passkey_enabled ?? false };
  }
  let webauthn = local.webauthn;
  if (webauthn !== undefined) {
    webauthn = {
      rp_display_name: valOrDefault(remote.webauthn_rp_display_name, ""),
      rp_id: valOrDefault(remote.webauthn_rp_id, ""),
      rp_origins: strToArr(valOrDefault(remote.webauthn_rp_origins, "")),
    };
  }

  // Rate limit
  const rl = local.rate_limit;
  const hasSmtp = local.email.smtp !== undefined && local.email.smtp.enabled;
  const rateLimit = {
    anonymous_users: intToUint(valOrDefault(remote.rate_limit_anonymous_users, 0)),
    token_refresh: intToUint(valOrDefault(remote.rate_limit_token_refresh, 0)),
    sign_in_sign_ups: intToUint(valOrDefault(remote.rate_limit_otp, 0)),
    token_verifications: intToUint(valOrDefault(remote.rate_limit_verify, 0)),
    email_sent: hasSmtp ? intToUint(valOrDefault(remote.rate_limit_email_sent, 0)) : rl.email_sent,
    sms_sent: intToUint(valOrDefault(remote.rate_limit_sms_sent, 0)),
    web3: intToUint(valOrDefault(remote.rate_limit_web3, 0)),
  };

  // Captcha — only update when local captcha is defined
  let captcha = local.captcha;
  if (captcha !== undefined) {
    // fromAuthConfig: if captcha.Enabled, update provider + secret.SHA256; then set Enabled last
    let provider = captcha.provider;
    let secret = captcha.secret;
    if (captcha.enabled) {
      provider = valOrDefault(remote.security_captcha_provider, "");
      // only overwrite secret if local SHA256 is set (non-empty secret hash)
      if (captcha.secret.length > 0) {
        secret = fromRemoteSecret(remote.security_captcha_secret);
      }
    }
    const enabled = valOrDefault(remote.security_captcha_enabled, false);
    captcha = { enabled, provider, secret };
  }

  // Hooks — only update when local hook is defined
  function applyRemoteHook(
    localHook: HookConfigSubset | undefined,
    enabled: boolean | null | undefined,
    uri: string | null | undefined,
    secrets: string | null | undefined,
  ): HookConfigSubset | undefined {
    if (localHook === undefined) return undefined;
    let newUri = localHook.uri;
    let newSecrets = localHook.secrets;
    // fromAuthConfig: if hook.Enabled, update URI + secrets.SHA256; then set Enabled
    if (localHook.enabled) {
      newUri = valOrDefault(uri, "");
      if (localHook.secrets.length > 0) {
        newSecrets = fromRemoteSecret(secrets);
      }
    }
    return {
      enabled: valOrDefault(enabled, false),
      uri: newUri,
      secrets: newSecrets,
    };
  }

  const hook: AuthSubset["hook"] = {
    mfa_verification_attempt: applyRemoteHook(
      local.hook.mfa_verification_attempt,
      remote.hook_mfa_verification_attempt_enabled,
      remote.hook_mfa_verification_attempt_uri,
      remote.hook_mfa_verification_attempt_secrets,
    ),
    password_verification_attempt: applyRemoteHook(
      local.hook.password_verification_attempt,
      remote.hook_password_verification_attempt_enabled,
      remote.hook_password_verification_attempt_uri,
      remote.hook_password_verification_attempt_secrets,
    ),
    custom_access_token: applyRemoteHook(
      local.hook.custom_access_token,
      remote.hook_custom_access_token_enabled,
      remote.hook_custom_access_token_uri,
      remote.hook_custom_access_token_secrets,
    ),
    send_sms: applyRemoteHook(
      local.hook.send_sms,
      remote.hook_send_sms_enabled,
      remote.hook_send_sms_uri,
      remote.hook_send_sms_secrets,
    ),
    send_email: applyRemoteHook(
      local.hook.send_email,
      remote.hook_send_email_enabled,
      remote.hook_send_email_uri,
      remote.hook_send_email_secrets,
    ),
    before_user_created: applyRemoteHook(
      local.hook.before_user_created,
      remote.hook_before_user_created_enabled,
      remote.hook_before_user_created_uri,
      remote.hook_before_user_created_secrets,
    ),
  };

  // MFA
  const mfa: AuthSubset["mfa"] = {
    max_enrolled_factors: intToUint(valOrDefault(remote.mfa_max_enrolled_factors, 0)),
    totp: {
      enroll_enabled: valOrDefault(remote.mfa_totp_enroll_enabled, false),
      verify_enabled: valOrDefault(remote.mfa_totp_verify_enabled, false),
    },
    phone: {
      enroll_enabled: valOrDefault(remote.mfa_phone_enroll_enabled, false),
      verify_enabled: valOrDefault(remote.mfa_phone_verify_enabled, false),
      otp_length: intToUint(remote.mfa_phone_otp_length ?? 0),
      template: valOrDefault(remote.mfa_phone_template, ""),
      max_frequency: secondsToDurationString(valOrDefault(remote.mfa_phone_max_frequency, 0)),
    },
    web_authn: {
      enroll_enabled: valOrDefault(remote.mfa_web_authn_enroll_enabled, false),
      verify_enabled: valOrDefault(remote.mfa_web_authn_verify_enabled, false),
    },
  };

  // Sessions — Go multiplies by time.Hour
  const sessions: SessionsSubset = {
    timebox: durationString(
      Math.round(valOrDefault(remote.sessions_timebox, 0)) * 3_600_000_000_000,
    ),
    inactivity_timeout: durationString(
      Math.round(valOrDefault(remote.sessions_inactivity_timeout, 0)) * 3_600_000_000_000,
    ),
  };

  // SMTP
  let smtp = local.email.smtp;
  if (smtp !== undefined) {
    if (smtp.enabled) {
      let newPass = smtp.pass;
      if (smtp.pass.length > 0) {
        newPass = fromRemoteSecret(remote.smtp_pass);
      }
      // Go: `if port, err := strconv.ParseUint(portStr, 10, 16); err == nil { s.Port = uint16(port) }`
      // — on parse failure (non-numeric, negative, or > 65535) the port is left
      // unchanged (keeps the local value), not reset to 0.
      const portStr = valOrDefault(remote.smtp_port, "0");
      const parsedPort = parseUint16(portStr);
      smtp = {
        enabled: smtp.enabled,
        host: valOrDefault(remote.smtp_host, ""),
        port: parsedPort ?? smtp.port,
        user: valOrDefault(remote.smtp_user, ""),
        pass: newPass,
        admin_email: valOrDefault(remote.smtp_admin_email, ""),
        sender_name: valOrDefault(remote.smtp_sender_name, ""),
      };
    }
    // "Api resets all values when SMTP is disabled"
    const remoteSmtpEnabled = remote.smtp_host != null;
    smtp = { ...smtp, enabled: remoteSmtpEnabled };
  }

  // Email templates — only overwrite if local field was set (non-nil ptr in Go)
  const templateEntries: Record<string, EmailTemplateSubset> = {};
  const localTemplate = local.email.template ?? {};
  const tmplNames = [
    "invite",
    "confirmation",
    "recovery",
    "magic_link",
    "email_change",
    "reauthentication",
  ];
  type TmplKey =
    | "invite"
    | "confirmation"
    | "recovery"
    | "magic_link"
    | "email_change"
    | "reauthentication";
  const tmplSubjectMap: Record<TmplKey, string | null | undefined> = {
    invite: remote.mailer_subjects_invite,
    confirmation: remote.mailer_subjects_confirmation,
    recovery: remote.mailer_subjects_recovery,
    magic_link: remote.mailer_subjects_magic_link,
    email_change: remote.mailer_subjects_email_change,
    reauthentication: remote.mailer_subjects_reauthentication,
  };
  const tmplContentMap: Record<TmplKey, string | null | undefined> = {
    invite: remote.mailer_templates_invite_content,
    confirmation: remote.mailer_templates_confirmation_content,
    recovery: remote.mailer_templates_recovery_content,
    magic_link: remote.mailer_templates_magic_link_content,
    email_change: remote.mailer_templates_email_change_content,
    reauthentication: remote.mailer_templates_reauthentication_content,
  };

  for (const name of tmplNames) {
    const t = localTemplate[name];
    if (t === undefined) continue;
    const key = name as TmplKey;
    // subject: only update if local subject was set (not undefined)
    let subject = t.subject;
    if (subject !== undefined) {
      const remoteSubject = tmplSubjectMap[key];
      subject = remoteSubject != null ? remoteSubject : undefined;
    }
    // content: only update if local content was set (not undefined)
    let content = t.content;
    if (content !== undefined) {
      const remoteContent = tmplContentMap[key];
      content = remoteContent != null ? remoteContent : undefined;
    }
    templateEntries[name] = { ...t, subject, content };
  }
  const template = Object.keys(templateEntries).length > 0 ? templateEntries : undefined;

  // Email notifications
  const notificationEntries: Record<string, NotificationSubset> = {};
  const localNotification = local.email.notification ?? {};
  type NotifKey =
    | "password_changed"
    | "email_changed"
    | "phone_changed"
    | "identity_linked"
    | "identity_unlinked"
    | "mfa_factor_enrolled"
    | "mfa_factor_unenrolled";
  const notifEnabledMap: Record<NotifKey, boolean | null | undefined> = {
    password_changed: remote.mailer_notifications_password_changed_enabled,
    email_changed: remote.mailer_notifications_email_changed_enabled,
    phone_changed: remote.mailer_notifications_phone_changed_enabled,
    identity_linked: remote.mailer_notifications_identity_linked_enabled,
    identity_unlinked: remote.mailer_notifications_identity_unlinked_enabled,
    mfa_factor_enrolled: remote.mailer_notifications_mfa_factor_enrolled_enabled,
    mfa_factor_unenrolled: remote.mailer_notifications_mfa_factor_unenrolled_enabled,
  };
  const notifSubjectMap: Record<NotifKey, string | null | undefined> = {
    password_changed: remote.mailer_subjects_password_changed_notification,
    email_changed: remote.mailer_subjects_email_changed_notification,
    phone_changed: remote.mailer_subjects_phone_changed_notification,
    identity_linked: remote.mailer_subjects_identity_linked_notification,
    identity_unlinked: remote.mailer_subjects_identity_unlinked_notification,
    mfa_factor_enrolled: remote.mailer_subjects_mfa_factor_enrolled_notification,
    mfa_factor_unenrolled: remote.mailer_subjects_mfa_factor_unenrolled_notification,
  };
  const notifContentMap: Record<NotifKey, string | null | undefined> = {
    password_changed: remote.mailer_templates_password_changed_notification_content,
    email_changed: remote.mailer_templates_email_changed_notification_content,
    phone_changed: remote.mailer_templates_phone_changed_notification_content,
    identity_linked: remote.mailer_templates_identity_linked_notification_content,
    identity_unlinked: remote.mailer_templates_identity_unlinked_notification_content,
    mfa_factor_enrolled: remote.mailer_templates_mfa_factor_enrolled_notification_content,
    mfa_factor_unenrolled: remote.mailer_templates_mfa_factor_unenrolled_notification_content,
  };

  for (const name of Object.keys(localNotification)) {
    const n = localNotification[name];
    if (n === undefined) continue;
    const key = name as NotifKey;
    const remoteEnabled = notifEnabledMap[key];
    const enabled = remoteEnabled != null ? remoteEnabled : n.enabled;
    let subject = n.subject;
    if (subject !== undefined) {
      const remoteSubject = notifSubjectMap[key];
      subject = remoteSubject != null ? remoteSubject : undefined;
    }
    let content = n.content;
    if (content !== undefined) {
      const remoteContent = notifContentMap[key];
      content = remoteContent != null ? remoteContent : undefined;
    }
    notificationEntries[name] = { ...n, enabled, subject, content };
  }
  const notification =
    Object.keys(notificationEntries).length > 0 ? notificationEntries : undefined;

  // Email
  const email: AuthSubset["email"] = {
    enable_signup: valOrDefault(remote.external_email_enabled, false),
    double_confirm_changes: valOrDefault(remote.mailer_secure_email_change_enabled, false),
    enable_confirmations: !valOrDefault(remote.mailer_autoconfirm, false),
    otp_length: intToUint(valOrDefault(remote.mailer_otp_length, 0)),
    otp_expiry: intToUint(remote.mailer_otp_exp ?? 0),
    secure_password_change: valOrDefault(
      remote.security_update_password_require_reauthentication,
      false,
    ),
    max_frequency: secondsToDurationString(valOrDefault(remote.smtp_max_frequency, 0)),
    smtp,
    template,
    notification,
  };

  // SMS
  const localSms = local.sms;
  let twilio = localSms.twilio;
  let twilioVerify = localSms.twilio_verify;
  let messagebird = localSms.messagebird;
  let textlocal = localSms.textlocal;
  let vonage = localSms.vonage;
  // Mirrors Go's `case !s.EnableSignup: return` — when remote phone is disabled
  // and no local provider is enabled, provider reconciliation is skipped.
  let skipSmsProviderReconciliation = false;

  switch (true) {
    case localSms.twilio.enabled:
      {
        let newToken = twilio.auth_token;
        if (newToken.length > 0) {
          newToken = fromRemoteSecret(remote.sms_twilio_auth_token);
        }
        twilio = {
          enabled: twilio.enabled,
          account_sid: valOrDefault(remote.sms_twilio_account_sid, ""),
          message_service_sid: valOrDefault(remote.sms_twilio_message_service_sid, ""),
          auth_token: newToken,
        };
      }
      break;
    case localSms.twilio_verify.enabled:
      {
        let newToken = twilioVerify.auth_token;
        if (newToken.length > 0) {
          newToken = fromRemoteSecret(remote.sms_twilio_verify_auth_token);
        }
        twilioVerify = {
          enabled: twilioVerify.enabled,
          account_sid: valOrDefault(remote.sms_twilio_verify_account_sid, ""),
          message_service_sid: valOrDefault(remote.sms_twilio_verify_message_service_sid, ""),
          auth_token: newToken,
        };
      }
      break;
    case localSms.messagebird.enabled:
      {
        let newKey = messagebird.access_key;
        if (newKey.length > 0) {
          newKey = fromRemoteSecret(remote.sms_messagebird_access_key);
        }
        messagebird = {
          enabled: messagebird.enabled,
          originator: valOrDefault(remote.sms_messagebird_originator, ""),
          access_key: newKey,
        };
      }
      break;
    case localSms.textlocal.enabled:
      {
        let newKey = textlocal.api_key;
        if (newKey.length > 0) {
          newKey = fromRemoteSecret(remote.sms_textlocal_api_key);
        }
        textlocal = {
          enabled: textlocal.enabled,
          sender: valOrDefault(remote.sms_textlocal_sender, ""),
          api_key: newKey,
        };
      }
      break;
    case localSms.vonage.enabled:
      {
        let newSecret = vonage.api_secret;
        if (newSecret.length > 0) {
          newSecret = fromRemoteSecret(remote.sms_vonage_api_secret);
        }
        vonage = {
          enabled: vonage.enabled,
          from: valOrDefault(remote.sms_vonage_from, ""),
          api_key: valOrDefault(remote.sms_vonage_api_key, ""),
          api_secret: newSecret,
        };
      }
      break;
    default:
      {
        // In Go, s.EnableSignup is updated to the remote value BEFORE the switch.
        // `case !s.EnableSignup:` checks the NEW (remote) enable_signup.
        // When remote phone is disabled AND no local provider is enabled, Go
        // returns early and skips provider reconciliation.
        const remoteEnableSignup = valOrDefault(remote.external_phone_enabled, false);
        if (!remoteEnableSignup) {
          skipSmsProviderReconciliation = true;
        }
      }
      break;
  }

  // sms provider flag reconciliation
  let smsNewTwilio = twilio;
  let smsNewTwilioVerify = twilioVerify;
  let smsNewMessagebird = messagebird;
  let smsNewTextlocal = textlocal;
  let smsNewVonage = vonage;
  if (!skipSmsProviderReconciliation) {
    const provider = valOrDefault(remote.sms_provider, "");
    if (provider.length > 0) {
      smsNewTwilio = { ...twilio, enabled: provider === "twilio" };
      smsNewTwilioVerify = { ...twilioVerify, enabled: provider === "twilio_verify" };
      smsNewMessagebird = { ...messagebird, enabled: provider === "messagebird" };
      smsNewTextlocal = { ...textlocal, enabled: provider === "textlocal" };
      smsNewVonage = { ...vonage, enabled: provider === "vonage" };
    }
  }

  const sms: AuthSubset["sms"] = {
    enable_signup: valOrDefault(remote.external_phone_enabled, false),
    max_frequency: secondsToDurationString(valOrDefault(remote.sms_max_frequency, 0)),
    enable_confirmations: valOrDefault(remote.sms_autoconfirm, false),
    template: valOrDefault(remote.sms_template, ""),
    test_otp: envToMap(valOrDefault(remote.sms_test_otp, "")),
    twilio: smsNewTwilio,
    twilio_verify: smsNewTwilioVerify,
    messagebird: smsNewMessagebird,
    textlocal: smsNewTextlocal,
    vonage: smsNewVonage,
  };

  // External providers
  const external: Record<string, ProviderSubset> = {};
  const localExt = local.external;
  for (const name of Object.keys(localExt)) {
    const p = localExt[name];
    if (p === undefined) continue;
    external[name] = applyRemoteProvider(name, p, remote);
  }

  // Web3
  const web3Solana = remote.external_web3_solana_enabled;
  const web3Ethereum = remote.external_web3_ethereum_enabled;
  const web3: AuthSubset["web3"] = {
    solana: {
      enabled: web3Solana != null ? web3Solana : local.web3.solana.enabled,
    },
    ethereum: {
      enabled: web3Ethereum != null ? web3Ethereum : local.web3.ethereum.enabled,
    },
  };

  // OAuthServer — TODO not yet implemented in remote API
  const oauth_server = local.oauth_server;

  return {
    ...local,
    site_url: siteUrl,
    additional_redirect_urls: additionalRedirectUrls,
    jwt_expiry: jwtExpiry,
    enable_refresh_token_rotation: enableRefreshTokenRotation,
    refresh_token_reuse_interval: refreshTokenReuseInterval,
    enable_manual_linking: enableManualLinking,
    enable_signup: enableSignup,
    enable_anonymous_sign_ins: enableAnonymousSignIns,
    minimum_password_length: minimumPasswordLength,
    password_requirements: passwordRequirements,
    passkey,
    webauthn,
    rate_limit: rateLimit,
    captcha,
    hook,
    mfa,
    sessions,
    email,
    sms,
    external,
    web3,
    oauth_server,
  };
}

/** Port of Go `sms.fromAuthConfig` → `envToMap`. */
function envToMap(input: string): Record<string, string> {
  const env = strToArr(input);
  const result: Record<string, string> = {};
  for (const kv of env) {
    const eqIdx = kv.indexOf("=");
    if (eqIdx > 0) {
      result[kv.slice(0, eqIdx)] = kv.slice(eqIdx + 1);
    }
  }
  return result;
}

/** Apply remote config to a single external provider. */
function applyRemoteProvider(
  name: string,
  p: ProviderSubset,
  remote: RemoteAuthConfig,
): ProviderSubset {
  if (!p.enabled) {
    const enabledVal = getProviderEnabled(name, remote);
    if (enabledVal !== undefined) {
      return { ...p, enabled: enabledVal };
    }
    return p;
  }
  // When enabled, update fields
  let clientId = getProviderClientId(name, remote);
  // Apple and Google have additional client IDs
  if (name === "apple") {
    const additional = valOrDefault(remote.external_apple_additional_client_ids, "");
    if (additional.length > 0) {
      clientId = clientId + "," + additional;
    }
  } else if (name === "google") {
    const additional = valOrDefault(remote.external_google_additional_client_ids, "");
    if (additional.length > 0) {
      clientId = clientId + "," + additional;
    }
  }
  // Go: `if len(p.Secret.SHA256) > 0 { p.Secret.SHA256 = ValOrDefault(remote.<X>Secret, "") }`.
  // When the local provider has a secret, it is always replaced by the remote
  // value — defaulting to "" when the API omits it (not kept as the local value).
  let secret = p.secret;
  if (secret.length > 0) {
    secret = fromRemoteSecret(getProviderSecret(name, remote));
  }
  const url = getProviderUrl(name, remote);
  const skipNonceCheck =
    name === "google"
      ? valOrDefault(remote.external_google_skip_nonce_check, false)
      : p.skip_nonce_check;
  const emailOptional = getProviderEmailOptional(name, remote, p.email_optional);
  const enabledFinal = getProviderEnabled(name, remote) ?? false;

  return {
    enabled: enabledFinal,
    client_id: clientId,
    secret,
    url: url ?? p.url,
    redirect_uri: p.redirect_uri,
    skip_nonce_check: skipNonceCheck,
    email_optional: emailOptional,
  };
}

function getProviderEnabled(name: string, r: RemoteAuthConfig): boolean | undefined {
  switch (name) {
    case "apple":
      return r.external_apple_enabled ?? undefined;
    case "azure":
      return r.external_azure_enabled ?? undefined;
    case "bitbucket":
      return r.external_bitbucket_enabled ?? undefined;
    case "discord":
      return r.external_discord_enabled ?? undefined;
    case "facebook":
      return r.external_facebook_enabled ?? undefined;
    case "figma":
      return r.external_figma_enabled ?? undefined;
    case "github":
      return r.external_github_enabled ?? undefined;
    case "gitlab":
      return r.external_gitlab_enabled ?? undefined;
    case "google":
      return r.external_google_enabled ?? undefined;
    case "kakao":
      return r.external_kakao_enabled ?? undefined;
    case "keycloak":
      return r.external_keycloak_enabled ?? undefined;
    case "linkedin_oidc":
      return r.external_linkedin_oidc_enabled ?? undefined;
    case "notion":
      return r.external_notion_enabled ?? undefined;
    case "slack_oidc":
      return r.external_slack_oidc_enabled ?? undefined;
    case "spotify":
      return r.external_spotify_enabled ?? undefined;
    case "twitch":
      return r.external_twitch_enabled ?? undefined;
    case "twitter":
      return r.external_twitter_enabled ?? undefined;
    case "x":
      return r.external_x_enabled ?? undefined;
    case "workos":
      return r.external_workos_enabled ?? undefined;
    case "zoom":
      return r.external_zoom_enabled ?? undefined;
    default:
      return undefined;
  }
}

function getProviderClientId(name: string, r: RemoteAuthConfig): string {
  switch (name) {
    case "apple":
      return valOrDefault(r.external_apple_client_id, "");
    case "azure":
      return valOrDefault(r.external_azure_client_id, "");
    case "bitbucket":
      return valOrDefault(r.external_bitbucket_client_id, "");
    case "discord":
      return valOrDefault(r.external_discord_client_id, "");
    case "facebook":
      return valOrDefault(r.external_facebook_client_id, "");
    case "figma":
      return valOrDefault(r.external_figma_client_id, "");
    case "github":
      return valOrDefault(r.external_github_client_id, "");
    case "gitlab":
      return valOrDefault(r.external_gitlab_client_id, "");
    case "google":
      return valOrDefault(r.external_google_client_id, "");
    case "kakao":
      return valOrDefault(r.external_kakao_client_id, "");
    case "keycloak":
      return valOrDefault(r.external_keycloak_client_id, "");
    case "linkedin_oidc":
      return valOrDefault(r.external_linkedin_oidc_client_id, "");
    case "notion":
      return valOrDefault(r.external_notion_client_id, "");
    case "slack_oidc":
      return valOrDefault(r.external_slack_oidc_client_id, "");
    case "spotify":
      return valOrDefault(r.external_spotify_client_id, "");
    case "twitch":
      return valOrDefault(r.external_twitch_client_id, "");
    case "twitter":
      return valOrDefault(r.external_twitter_client_id, "");
    case "x":
      return valOrDefault(r.external_x_client_id, "");
    case "workos":
      return valOrDefault(r.external_workos_client_id, "");
    case "zoom":
      return valOrDefault(r.external_zoom_client_id, "");
    default:
      return "";
  }
}

function getProviderSecret(name: string, r: RemoteAuthConfig): string | undefined {
  switch (name) {
    case "apple":
      return r.external_apple_secret ?? undefined;
    case "azure":
      return r.external_azure_secret ?? undefined;
    case "bitbucket":
      return r.external_bitbucket_secret ?? undefined;
    case "discord":
      return r.external_discord_secret ?? undefined;
    case "facebook":
      return r.external_facebook_secret ?? undefined;
    case "figma":
      return r.external_figma_secret ?? undefined;
    case "github":
      return r.external_github_secret ?? undefined;
    case "gitlab":
      return r.external_gitlab_secret ?? undefined;
    case "google":
      return r.external_google_secret ?? undefined;
    case "kakao":
      return r.external_kakao_secret ?? undefined;
    case "keycloak":
      return r.external_keycloak_secret ?? undefined;
    case "linkedin_oidc":
      return r.external_linkedin_oidc_secret ?? undefined;
    case "notion":
      return r.external_notion_secret ?? undefined;
    case "slack_oidc":
      return r.external_slack_oidc_secret ?? undefined;
    case "spotify":
      return r.external_spotify_secret ?? undefined;
    case "twitch":
      return r.external_twitch_secret ?? undefined;
    case "twitter":
      return r.external_twitter_secret ?? undefined;
    case "x":
      return r.external_x_secret ?? undefined;
    case "workos":
      return r.external_workos_secret ?? undefined;
    case "zoom":
      return r.external_zoom_secret ?? undefined;
    default:
      return undefined;
  }
}

function getProviderUrl(name: string, r: RemoteAuthConfig): string | undefined {
  switch (name) {
    case "azure":
      return r.external_azure_url ?? undefined;
    case "gitlab":
      return r.external_gitlab_url ?? undefined;
    case "keycloak":
      return r.external_keycloak_url ?? undefined;
    case "workos":
      return r.external_workos_url ?? undefined;
    default:
      return undefined;
  }
}

function getProviderEmailOptional(name: string, r: RemoteAuthConfig, fallback: boolean): boolean {
  switch (name) {
    case "apple":
      return r.external_apple_email_optional ?? fallback;
    case "azure":
      return r.external_azure_email_optional ?? fallback;
    case "bitbucket":
      return r.external_bitbucket_email_optional ?? fallback;
    case "discord":
      return r.external_discord_email_optional ?? fallback;
    case "facebook":
      return r.external_facebook_email_optional ?? fallback;
    case "figma":
      return r.external_figma_email_optional ?? fallback;
    case "github":
      return r.external_github_email_optional ?? fallback;
    case "gitlab":
      return r.external_gitlab_email_optional ?? fallback;
    case "google":
      return r.external_google_email_optional ?? fallback;
    case "kakao":
      return r.external_kakao_email_optional ?? fallback;
    case "keycloak":
      return r.external_keycloak_email_optional ?? fallback;
    case "linkedin_oidc":
      return r.external_linkedin_oidc_email_optional ?? fallback;
    case "notion":
      return r.external_notion_email_optional ?? fallback;
    case "slack_oidc":
      return r.external_slack_oidc_email_optional ?? fallback;
    case "spotify":
      return r.external_spotify_email_optional ?? fallback;
    case "twitch":
      return r.external_twitch_email_optional ?? fallback;
    case "twitter":
      return r.external_twitter_email_optional ?? fallback;
    case "x":
      return r.external_x_email_optional ?? fallback;
    case "zoom":
      return r.external_zoom_email_optional ?? fallback;
    default:
      return fallback;
  }
}

// ---------------------------------------------------------------------------
// mfaPhoneNewlyEnabled / mfaWebauthnNewlyEnabled / disable helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when MFA phone verify is enabled locally but was disabled on
 * the remote (meaning we'd be enabling it — potentially an addon cost).
 */
export function mfaPhoneNewlyEnabled(local: AuthSubset, copy: AuthSubset): boolean {
  return local.mfa.phone.verify_enabled && !copy.mfa.phone.verify_enabled;
}

/**
 * Returns true when MFA WebAuthn verify is enabled locally but was disabled on
 * the remote.
 */
export function mfaWebauthnNewlyEnabled(local: AuthSubset, copy: AuthSubset): boolean {
  return local.mfa.web_authn.verify_enabled && !copy.mfa.web_authn.verify_enabled;
}

/** Disables MFA phone enroll and verify. */
export function disableMfaPhone(local: AuthSubset): AuthSubset {
  return {
    ...local,
    mfa: {
      ...local.mfa,
      phone: { ...local.mfa.phone, verify_enabled: false, enroll_enabled: false },
    },
  };
}

/** Disables MFA WebAuthn enroll and verify. */
export function disableMfaWebauthn(local: AuthSubset): AuthSubset {
  return {
    ...local,
    mfa: {
      ...local.mfa,
      web_authn: { ...local.mfa.web_authn, verify_enabled: false, enroll_enabled: false },
    },
  };
}

// ---------------------------------------------------------------------------
// encodeAuthToml — TOML serialisation
// ---------------------------------------------------------------------------

function authToTomlValue(s: AuthSubset): { readonly [k: string]: TomlValue | undefined } {
  return {
    enabled: s.enabled,
    site_url: s.site_url,
    external_url: s.external_url,
    additional_redirect_urls: s.additional_redirect_urls,
    jwt_expiry: s.jwt_expiry,
    jwt_issuer: s.jwt_issuer,
    enable_refresh_token_rotation: s.enable_refresh_token_rotation,
    refresh_token_reuse_interval: s.refresh_token_reuse_interval,
    enable_manual_linking: s.enable_manual_linking,
    enable_signup: s.enable_signup,
    enable_anonymous_sign_ins: s.enable_anonymous_sign_ins,
    minimum_password_length: s.minimum_password_length,
    password_requirements: s.password_requirements,
    signing_keys_path: s.signing_keys_path,
    passkey: s.passkey === undefined ? undefined : { enabled: s.passkey.enabled },
    webauthn:
      s.webauthn === undefined
        ? undefined
        : {
            rp_display_name: s.webauthn.rp_display_name,
            rp_id: s.webauthn.rp_id,
            rp_origins: s.webauthn.rp_origins,
          },
    rate_limit: {
      anonymous_users: s.rate_limit.anonymous_users,
      token_refresh: s.rate_limit.token_refresh,
      sign_in_sign_ups: s.rate_limit.sign_in_sign_ups,
      token_verifications: s.rate_limit.token_verifications,
      email_sent: s.rate_limit.email_sent,
      sms_sent: s.rate_limit.sms_sent,
      web3: s.rate_limit.web3,
    },
    captcha:
      s.captcha === undefined
        ? undefined
        : {
            enabled: s.captcha.enabled,
            provider: s.captcha.provider,
            secret: s.captcha.secret,
          },
    hook: {
      mfa_verification_attempt:
        s.hook.mfa_verification_attempt === undefined
          ? undefined
          : hookConfigToValue(s.hook.mfa_verification_attempt),
      password_verification_attempt:
        s.hook.password_verification_attempt === undefined
          ? undefined
          : hookConfigToValue(s.hook.password_verification_attempt),
      custom_access_token:
        s.hook.custom_access_token === undefined
          ? undefined
          : hookConfigToValue(s.hook.custom_access_token),
      send_sms: s.hook.send_sms === undefined ? undefined : hookConfigToValue(s.hook.send_sms),
      send_email:
        s.hook.send_email === undefined ? undefined : hookConfigToValue(s.hook.send_email),
      before_user_created:
        s.hook.before_user_created === undefined
          ? undefined
          : hookConfigToValue(s.hook.before_user_created),
    },
    mfa: {
      max_enrolled_factors: s.mfa.max_enrolled_factors,
      totp: {
        enroll_enabled: s.mfa.totp.enroll_enabled,
        verify_enabled: s.mfa.totp.verify_enabled,
      },
      phone: {
        enroll_enabled: s.mfa.phone.enroll_enabled,
        verify_enabled: s.mfa.phone.verify_enabled,
        otp_length: s.mfa.phone.otp_length,
        template: s.mfa.phone.template,
        max_frequency: s.mfa.phone.max_frequency,
      },
      web_authn: {
        enroll_enabled: s.mfa.web_authn.enroll_enabled,
        verify_enabled: s.mfa.web_authn.verify_enabled,
      },
    },
    sessions: {
      timebox: s.sessions.timebox,
      inactivity_timeout: s.sessions.inactivity_timeout,
    },
    email: {
      enable_signup: s.email.enable_signup,
      double_confirm_changes: s.email.double_confirm_changes,
      enable_confirmations: s.email.enable_confirmations,
      secure_password_change: s.email.secure_password_change,
      max_frequency: s.email.max_frequency,
      otp_length: s.email.otp_length,
      otp_expiry: s.email.otp_expiry,
      template:
        s.email.template === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(s.email.template).map(([k, t]) => [
                k,
                { subject: t.subject, content: t.content, content_path: t.content_path },
              ]),
            ),
      notification:
        s.email.notification === undefined
          ? undefined
          : Object.fromEntries(
              Object.entries(s.email.notification).map(([k, n]) => [
                k,
                {
                  enabled: n.enabled,
                  subject: n.subject,
                  content: n.content,
                  content_path: n.content_path,
                },
              ]),
            ),
      smtp:
        s.email.smtp === undefined
          ? undefined
          : {
              enabled: s.email.smtp.enabled,
              host: s.email.smtp.host,
              port: s.email.smtp.port,
              user: s.email.smtp.user,
              pass: s.email.smtp.pass,
              admin_email: s.email.smtp.admin_email,
              sender_name: s.email.smtp.sender_name,
            },
    },
    sms: {
      enable_signup: s.sms.enable_signup,
      enable_confirmations: s.sms.enable_confirmations,
      template: s.sms.template,
      max_frequency: s.sms.max_frequency,
      twilio: {
        enabled: s.sms.twilio.enabled,
        account_sid: s.sms.twilio.account_sid,
        message_service_sid: s.sms.twilio.message_service_sid,
        auth_token: s.sms.twilio.auth_token,
      },
      twilio_verify: {
        enabled: s.sms.twilio_verify.enabled,
        account_sid: s.sms.twilio_verify.account_sid,
        message_service_sid: s.sms.twilio_verify.message_service_sid,
        auth_token: s.sms.twilio_verify.auth_token,
      },
      messagebird: {
        enabled: s.sms.messagebird.enabled,
        originator: s.sms.messagebird.originator,
        access_key: s.sms.messagebird.access_key,
      },
      textlocal: {
        enabled: s.sms.textlocal.enabled,
        sender: s.sms.textlocal.sender,
        api_key: s.sms.textlocal.api_key,
      },
      vonage: {
        enabled: s.sms.vonage.enabled,
        from: s.sms.vonage.from,
        api_key: s.sms.vonage.api_key,
        api_secret: s.sms.vonage.api_secret,
      },
      test_otp: s.sms.test_otp,
    },
    external:
      Object.keys(s.external).length === 0
        ? undefined
        : Object.fromEntries(
            Object.entries(s.external).map(([k, p]) => [
              k,
              {
                enabled: p.enabled,
                client_id: p.client_id,
                secret: p.secret,
                url: p.url,
                redirect_uri: p.redirect_uri,
                skip_nonce_check: p.skip_nonce_check,
                email_optional: p.email_optional,
              },
            ]),
          ),
    web3: {
      solana: { enabled: s.web3.solana.enabled },
      ethereum: { enabled: s.web3.ethereum.enabled },
    },
    oauth_server: {
      enabled: s.oauth_server.enabled,
      allow_dynamic_registration: s.oauth_server.allow_dynamic_registration,
      authorization_url_path: s.oauth_server.authorization_url_path,
    },
    publishable_key: s.publishable_key,
    secret_key: s.secret_key,
    jwt_secret: s.jwt_secret,
    anon_key: s.anon_key,
    service_role_key: s.service_role_key,
    third_party: {
      firebase: {
        enabled: s.third_party.firebase.enabled,
        project_id: s.third_party.firebase.project_id,
      },
      auth0: {
        enabled: s.third_party.auth0.enabled,
        tenant: s.third_party.auth0.tenant,
        tenant_region: s.third_party.auth0.tenant_region,
      },
      aws_cognito: {
        enabled: s.third_party.aws_cognito.enabled,
        user_pool_id: s.third_party.aws_cognito.user_pool_id,
        user_pool_region: s.third_party.aws_cognito.user_pool_region,
      },
      clerk: {
        enabled: s.third_party.clerk.enabled,
        domain: s.third_party.clerk.domain,
      },
      workos: {
        enabled: s.third_party.workos.enabled,
        issuer_url: s.third_party.workos.issuer_url,
      },
    },
  };
}

function hookConfigToValue(h: HookConfigSubset): {
  enabled: boolean;
  uri: string;
  secrets: string;
} {
  return { enabled: h.enabled, uri: h.uri, secrets: h.secrets };
}

/** Port of Go `ToTomlBytes(auth)`. Serialises the full auth struct. */
function encodeAuthToml(s: AuthSubset): string {
  return encodeToml(AUTH_FIELDS, authToTomlValue(s));
}

// ---------------------------------------------------------------------------
// diffAuth
// ---------------------------------------------------------------------------

/** Port of Go `(*auth).DiffWithRemote`. */
export function diffAuth(remoteCompare: AuthSubset, local: AuthSubset): string {
  return diff("remote[auth]", encodeAuthToml(remoteCompare), "local[auth]", encodeAuthToml(local));
}

// ---------------------------------------------------------------------------
// authToUpdateBody
// ---------------------------------------------------------------------------

/**
 * Port of Go `(*auth).ToUpdateAuthConfigBody`.
 * Returns a flat record whose keys are the snake_case API field names.
 */
export function authToUpdateBody(local: AuthSubset): RemoteAuthUpdateBody {
  const body: Record<string, unknown> = {};

  body["site_url"] = local.site_url;
  body["uri_allow_list"] = local.additional_redirect_urls.join(",");
  body["jwt_exp"] = local.jwt_expiry;
  body["refresh_token_rotation_enabled"] = local.enable_refresh_token_rotation;
  body["security_refresh_token_reuse_interval"] = local.refresh_token_reuse_interval;
  body["security_manual_linking_enabled"] = local.enable_manual_linking;
  body["disable_signup"] = !local.enable_signup;
  body["external_anonymous_users_enabled"] = local.enable_anonymous_sign_ins;
  body["password_min_length"] = local.minimum_password_length;
  body["password_required_characters"] = passwordRequirementsToChar(local.password_requirements);

  // Rate limits
  body["rate_limit_anonymous_users"] = local.rate_limit.anonymous_users;
  body["rate_limit_token_refresh"] = local.rate_limit.token_refresh;
  body["rate_limit_otp"] = local.rate_limit.sign_in_sign_ups;
  body["rate_limit_verify"] = local.rate_limit.token_verifications;
  body["rate_limit_sms_sent"] = local.rate_limit.sms_sent;
  body["rate_limit_web3"] = local.rate_limit.web3;
  // Email rate limit only set when SMTP is enabled
  if (local.email.smtp !== undefined && local.email.smtp.enabled) {
    body["rate_limit_email_sent"] = local.rate_limit.email_sent;
  }

  // Captcha
  if (local.captcha !== undefined) {
    body["security_captcha_enabled"] = local.captcha.enabled;
    if (local.captcha.enabled) {
      body["security_captcha_provider"] = local.captcha.provider;
      // Go sends `Secret.Value` (plaintext) when the secret is hashed
      // (`len(SHA256) > 0`); the hashed field gates inclusion, the raw value is sent.
      if (local.captcha.secret.length > 0) {
        body["security_captcha_secret"] = local.rawSecrets.captcha;
      }
    }
  }

  // Passkey / Webauthn
  if (local.passkey !== undefined) {
    body["passkey_enabled"] = local.passkey.enabled;
  }
  if (local.webauthn !== undefined) {
    body["webauthn_rp_display_name"] = local.webauthn.rp_display_name;
    body["webauthn_rp_id"] = local.webauthn.rp_id;
    body["webauthn_rp_origins"] = local.webauthn.rp_origins.join(",");
  }

  // Hooks
  addHookToBody(
    body,
    "before_user_created",
    local.hook.before_user_created,
    local.rawSecrets.hooks,
  );
  addHookToBody(
    body,
    "custom_access_token",
    local.hook.custom_access_token,
    local.rawSecrets.hooks,
  );
  addHookToBody(body, "send_email", local.hook.send_email, local.rawSecrets.hooks);
  addHookToBody(body, "send_sms", local.hook.send_sms, local.rawSecrets.hooks);
  addHookToBody(
    body,
    "mfa_verification_attempt",
    local.hook.mfa_verification_attempt,
    local.rawSecrets.hooks,
  );
  addHookToBody(
    body,
    "password_verification_attempt",
    local.hook.password_verification_attempt,
    local.rawSecrets.hooks,
  );

  // MFA
  body["mfa_max_enrolled_factors"] = local.mfa.max_enrolled_factors;
  body["mfa_totp_enroll_enabled"] = local.mfa.totp.enroll_enabled;
  body["mfa_totp_verify_enabled"] = local.mfa.totp.verify_enabled;
  body["mfa_phone_enroll_enabled"] = local.mfa.phone.enroll_enabled;
  body["mfa_phone_verify_enabled"] = local.mfa.phone.verify_enabled;
  body["mfa_phone_otp_length"] = local.mfa.phone.otp_length;
  body["mfa_phone_template"] = local.mfa.phone.template;
  body["mfa_phone_max_frequency"] = durationToSeconds(local.mfa.phone.max_frequency);
  body["mfa_web_authn_enroll_enabled"] = local.mfa.web_authn.enroll_enabled;
  body["mfa_web_authn_verify_enabled"] = local.mfa.web_authn.verify_enabled;

  // Sessions
  body["sessions_timebox"] = durationToHours(local.sessions.timebox);
  body["sessions_inactivity_timeout"] = durationToHours(local.sessions.inactivity_timeout);

  // Email
  body["external_email_enabled"] = local.email.enable_signup;
  body["mailer_secure_email_change_enabled"] = local.email.double_confirm_changes;
  body["mailer_autoconfirm"] = !local.email.enable_confirmations;
  body["mailer_otp_length"] = local.email.otp_length;
  body["mailer_otp_exp"] = local.email.otp_expiry;
  body["security_update_password_require_reauthentication"] = local.email.secure_password_change;
  body["smtp_max_frequency"] = durationToSeconds(local.email.max_frequency);

  if (local.email.smtp !== undefined) {
    if (!local.email.smtp.enabled) {
      body["smtp_host"] = "";
    } else {
      body["smtp_host"] = local.email.smtp.host;
      body["smtp_port"] = String(local.email.smtp.port);
      body["smtp_user"] = local.email.smtp.user;
      if (local.email.smtp.pass.length > 0) {
        body["smtp_pass"] = local.rawSecrets.smtp_pass;
      }
      body["smtp_admin_email"] = local.email.smtp.admin_email;
      body["smtp_sender_name"] = local.email.smtp.sender_name;
    }
  }

  // Email templates
  const templates = local.email.template;
  if (templates !== undefined && Object.keys(templates).length > 0) {
    const tmpl = (k: string) => templates[k];
    const t = tmpl("invite");
    if (t?.subject !== undefined) body["mailer_subjects_invite"] = t.subject;
    if (t?.content !== undefined) body["mailer_templates_invite_content"] = t.content;
    const tc = tmpl("confirmation");
    if (tc?.subject !== undefined) body["mailer_subjects_confirmation"] = tc.subject;
    if (tc?.content !== undefined) body["mailer_templates_confirmation_content"] = tc.content;
    const tr = tmpl("recovery");
    if (tr?.subject !== undefined) body["mailer_subjects_recovery"] = tr.subject;
    if (tr?.content !== undefined) body["mailer_templates_recovery_content"] = tr.content;
    const ml = tmpl("magic_link");
    if (ml?.subject !== undefined) body["mailer_subjects_magic_link"] = ml.subject;
    if (ml?.content !== undefined) body["mailer_templates_magic_link_content"] = ml.content;
    const ec = tmpl("email_change");
    if (ec?.subject !== undefined) body["mailer_subjects_email_change"] = ec.subject;
    if (ec?.content !== undefined) body["mailer_templates_email_change_content"] = ec.content;
    const re = tmpl("reauthentication");
    if (re?.subject !== undefined) body["mailer_subjects_reauthentication"] = re.subject;
    if (re?.content !== undefined) body["mailer_templates_reauthentication_content"] = re.content;
  }

  // Notifications
  const notifications = local.email.notification;
  if (notifications !== undefined && Object.keys(notifications).length > 0) {
    const n = (k: string) => notifications[k];
    const pc = n("password_changed");
    if (pc !== undefined) {
      body["mailer_notifications_password_changed_enabled"] = pc.enabled;
      if (pc.subject !== undefined)
        body["mailer_subjects_password_changed_notification"] = pc.subject;
      if (pc.content !== undefined)
        body["mailer_templates_password_changed_notification_content"] = pc.content;
    }
    const ec = n("email_changed");
    if (ec !== undefined) {
      body["mailer_notifications_email_changed_enabled"] = ec.enabled;
      if (ec.subject !== undefined) body["mailer_subjects_email_changed_notification"] = ec.subject;
      if (ec.content !== undefined)
        body["mailer_templates_email_changed_notification_content"] = ec.content;
    }
    const phc = n("phone_changed");
    if (phc !== undefined) {
      body["mailer_notifications_phone_changed_enabled"] = phc.enabled;
      if (phc.subject !== undefined)
        body["mailer_subjects_phone_changed_notification"] = phc.subject;
      if (phc.content !== undefined)
        body["mailer_templates_phone_changed_notification_content"] = phc.content;
    }
    const il = n("identity_linked");
    if (il !== undefined) {
      body["mailer_notifications_identity_linked_enabled"] = il.enabled;
      if (il.subject !== undefined)
        body["mailer_subjects_identity_linked_notification"] = il.subject;
      if (il.content !== undefined)
        body["mailer_templates_identity_linked_notification_content"] = il.content;
    }
    const iu = n("identity_unlinked");
    if (iu !== undefined) {
      body["mailer_notifications_identity_unlinked_enabled"] = iu.enabled;
      if (iu.subject !== undefined)
        body["mailer_subjects_identity_unlinked_notification"] = iu.subject;
      if (iu.content !== undefined)
        body["mailer_templates_identity_unlinked_notification_content"] = iu.content;
    }
    const mfe = n("mfa_factor_enrolled");
    if (mfe !== undefined) {
      body["mailer_notifications_mfa_factor_enrolled_enabled"] = mfe.enabled;
      if (mfe.subject !== undefined)
        body["mailer_subjects_mfa_factor_enrolled_notification"] = mfe.subject;
      if (mfe.content !== undefined)
        body["mailer_templates_mfa_factor_enrolled_notification_content"] = mfe.content;
    }
    const mfu = n("mfa_factor_unenrolled");
    if (mfu !== undefined) {
      body["mailer_notifications_mfa_factor_unenrolled_enabled"] = mfu.enabled;
      if (mfu.subject !== undefined)
        body["mailer_subjects_mfa_factor_unenrolled_notification"] = mfu.subject;
      if (mfu.content !== undefined)
        body["mailer_templates_mfa_factor_unenrolled_notification_content"] = mfu.content;
    }
  }

  // SMS
  body["external_phone_enabled"] = local.sms.enable_signup;
  body["sms_max_frequency"] = durationToSeconds(local.sms.max_frequency);
  body["sms_autoconfirm"] = local.sms.enable_confirmations;
  body["sms_template"] = local.sms.template;
  const otpString = mapToEnv(local.sms.test_otp);
  if (otpString.length > 0) {
    body["sms_test_otp"] = otpString;
    // 10-year validity, matching Go's time.Now().UTC().AddDate(10, 0, 0):
    // calendar-exact, so leap days are counted (a flat 3650-day offset would be
    // 2-3 days short). setUTCFullYear keeps the UTC semantics of Go's .UTC().
    const validUntil = new Date();
    validUntil.setUTCFullYear(validUntil.getUTCFullYear() + 10);
    body["sms_test_otp_valid_until"] = validUntil.toISOString();
  }

  switch (true) {
    case local.sms.twilio.enabled:
      body["sms_provider"] = "twilio";
      if (local.sms.twilio.auth_token.length > 0) {
        body["sms_twilio_auth_token"] = local.rawSecrets.sms.twilio;
      }
      body["sms_twilio_account_sid"] = local.sms.twilio.account_sid;
      body["sms_twilio_message_service_sid"] = local.sms.twilio.message_service_sid;
      break;
    case local.sms.twilio_verify.enabled:
      body["sms_provider"] = "twilio_verify";
      if (local.sms.twilio_verify.auth_token.length > 0) {
        body["sms_twilio_verify_auth_token"] = local.rawSecrets.sms.twilio_verify;
      }
      body["sms_twilio_verify_account_sid"] = local.sms.twilio_verify.account_sid;
      body["sms_twilio_verify_message_service_sid"] = local.sms.twilio_verify.message_service_sid;
      break;
    case local.sms.messagebird.enabled:
      body["sms_provider"] = "messagebird";
      if (local.sms.messagebird.access_key.length > 0) {
        body["sms_messagebird_access_key"] = local.rawSecrets.sms.messagebird;
      }
      body["sms_messagebird_originator"] = local.sms.messagebird.originator;
      break;
    case local.sms.textlocal.enabled:
      body["sms_provider"] = "textlocal";
      if (local.sms.textlocal.api_key.length > 0) {
        body["sms_textlocal_api_key"] = local.rawSecrets.sms.textlocal;
      }
      body["sms_textlocal_sender"] = local.sms.textlocal.sender;
      break;
    case local.sms.vonage.enabled:
      body["sms_provider"] = "vonage";
      if (local.sms.vonage.api_secret.length > 0) {
        body["sms_vonage_api_secret"] = local.rawSecrets.sms.vonage;
      }
      body["sms_vonage_api_key"] = local.sms.vonage.api_key;
      body["sms_vonage_from"] = local.sms.vonage.from;
      break;
    default:
      break;
  }

  // External providers
  for (const [name, p] of Object.entries(local.external)) {
    addProviderToBody(body, name, p, local.rawSecrets.providers[name] ?? "");
  }

  // Web3
  body["external_web3_solana_enabled"] = local.web3.solana.enabled;
  body["external_web3_ethereum_enabled"] = local.web3.ethereum.enabled;

  return body;
}

function addHookToBody(
  body: Record<string, unknown>,
  name: string,
  hook: HookConfigSubset | undefined,
  rawSecrets: Readonly<Record<string, string>>,
): void {
  if (hook === undefined) return;
  body[`hook_${name}_enabled`] = hook.enabled;
  if (hook.enabled) {
    body[`hook_${name}_uri`] = hook.uri;
    // Send the raw plaintext value (Go `Secret.Value`), gated by hash presence.
    if (hook.secrets.length > 0) {
      body[`hook_${name}_secrets`] = rawSecrets[name] ?? "";
    }
  }
}

function addProviderToBody(
  body: Record<string, unknown>,
  name: string,
  p: ProviderSubset,
  rawSecret: string,
): void {
  const key = `external_${name}`;
  body[`${key}_enabled`] = p.enabled;
  if (p.enabled) {
    body[`${key}_client_id`] = p.client_id;
    // Send the raw plaintext value (Go `Secret.Value`), gated by hash presence.
    if (p.secret.length > 0) {
      body[`${key}_secret`] = rawSecret;
    }
    if (name === "azure" || name === "gitlab" || name === "keycloak" || name === "workos") {
      body[`${key}_url`] = p.url;
    }
    body[`${key}_email_optional`] = p.email_optional;
    if (name === "google") {
      body[`${key}_skip_nonce_check`] = p.skip_nonce_check;
    }
  }
}

/**
 * Mirrors Go `strconv.ParseUint(s, 10, 16)`: base-10 digits only, no sign, no
 * suffix, value <= 65535. Returns `undefined` on any parse error.
 */
function parseUint16(s: string): number | undefined {
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number.parseInt(s, 10);
  return n > 65535 ? undefined : n;
}

/** `mapToEnv`: mirrors Go's `mapToEnv`. Keys in iteration order. */
function mapToEnv(input: Readonly<Record<string, string>>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    parts.push(`${k}=${v}`);
  }
  return parts.join(",");
}

/** Convert a duration string back to integer seconds (for API body). */
function durationToSeconds(s: string): number {
  try {
    return Math.floor(parseDuration(s) / 1_000_000_000);
  } catch {
    return 0;
  }
}

/** Convert a duration string back to hours as float32 (for sessions API body). */
function durationToHours(s: string): number {
  try {
    return parseDuration(s) / 3_600_000_000_000;
  } catch {
    return 0;
  }
}

/** Maps the local `password_requirements` enum to the API `password_required_characters` value. */
function passwordRequirementsToChar(pr: string): string {
  return PASSWORD_REQUIREMENTS_TO_CHAR[pr] ?? "";
}
