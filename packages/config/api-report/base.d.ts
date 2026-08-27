import { Schema } from "effect";
/**
 * Exported separately (not inlined into {@link CliConfigSchema}) so
 * `packages/config/src/io.ts` can decode it on its own with
 * `disableChecks: true`. Go's `Config.Validate` only ever checks
 * `remotes.*.project_id` format for every remote block
 * (`apps/cli-go/pkg/config/config.go:996-1001`, "Since remote config is merged
 * to base, we only need to validate the project_id field") — every other
 * business-rule check (`Auth.External.validate()`, `Auth.Sms.validate()`,
 * etc.) runs exactly once, against the merged effective config
 * (`config.go:1136-1152`), never iterated over `c.Remotes[*]`. Decoding this
 * schema normally (checks enabled) would apply those same business-rule
 * `.check()`s — embedded in `auth`/`db`/etc. — to every remote regardless of
 * selection, rejecting configs Go accepts (e.g. an unselected
 * `[remotes.prod.auth.external.github] enabled = true` stub with no secret).
 */
export declare const RemotesSchema: Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
    readonly project_id: Schema.withDecodingDefaultKey<Schema.String, never>;
    readonly analytics: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly backend: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly vector_port: Schema.optionalKey<Schema.Number>;
        readonly gcp_project_id: Schema.optionalKey<Schema.String>;
        readonly gcp_project_number: Schema.optionalKey<Schema.String>;
        readonly gcp_jwt_path: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly api: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly schemas: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly extra_search_path: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly max_rows: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly auto_expose_new_tables: Schema.optionalKey<Schema.Boolean>;
        readonly tls: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly cert_path: Schema.optionalKey<Schema.String>;
            readonly key_path: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly external_url: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly auth: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly site_url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly additional_redirect_urls: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly jwt_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly jwt_issuer: Schema.optionalKey<Schema.String>;
        readonly signing_keys_path: Schema.optionalKey<Schema.String>;
        readonly enable_refresh_token_rotation: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly refresh_token_reuse_interval: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly enable_manual_linking: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly enable_anonymous_sign_ins: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly minimum_password_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly password_requirements: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly publishable_key: Schema.optionalKey<Schema.String>;
        readonly secret_key: Schema.optionalKey<Schema.String>;
        readonly jwt_secret: Schema.optionalKey<Schema.String>;
        readonly anon_key: Schema.optionalKey<Schema.String>;
        readonly service_role_key: Schema.optionalKey<Schema.String>;
        readonly rate_limit: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly email_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly sms_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly anonymous_users: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly token_refresh: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly sign_in_sign_ups: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly token_verifications: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly web3: Schema.withDecodingDefaultKey<Schema.Number, never>;
        }>, never>;
        readonly captcha: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly provider: Schema.optionalKey<Schema.Literals<string[]>>;
            readonly secret: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly hook: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly mfa_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly password_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly custom_access_token: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly send_sms: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly send_email: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly before_user_created: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
        }>, never>;
        readonly mfa: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly totp: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly phone: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
            }>, never>;
            readonly web_authn: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly max_enrolled_factors: Schema.withDecodingDefaultKey<Schema.Number, never>;
        }>, never>;
        readonly sessions: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly timebox: Schema.optionalKey<Schema.String>;
            readonly inactivity_timeout: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly email: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly double_confirm_changes: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly secure_password_change: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly otp_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly smtp: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly host: Schema.optionalKey<Schema.String>;
                readonly port: Schema.optionalKey<Schema.Number>;
                readonly user: Schema.optionalKey<Schema.String>;
                readonly pass: Schema.optionalKey<Schema.String>;
                readonly admin_email: Schema.optionalKey<Schema.String>;
                readonly sender_name: Schema.optionalKey<Schema.String>;
            }>, never>>;
            readonly template: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
                readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
            }>, never>>, never>;
            readonly notification: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
            }>, never>>, never>;
        }>, never>;
        readonly sms: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly twilio: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly account_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly message_service_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly auth_token: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly twilio_verify: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly account_sid: Schema.optionalKey<Schema.String>;
                readonly message_service_sid: Schema.optionalKey<Schema.String>;
                readonly auth_token: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly messagebird: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly originator: Schema.optionalKey<Schema.String>;
                readonly access_key: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly textlocal: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly sender: Schema.optionalKey<Schema.String>;
                readonly api_key: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly vonage: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly from: Schema.optionalKey<Schema.String>;
                readonly api_key: Schema.optionalKey<Schema.String>;
                readonly api_secret: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly test_otp: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
        }>, never>;
        readonly external: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly apple: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly azure: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly bitbucket: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly discord: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly facebook: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly github: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly gitlab: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly google: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly kakao: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly keycloak: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly linkedin_oidc: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly notion: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly twitch: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly twitter: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly x: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly slack_oidc: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly spotify: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly workos: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly zoom: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
        }>, never>;
        readonly web3: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly solana: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly ethereum: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
        }>, never>;
        readonly oauth_server: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly authorization_url_path: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly allow_dynamic_registration: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>;
        readonly third_party: Schema.withDecodingDefaultKey<Schema.Struct<{
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
    }>, never>;
    readonly db: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly shadow_port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly health_timeout: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly major_version: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly pooler: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly pool_mode: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
            readonly default_pool_size: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly max_client_conn: Schema.withDecodingDefaultKey<Schema.Number, never>;
        }>, never>;
        readonly migrations: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly schema_paths: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        }>, never>;
        readonly seed: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly sql_paths: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        }>, never>;
        readonly settings: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly effective_cache_size: Schema.optionalKey<Schema.String>;
            readonly logical_decoding_work_mem: Schema.optionalKey<Schema.String>;
            readonly maintenance_work_mem: Schema.optionalKey<Schema.String>;
            readonly max_connections: Schema.optionalKey<Schema.Number>;
            readonly max_locks_per_transaction: Schema.optionalKey<Schema.Number>;
            readonly max_parallel_maintenance_workers: Schema.optionalKey<Schema.Number>;
            readonly max_parallel_workers: Schema.optionalKey<Schema.Number>;
            readonly max_parallel_workers_per_gather: Schema.optionalKey<Schema.Number>;
            readonly max_replication_slots: Schema.optionalKey<Schema.Number>;
            readonly max_slot_wal_keep_size: Schema.optionalKey<Schema.String>;
            readonly max_standby_archive_delay: Schema.optionalKey<Schema.String>;
            readonly max_standby_streaming_delay: Schema.optionalKey<Schema.String>;
            readonly max_wal_size: Schema.optionalKey<Schema.String>;
            readonly max_wal_senders: Schema.optionalKey<Schema.Number>;
            readonly max_worker_processes: Schema.optionalKey<Schema.Number>;
            readonly session_replication_role: Schema.optionalKey<Schema.Literals<string[]>>;
            readonly shared_buffers: Schema.optionalKey<Schema.String>;
            readonly statement_timeout: Schema.optionalKey<Schema.String>;
            readonly track_activity_query_size: Schema.optionalKey<Schema.String>;
            readonly track_commit_timestamp: Schema.optionalKey<Schema.Boolean>;
            readonly wal_keep_size: Schema.optionalKey<Schema.String>;
            readonly wal_sender_timeout: Schema.optionalKey<Schema.String>;
            readonly work_mem: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly network_restrictions: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly allowed_cidrs: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            readonly allowed_cidrs_v6: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        }>, never>;
        readonly ssl_enforcement: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>>;
        readonly vault: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
    }>, never>;
    readonly edge_runtime: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly policy: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly inspector_port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly deno_version: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly secrets: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
    }>, never>;
    readonly functions: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly verify_jwt: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly import_map: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly entrypoint: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly static_files: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly env: Schema.withDecodingDefaultKey<Schema.$Record<Schema.String, Schema.String>, never>;
    }>, never>>, never>;
    readonly local_smtp: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly smtp_port: Schema.optionalKey<Schema.Number>;
        readonly pop3_port: Schema.optionalKey<Schema.Number>;
        readonly admin_email: Schema.optionalKey<Schema.String>;
        readonly sender_name: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly realtime: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly ip_version: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly max_header_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
    }>, never>;
    readonly storage: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly file_size_limit: Schema.withDecodingDefaultKey<Schema.decodeTo<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number]>, never, never>, never>;
        readonly image_transformation: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>>;
        readonly buckets: Schema.optionalKey<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
            readonly public: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly file_size_limit: Schema.withDecodingDefaultKey<Schema.decodeTo<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number]>, never, never>, never>;
            readonly allowed_mime_types: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            readonly objects_path: Schema.withDecodingDefaultKey<Schema.String, never>;
        }>, never>>>;
        readonly s3_protocol: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>;
        readonly analytics: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly max_namespaces: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly max_tables: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly max_catalogs: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly buckets: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{}>, never>>, never>;
        }>, never>;
        readonly vector: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly max_buckets: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly max_indexes: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly buckets: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{}>, never>>, never>;
        }>, never>;
    }>, never>;
    readonly studio: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly api_url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly openai_api_key: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly workers: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.Struct<{
        readonly runtime: Schema.optionalKey<Schema.String>;
        readonly size: Schema.optionalKey<Schema.String>;
        readonly instances: Schema.optionalKey<Schema.Number>;
        readonly source: Schema.optionalKey<Schema.String>;
    }>>, never>;
    readonly experimental: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly orioledb_version: Schema.optionalKey<Schema.String>;
        readonly s3_host: Schema.optionalKey<Schema.String>;
        readonly s3_region: Schema.optionalKey<Schema.String>;
        readonly s3_access_key: Schema.optionalKey<Schema.String>;
        readonly s3_secret_key: Schema.optionalKey<Schema.String>;
        readonly webhooks: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>>;
        readonly pgdelta: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly declarative_schema_path: Schema.optionalKey<Schema.String>;
            readonly format_options: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly inspect: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly rules: Schema.withDecodingDefaultKey<Schema.$Array<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly query: Schema.optionalKey<Schema.String>;
                readonly name: Schema.optionalKey<Schema.String>;
                readonly pass: Schema.optionalKey<Schema.String>;
                readonly fail: Schema.optionalKey<Schema.String>;
            }>, never>>, never>;
        }>, never>>;
    }>, never>;
}>, never>>;
export declare const CliConfigSchema: Schema.Struct<{
    readonly project_id: Schema.optionalKey<Schema.String>;
    readonly analytics: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly backend: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly vector_port: Schema.optionalKey<Schema.Number>;
        readonly gcp_project_id: Schema.optionalKey<Schema.String>;
        readonly gcp_project_number: Schema.optionalKey<Schema.String>;
        readonly gcp_jwt_path: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly api: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly schemas: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly extra_search_path: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly max_rows: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly auto_expose_new_tables: Schema.optionalKey<Schema.Boolean>;
        readonly tls: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly cert_path: Schema.optionalKey<Schema.String>;
            readonly key_path: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly external_url: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly auth: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly site_url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly additional_redirect_urls: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly jwt_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly jwt_issuer: Schema.optionalKey<Schema.String>;
        readonly signing_keys_path: Schema.optionalKey<Schema.String>;
        readonly enable_refresh_token_rotation: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly refresh_token_reuse_interval: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly enable_manual_linking: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly enable_anonymous_sign_ins: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly minimum_password_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly password_requirements: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly publishable_key: Schema.optionalKey<Schema.String>;
        readonly secret_key: Schema.optionalKey<Schema.String>;
        readonly jwt_secret: Schema.optionalKey<Schema.String>;
        readonly anon_key: Schema.optionalKey<Schema.String>;
        readonly service_role_key: Schema.optionalKey<Schema.String>;
        readonly rate_limit: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly email_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly sms_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly anonymous_users: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly token_refresh: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly sign_in_sign_ups: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly token_verifications: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly web3: Schema.withDecodingDefaultKey<Schema.Number, never>;
        }>, never>;
        readonly captcha: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly provider: Schema.optionalKey<Schema.Literals<string[]>>;
            readonly secret: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly hook: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly mfa_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly password_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly custom_access_token: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly send_sms: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly send_email: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly before_user_created: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly uri: Schema.optionalKey<Schema.String>;
                readonly secrets: Schema.optionalKey<Schema.String>;
            }>, never>;
        }>, never>;
        readonly mfa: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly totp: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly phone: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
            }>, never>;
            readonly web_authn: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly max_enrolled_factors: Schema.withDecodingDefaultKey<Schema.Number, never>;
        }>, never>;
        readonly sessions: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly timebox: Schema.optionalKey<Schema.String>;
            readonly inactivity_timeout: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly email: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly double_confirm_changes: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly secure_password_change: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly otp_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly smtp: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly host: Schema.optionalKey<Schema.String>;
                readonly port: Schema.optionalKey<Schema.Number>;
                readonly user: Schema.optionalKey<Schema.String>;
                readonly pass: Schema.optionalKey<Schema.String>;
                readonly admin_email: Schema.optionalKey<Schema.String>;
                readonly sender_name: Schema.optionalKey<Schema.String>;
            }>, never>>;
            readonly template: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
                readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
            }>, never>>, never>;
            readonly notification: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
            }>, never>>, never>;
        }>, never>;
        readonly sms: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly twilio: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly account_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly message_service_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly auth_token: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly twilio_verify: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly account_sid: Schema.optionalKey<Schema.String>;
                readonly message_service_sid: Schema.optionalKey<Schema.String>;
                readonly auth_token: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly messagebird: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly originator: Schema.optionalKey<Schema.String>;
                readonly access_key: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly textlocal: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly sender: Schema.optionalKey<Schema.String>;
                readonly api_key: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly vonage: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly from: Schema.optionalKey<Schema.String>;
                readonly api_key: Schema.optionalKey<Schema.String>;
                readonly api_secret: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly test_otp: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
        }>, never>;
        readonly external: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly apple: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly azure: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly bitbucket: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly discord: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly facebook: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly github: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly gitlab: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly google: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly kakao: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly keycloak: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly linkedin_oidc: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly notion: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly twitch: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly twitter: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly x: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly slack_oidc: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly spotify: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly workos: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly zoom: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly secret: Schema.optionalKey<Schema.String>;
                readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
        }>, never>;
        readonly web3: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly solana: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly ethereum: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
        }>, never>;
        readonly oauth_server: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly authorization_url_path: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly allow_dynamic_registration: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>;
        readonly third_party: Schema.withDecodingDefaultKey<Schema.Struct<{
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
    }>, never>;
    readonly db: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly shadow_port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly health_timeout: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly major_version: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly pooler: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly pool_mode: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
            readonly default_pool_size: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly max_client_conn: Schema.withDecodingDefaultKey<Schema.Number, never>;
        }>, never>;
        readonly migrations: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly schema_paths: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        }>, never>;
        readonly seed: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly sql_paths: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        }>, never>;
        readonly settings: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly effective_cache_size: Schema.optionalKey<Schema.String>;
            readonly logical_decoding_work_mem: Schema.optionalKey<Schema.String>;
            readonly maintenance_work_mem: Schema.optionalKey<Schema.String>;
            readonly max_connections: Schema.optionalKey<Schema.Number>;
            readonly max_locks_per_transaction: Schema.optionalKey<Schema.Number>;
            readonly max_parallel_maintenance_workers: Schema.optionalKey<Schema.Number>;
            readonly max_parallel_workers: Schema.optionalKey<Schema.Number>;
            readonly max_parallel_workers_per_gather: Schema.optionalKey<Schema.Number>;
            readonly max_replication_slots: Schema.optionalKey<Schema.Number>;
            readonly max_slot_wal_keep_size: Schema.optionalKey<Schema.String>;
            readonly max_standby_archive_delay: Schema.optionalKey<Schema.String>;
            readonly max_standby_streaming_delay: Schema.optionalKey<Schema.String>;
            readonly max_wal_size: Schema.optionalKey<Schema.String>;
            readonly max_wal_senders: Schema.optionalKey<Schema.Number>;
            readonly max_worker_processes: Schema.optionalKey<Schema.Number>;
            readonly session_replication_role: Schema.optionalKey<Schema.Literals<string[]>>;
            readonly shared_buffers: Schema.optionalKey<Schema.String>;
            readonly statement_timeout: Schema.optionalKey<Schema.String>;
            readonly track_activity_query_size: Schema.optionalKey<Schema.String>;
            readonly track_commit_timestamp: Schema.optionalKey<Schema.Boolean>;
            readonly wal_keep_size: Schema.optionalKey<Schema.String>;
            readonly wal_sender_timeout: Schema.optionalKey<Schema.String>;
            readonly work_mem: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly network_restrictions: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly allowed_cidrs: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            readonly allowed_cidrs_v6: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        }>, never>;
        readonly ssl_enforcement: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>>;
        readonly vault: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
    }>, never>;
    readonly edge_runtime: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly policy: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly inspector_port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly deno_version: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly secrets: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
    }>, never>;
    readonly functions: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly verify_jwt: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly import_map: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly entrypoint: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly static_files: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
        readonly env: Schema.withDecodingDefaultKey<Schema.$Record<Schema.String, Schema.String>, never>;
    }>, never>>, never>;
    readonly local_smtp: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly smtp_port: Schema.optionalKey<Schema.Number>;
        readonly pop3_port: Schema.optionalKey<Schema.Number>;
        readonly admin_email: Schema.optionalKey<Schema.String>;
        readonly sender_name: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly realtime: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly ip_version: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
        readonly max_header_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
    }>, never>;
    readonly storage: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly file_size_limit: Schema.withDecodingDefaultKey<Schema.decodeTo<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number]>, never, never>, never>;
        readonly image_transformation: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>>;
        readonly buckets: Schema.optionalKey<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
            readonly public: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly file_size_limit: Schema.withDecodingDefaultKey<Schema.decodeTo<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number]>, never, never>, never>;
            readonly allowed_mime_types: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            readonly objects_path: Schema.withDecodingDefaultKey<Schema.String, never>;
        }>, never>>>;
        readonly s3_protocol: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>;
        readonly analytics: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly max_namespaces: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly max_tables: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly max_catalogs: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly buckets: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{}>, never>>, never>;
        }>, never>;
        readonly vector: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly max_buckets: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly max_indexes: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly buckets: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{}>, never>>, never>;
        }>, never>;
    }>, never>;
    readonly studio: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
        readonly api_url: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly openai_api_key: Schema.optionalKey<Schema.String>;
    }>, never>;
    readonly workers: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.Struct<{
        readonly runtime: Schema.optionalKey<Schema.String>;
        readonly size: Schema.optionalKey<Schema.String>;
        readonly instances: Schema.optionalKey<Schema.Number>;
        readonly source: Schema.optionalKey<Schema.String>;
    }>>, never>;
    readonly experimental: Schema.withDecodingDefaultKey<Schema.Struct<{
        readonly orioledb_version: Schema.optionalKey<Schema.String>;
        readonly s3_host: Schema.optionalKey<Schema.String>;
        readonly s3_region: Schema.optionalKey<Schema.String>;
        readonly s3_access_key: Schema.optionalKey<Schema.String>;
        readonly s3_secret_key: Schema.optionalKey<Schema.String>;
        readonly webhooks: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
        }>, never>>;
        readonly pgdelta: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly declarative_schema_path: Schema.optionalKey<Schema.String>;
            readonly format_options: Schema.optionalKey<Schema.String>;
        }>, never>>;
        readonly inspect: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly rules: Schema.withDecodingDefaultKey<Schema.$Array<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly query: Schema.optionalKey<Schema.String>;
                readonly name: Schema.optionalKey<Schema.String>;
                readonly pass: Schema.optionalKey<Schema.String>;
                readonly fail: Schema.optionalKey<Schema.String>;
            }>, never>>, never>;
        }>, never>>;
    }>, never>;
    readonly remotes: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
        readonly project_id: Schema.withDecodingDefaultKey<Schema.String, never>;
        readonly analytics: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly backend: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
            readonly vector_port: Schema.optionalKey<Schema.Number>;
            readonly gcp_project_id: Schema.optionalKey<Schema.String>;
            readonly gcp_project_number: Schema.optionalKey<Schema.String>;
            readonly gcp_jwt_path: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly api: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly schemas: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            readonly extra_search_path: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            readonly max_rows: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly auto_expose_new_tables: Schema.optionalKey<Schema.Boolean>;
            readonly tls: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly cert_path: Schema.optionalKey<Schema.String>;
                readonly key_path: Schema.optionalKey<Schema.String>;
            }>, never>;
            readonly external_url: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly auth: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly site_url: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly additional_redirect_urls: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            readonly jwt_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly jwt_issuer: Schema.optionalKey<Schema.String>;
            readonly signing_keys_path: Schema.optionalKey<Schema.String>;
            readonly enable_refresh_token_rotation: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly refresh_token_reuse_interval: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly enable_manual_linking: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly enable_anonymous_sign_ins: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly minimum_password_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly password_requirements: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
            readonly publishable_key: Schema.optionalKey<Schema.String>;
            readonly secret_key: Schema.optionalKey<Schema.String>;
            readonly jwt_secret: Schema.optionalKey<Schema.String>;
            readonly anon_key: Schema.optionalKey<Schema.String>;
            readonly service_role_key: Schema.optionalKey<Schema.String>;
            readonly rate_limit: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly email_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly sms_sent: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly anonymous_users: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly token_refresh: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly sign_in_sign_ups: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly token_verifications: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly web3: Schema.withDecodingDefaultKey<Schema.Number, never>;
            }>, never>;
            readonly captcha: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly provider: Schema.optionalKey<Schema.Literals<string[]>>;
                readonly secret: Schema.optionalKey<Schema.String>;
            }>, never>>;
            readonly hook: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly mfa_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly uri: Schema.optionalKey<Schema.String>;
                    readonly secrets: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly password_verification_attempt: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly uri: Schema.optionalKey<Schema.String>;
                    readonly secrets: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly custom_access_token: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly uri: Schema.optionalKey<Schema.String>;
                    readonly secrets: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly send_sms: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly uri: Schema.optionalKey<Schema.String>;
                    readonly secrets: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly send_email: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly uri: Schema.optionalKey<Schema.String>;
                    readonly secrets: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly before_user_created: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly uri: Schema.optionalKey<Schema.String>;
                    readonly secrets: Schema.optionalKey<Schema.String>;
                }>, never>;
            }>, never>;
            readonly mfa: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly totp: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly phone: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
                    readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
                }>, never>;
                readonly web_authn: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enroll_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly verify_enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly max_enrolled_factors: Schema.withDecodingDefaultKey<Schema.Number, never>;
            }>, never>;
            readonly sessions: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly timebox: Schema.optionalKey<Schema.String>;
                readonly inactivity_timeout: Schema.optionalKey<Schema.String>;
            }>, never>>;
            readonly email: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly double_confirm_changes: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly secure_password_change: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly otp_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly otp_expiry: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly smtp: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly host: Schema.optionalKey<Schema.String>;
                    readonly port: Schema.optionalKey<Schema.Number>;
                    readonly user: Schema.optionalKey<Schema.String>;
                    readonly pass: Schema.optionalKey<Schema.String>;
                    readonly admin_email: Schema.optionalKey<Schema.String>;
                    readonly sender_name: Schema.optionalKey<Schema.String>;
                }>, never>>;
                readonly template: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
                    readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
                }>, never>>, never>;
                readonly notification: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly subject: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly content_path: Schema.withDecodingDefaultKey<Schema.String, never>;
                }>, never>>, never>;
            }>, never>;
            readonly sms: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enable_signup: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly enable_confirmations: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly template: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly max_frequency: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly twilio: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly account_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly message_service_sid: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly auth_token: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly twilio_verify: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly account_sid: Schema.optionalKey<Schema.String>;
                    readonly message_service_sid: Schema.optionalKey<Schema.String>;
                    readonly auth_token: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly messagebird: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly originator: Schema.optionalKey<Schema.String>;
                    readonly access_key: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly textlocal: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly sender: Schema.optionalKey<Schema.String>;
                    readonly api_key: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly vonage: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly from: Schema.optionalKey<Schema.String>;
                    readonly api_key: Schema.optionalKey<Schema.String>;
                    readonly api_secret: Schema.optionalKey<Schema.String>;
                }>, never>;
                readonly test_otp: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
            }>, never>;
            readonly external: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly apple: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly azure: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly bitbucket: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly discord: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly facebook: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly github: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly gitlab: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly google: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly kakao: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly keycloak: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly linkedin_oidc: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly notion: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly twitch: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly twitter: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly x: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly slack_oidc: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly spotify: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly workos: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly zoom: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly client_id: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly secret: Schema.optionalKey<Schema.String>;
                    readonly url: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly redirect_uri: Schema.withDecodingDefaultKey<Schema.String, never>;
                    readonly skip_nonce_check: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                    readonly email_optional: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
            }>, never>;
            readonly web3: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly solana: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
                readonly ethereum: Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                }>, never>;
            }>, never>;
            readonly oauth_server: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly authorization_url_path: Schema.withDecodingDefaultKey<Schema.String, never>;
                readonly allow_dynamic_registration: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly third_party: Schema.withDecodingDefaultKey<Schema.Struct<{
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
        }>, never>;
        readonly db: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly shadow_port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly health_timeout: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly major_version: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly pooler: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly pool_mode: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
                readonly default_pool_size: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly max_client_conn: Schema.withDecodingDefaultKey<Schema.Number, never>;
            }>, never>;
            readonly migrations: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly schema_paths: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            }>, never>;
            readonly seed: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly sql_paths: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            }>, never>;
            readonly settings: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly effective_cache_size: Schema.optionalKey<Schema.String>;
                readonly logical_decoding_work_mem: Schema.optionalKey<Schema.String>;
                readonly maintenance_work_mem: Schema.optionalKey<Schema.String>;
                readonly max_connections: Schema.optionalKey<Schema.Number>;
                readonly max_locks_per_transaction: Schema.optionalKey<Schema.Number>;
                readonly max_parallel_maintenance_workers: Schema.optionalKey<Schema.Number>;
                readonly max_parallel_workers: Schema.optionalKey<Schema.Number>;
                readonly max_parallel_workers_per_gather: Schema.optionalKey<Schema.Number>;
                readonly max_replication_slots: Schema.optionalKey<Schema.Number>;
                readonly max_slot_wal_keep_size: Schema.optionalKey<Schema.String>;
                readonly max_standby_archive_delay: Schema.optionalKey<Schema.String>;
                readonly max_standby_streaming_delay: Schema.optionalKey<Schema.String>;
                readonly max_wal_size: Schema.optionalKey<Schema.String>;
                readonly max_wal_senders: Schema.optionalKey<Schema.Number>;
                readonly max_worker_processes: Schema.optionalKey<Schema.Number>;
                readonly session_replication_role: Schema.optionalKey<Schema.Literals<string[]>>;
                readonly shared_buffers: Schema.optionalKey<Schema.String>;
                readonly statement_timeout: Schema.optionalKey<Schema.String>;
                readonly track_activity_query_size: Schema.optionalKey<Schema.String>;
                readonly track_commit_timestamp: Schema.optionalKey<Schema.Boolean>;
                readonly wal_keep_size: Schema.optionalKey<Schema.String>;
                readonly wal_sender_timeout: Schema.optionalKey<Schema.String>;
                readonly work_mem: Schema.optionalKey<Schema.String>;
            }>, never>>;
            readonly network_restrictions: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly allowed_cidrs: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
                readonly allowed_cidrs_v6: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            }>, never>;
            readonly ssl_enforcement: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>>;
            readonly vault: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
        }>, never>;
        readonly edge_runtime: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly policy: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
            readonly inspector_port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly deno_version: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly secrets: Schema.optionalKey<Schema.$Record<Schema.String, Schema.String>>;
        }>, never>;
        readonly functions: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly verify_jwt: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly import_map: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly entrypoint: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly static_files: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
            readonly env: Schema.withDecodingDefaultKey<Schema.$Record<Schema.String, Schema.String>, never>;
        }>, never>>, never>;
        readonly local_smtp: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly smtp_port: Schema.optionalKey<Schema.Number>;
            readonly pop3_port: Schema.optionalKey<Schema.Number>;
            readonly admin_email: Schema.optionalKey<Schema.String>;
            readonly sender_name: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly realtime: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly ip_version: Schema.withDecodingDefaultKey<Schema.Literals<string[]>, never>;
            readonly max_header_length: Schema.withDecodingDefaultKey<Schema.Number, never>;
        }>, never>;
        readonly storage: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly file_size_limit: Schema.withDecodingDefaultKey<Schema.decodeTo<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number]>, never, never>, never>;
            readonly image_transformation: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>>;
            readonly buckets: Schema.optionalKey<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{
                readonly public: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly file_size_limit: Schema.withDecodingDefaultKey<Schema.decodeTo<Schema.String, Schema.Union<readonly [Schema.String, Schema.Number]>, never, never>, never>;
                readonly allowed_mime_types: Schema.withDecodingDefaultKey<Schema.$Array<Schema.String>, never>;
                readonly objects_path: Schema.withDecodingDefaultKey<Schema.String, never>;
            }>, never>>>;
            readonly s3_protocol: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>;
            readonly analytics: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly max_namespaces: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly max_tables: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly max_catalogs: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly buckets: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{}>, never>>, never>;
            }>, never>;
            readonly vector: Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly max_buckets: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly max_indexes: Schema.withDecodingDefaultKey<Schema.Number, never>;
                readonly buckets: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.withDecodingDefault<Schema.Struct<{}>, never>>, never>;
            }>, never>;
        }>, never>;
        readonly studio: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            readonly port: Schema.withDecodingDefaultKey<Schema.Number, never>;
            readonly api_url: Schema.withDecodingDefaultKey<Schema.String, never>;
            readonly openai_api_key: Schema.optionalKey<Schema.String>;
        }>, never>;
        readonly workers: Schema.withDecodingDefault<Schema.$Record<Schema.String, Schema.Struct<{
            readonly runtime: Schema.optionalKey<Schema.String>;
            readonly size: Schema.optionalKey<Schema.String>;
            readonly instances: Schema.optionalKey<Schema.Number>;
            readonly source: Schema.optionalKey<Schema.String>;
        }>>, never>;
        readonly experimental: Schema.withDecodingDefaultKey<Schema.Struct<{
            readonly orioledb_version: Schema.optionalKey<Schema.String>;
            readonly s3_host: Schema.optionalKey<Schema.String>;
            readonly s3_region: Schema.optionalKey<Schema.String>;
            readonly s3_access_key: Schema.optionalKey<Schema.String>;
            readonly s3_secret_key: Schema.optionalKey<Schema.String>;
            readonly webhooks: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
            }>, never>>;
            readonly pgdelta: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly enabled: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
                readonly declarative_schema_path: Schema.optionalKey<Schema.String>;
                readonly format_options: Schema.optionalKey<Schema.String>;
            }>, never>>;
            readonly inspect: Schema.optionalKey<Schema.withDecodingDefaultKey<Schema.Struct<{
                readonly rules: Schema.withDecodingDefaultKey<Schema.$Array<Schema.withDecodingDefaultKey<Schema.Struct<{
                    readonly query: Schema.optionalKey<Schema.String>;
                    readonly name: Schema.optionalKey<Schema.String>;
                    readonly pass: Schema.optionalKey<Schema.String>;
                    readonly fail: Schema.optionalKey<Schema.String>;
                }>, never>>, never>;
            }>, never>>;
        }>, never>;
    }>, never>>, never>;
}>;
export declare function toCliConfigJsonSchema(): {
    $schema: string;
    $defs?: import("effect/JsonSchema").Definitions | undefined;
};
export type CliConfig = typeof CliConfigSchema.Type;
export type CliConfigJson = typeof CliConfigSchema.Encoded;
