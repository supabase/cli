import { LEGACY_VALID_REF } from "./legacy-mocks.ts";

/**
 * Schema-valid `GET /v2/projects/{ref}/config` response body whose managed
 * values all sit at the local schema defaults, so an empty `config.toml`
 * diffs clean against it. Shared by `config diff` and `config push`'s
 * integration suites — hoisted here (verbatim, CLI-2313 shard 5a) rather than
 * duplicated, per `apps/cli/CLAUDE.md`'s "Hoist Before You Duplicate" rule.
 */
export function legacyV2ProjectConfigResponse(
  opts: {
    readonly ref?: string;
    readonly attributes?: (attributes: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const attributes: Record<string, unknown> = {
    database: {
      major_version: 17,
      ssl_enforced: false,
      network_restrictions: {
        entitlement: "allowed",
        status: "applied",
        allowed_cidrs: [
          { address: "0.0.0.0/0", type: "v4" },
          { address: "::/0", type: "v6" },
        ],
      },
      postgres_settings: {},
    },
    pooler: {
      pool_mode: "transaction",
      ignore_startup_parameters: "",
      server_idle_timeout: 0,
      server_lifetime: 0,
      query_wait_timeout: 0,
      reserve_pool_size: 0,
      default_pool_size: 20,
      max_client_conn: 100,
    },
    // A realistic fresh-project GoTrue record at platform defaults — the
    // largest, most transform-heavy mapping surface (durations, inversions,
    // unconfigured sentinels, provisioning-default subjects) must run end to
    // end and classify CLEANLY against an empty config.toml. An `auth: {}`
    // here previously let two classifier blockers through untested.
    auth: {
      site_url: "http://127.0.0.1:3000",
      uri_allow_list: "https://127.0.0.1:3000",
      jwt_exp: 3600,
      refresh_token_rotation_enabled: true,
      security_refresh_token_reuse_interval: 10,
      security_manual_linking_enabled: false,
      disable_signup: false,
      external_anonymous_users_enabled: false,
      password_min_length: 6,
      password_required_characters: "",
      rate_limit_anonymous_users: 30,
      rate_limit_token_refresh: 150,
      rate_limit_otp: 30,
      rate_limit_verify: 30,
      rate_limit_sms_sent: 30,
      rate_limit_web3: 30,
      // GoTrue reports 0 hours for unconfigured session bounds; the mapping
      // canonicalizes them to the STRING "0s" (registry unconfiguredValue).
      sessions_timebox: 0,
      sessions_inactivity_timeout: 0,
      external_email_enabled: true,
      mailer_secure_email_change_enabled: true,
      mailer_autoconfirm: true,
      security_update_password_require_reauthentication: false,
      mailer_otp_length: 6,
      mailer_otp_exp: 3600,
      smtp_max_frequency: 1,
      smtp_host: null,
      // Provisioning-default subject lines (recorded config_auth fixtures).
      mailer_subjects_invite: "You have been invited",
      mailer_subjects_confirmation: "Confirm Your Signup",
      mailer_subjects_recovery: "Reset Your Password",
      mailer_subjects_magic_link: "Your Magic Link",
      mailer_subjects_email_change: "Confirm Email Change",
      mailer_subjects_reauthentication: "Confirm Reauthentication",
      mailer_subjects_password_changed_notification: "Your password has been changed",
      mailer_subjects_email_changed_notification: "Your email address has been changed",
      mailer_subjects_phone_changed_notification: "Your phone number has been changed",
      mailer_subjects_identity_linked_notification: "A new identity has been linked",
      mailer_subjects_identity_unlinked_notification: "An identity has been unlinked",
      mailer_subjects_mfa_factor_enrolled_notification: "A new MFA factor has been enrolled",
      mailer_subjects_mfa_factor_unenrolled_notification: "An MFA factor has been unenrolled",
      mailer_notifications_password_changed_enabled: false,
      mailer_notifications_email_changed_enabled: false,
      mailer_notifications_phone_changed_enabled: false,
      mailer_notifications_identity_linked_enabled: false,
      mailer_notifications_identity_unlinked_enabled: false,
      mailer_notifications_mfa_factor_enrolled_enabled: false,
      mailer_notifications_mfa_factor_unenrolled_enabled: false,
      external_phone_enabled: false,
      sms_autoconfirm: false,
      sms_max_frequency: 5,
      sms_otp_exp: 60,
      sms_otp_length: 6,
      external_github_enabled: false,
      external_github_client_id: "",
      mfa_totp_enroll_enabled: false,
      mfa_totp_verify_enabled: false,
      mfa_phone_enroll_enabled: false,
      mfa_phone_verify_enabled: false,
      mfa_phone_otp_length: 6,
      mfa_phone_template: "Your code is {{ .Code }}",
      mfa_phone_max_frequency: 5,
      mfa_web_authn_enroll_enabled: false,
      mfa_web_authn_verify_enabled: false,
      mfa_max_enrolled_factors: 10,
    },
    api: {
      db_schema: "public,graphql_public",
      db_extra_search_path: "public,extensions",
      max_rows: 1000,
      db_pool_acquisition_timeout: 10,
      db_pool: null,
    },
    realtime: {
      private_only: false,
      max_concurrent_users: 200,
      max_events_per_second: 100,
      max_bytes_per_second: 100000,
      max_channels_per_client: 100,
      max_joins_per_second: 100,
      max_presence_events_per_second: 100,
      max_payload_size_in_kb: 100,
      presence_enabled: true,
      suspend: false,
      connection_pool: 10,
      postgres_changes_pool: null,
    },
    storage: {
      file_size_limit: 52428800,
      features: {
        image_transformation: { enabled: false },
        s3_protocol: { enabled: true },
        purge_cache: { enabled: false },
        iceberg_catalog: { enabled: false, max_namespaces: 5, max_tables: 10, max_catalogs: 2 },
        vector_buckets: { enabled: true, max_buckets: 10, max_indexes: 5 },
      },
      capabilities: { list_v2: true, iceberg_catalog: false },
      upstream_target: "main",
      migration_version: "20240701",
      database_pool_mode: "transaction",
    },
  };
  return {
    data: {
      type: "project_config",
      id: opts.ref ?? LEGACY_VALID_REF,
      attributes: opts.attributes === undefined ? attributes : opts.attributes(attributes),
    },
  };
}
