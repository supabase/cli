import { Effect, FileSystem, Path } from "effect";
import { type InternalLoadCliConfigOptions, type CliConfigValueSource, type SaveCliConfigOptions } from "./config-document.ts";
import type { ConfigFormat } from "./config-format.ts";
import { DuplicateRemoteProjectIdError, InvalidRemoteProjectIdError, CliConfigParseError } from "./errors.ts";
export declare const configJsonPath: (cwd: string) => Effect.Effect<string, never, FileSystem.FileSystem | Path.Path>;
export declare const configTomlPath: (cwd: string) => Effect.Effect<string, never, FileSystem.FileSystem | Path.Path>;
export declare const loadCliConfigFile: (filePath: string, options?: InternalLoadCliConfigOptions | undefined) => Effect.Effect<{
    path: string;
    format: "json" | "toml";
    config: {
        readonly project_id?: string | undefined;
        readonly analytics: {
            readonly enabled: boolean;
            readonly port: number;
            readonly backend: string;
            readonly vector_port?: number | undefined;
            readonly gcp_project_id?: string | undefined;
            readonly gcp_project_number?: string | undefined;
            readonly gcp_jwt_path?: string | undefined;
        };
        readonly api: {
            readonly enabled: boolean;
            readonly port: number;
            readonly schemas: readonly string[];
            readonly extra_search_path: readonly string[];
            readonly max_rows: number;
            readonly auto_expose_new_tables?: boolean | undefined;
            readonly tls: {
                readonly enabled: boolean;
                readonly cert_path?: string | undefined;
                readonly key_path?: string | undefined;
            };
            readonly external_url?: string | undefined;
        };
        readonly auth: {
            readonly enabled: boolean;
            readonly site_url: string;
            readonly additional_redirect_urls: readonly string[];
            readonly jwt_expiry: number;
            readonly jwt_issuer?: string | undefined;
            readonly signing_keys_path?: string | undefined;
            readonly enable_refresh_token_rotation: boolean;
            readonly refresh_token_reuse_interval: number;
            readonly enable_manual_linking: boolean;
            readonly enable_signup: boolean;
            readonly enable_anonymous_sign_ins: boolean;
            readonly minimum_password_length: number;
            readonly password_requirements: string;
            readonly publishable_key?: string | undefined;
            readonly secret_key?: string | undefined;
            readonly jwt_secret?: string | undefined;
            readonly anon_key?: string | undefined;
            readonly service_role_key?: string | undefined;
            readonly rate_limit: {
                readonly email_sent: number;
                readonly sms_sent: number;
                readonly anonymous_users: number;
                readonly token_refresh: number;
                readonly sign_in_sign_ups: number;
                readonly token_verifications: number;
                readonly web3: number;
            };
            readonly captcha?: {
                readonly enabled: boolean;
                readonly provider?: string | undefined;
                readonly secret?: string | undefined;
            } | undefined;
            readonly hook: {
                readonly mfa_verification_attempt: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly password_verification_attempt: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly custom_access_token: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly send_sms: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly send_email: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly before_user_created: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
            };
            readonly mfa: {
                readonly totp: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                };
                readonly phone: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                    readonly otp_length: number;
                    readonly template: string;
                    readonly max_frequency: string;
                };
                readonly web_authn: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                };
                readonly max_enrolled_factors: number;
            };
            readonly sessions?: {
                readonly timebox?: string | undefined;
                readonly inactivity_timeout?: string | undefined;
            } | undefined;
            readonly email: {
                readonly enable_signup: boolean;
                readonly double_confirm_changes: boolean;
                readonly enable_confirmations: boolean;
                readonly secure_password_change: boolean;
                readonly max_frequency: string;
                readonly otp_length: number;
                readonly otp_expiry: number;
                readonly smtp?: {
                    readonly enabled: boolean;
                    readonly host?: string | undefined;
                    readonly port?: number | undefined;
                    readonly user?: string | undefined;
                    readonly pass?: string | undefined;
                    readonly admin_email?: string | undefined;
                    readonly sender_name?: string | undefined;
                } | undefined;
                readonly template: {
                    readonly [x: string]: {
                        readonly subject: string;
                        readonly content_path: string;
                    };
                };
                readonly notification: {
                    readonly [x: string]: {
                        readonly enabled: boolean;
                        readonly subject: string;
                        readonly content_path: string;
                    };
                };
            };
            readonly sms: {
                readonly enable_signup: boolean;
                readonly enable_confirmations: boolean;
                readonly template: string;
                readonly max_frequency: string;
                readonly twilio: {
                    readonly enabled: boolean;
                    readonly account_sid: string;
                    readonly message_service_sid: string;
                    readonly auth_token?: string | undefined;
                };
                readonly twilio_verify: {
                    readonly enabled: boolean;
                    readonly account_sid?: string | undefined;
                    readonly message_service_sid?: string | undefined;
                    readonly auth_token?: string | undefined;
                };
                readonly messagebird: {
                    readonly enabled: boolean;
                    readonly originator?: string | undefined;
                    readonly access_key?: string | undefined;
                };
                readonly textlocal: {
                    readonly enabled: boolean;
                    readonly sender?: string | undefined;
                    readonly api_key?: string | undefined;
                };
                readonly vonage: {
                    readonly enabled: boolean;
                    readonly from?: string | undefined;
                    readonly api_key?: string | undefined;
                    readonly api_secret?: string | undefined;
                };
                readonly test_otp?: {
                    readonly [x: string]: string;
                } | undefined;
            };
            readonly external: {
                readonly apple: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly azure: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly bitbucket: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly discord: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly facebook: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly github: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly gitlab: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly google: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly kakao: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly keycloak: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly linkedin_oidc: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly notion: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly twitch: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly twitter: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly x: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly slack_oidc: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly spotify: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly workos: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly zoom: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
            };
            readonly web3: {
                readonly solana: {
                    readonly enabled: boolean;
                };
                readonly ethereum: {
                    readonly enabled: boolean;
                };
            };
            readonly oauth_server: {
                readonly enabled: boolean;
                readonly authorization_url_path: string;
                readonly allow_dynamic_registration: boolean;
            };
            readonly third_party: {
                readonly firebase: {
                    readonly enabled: boolean;
                    readonly project_id?: string | undefined;
                };
                readonly auth0: {
                    readonly enabled: boolean;
                    readonly tenant?: string | undefined;
                    readonly tenant_region?: string | undefined;
                };
                readonly aws_cognito: {
                    readonly enabled: boolean;
                    readonly user_pool_id?: string | undefined;
                    readonly user_pool_region?: string | undefined;
                };
                readonly clerk: {
                    readonly enabled: boolean;
                    readonly domain?: string | undefined;
                };
                readonly workos: {
                    readonly enabled: boolean;
                    readonly issuer_url?: string | undefined;
                };
            };
        };
        readonly db: {
            readonly port: number;
            readonly shadow_port: number;
            readonly health_timeout: string;
            readonly major_version: number;
            readonly pooler: {
                readonly enabled: boolean;
                readonly port: number;
                readonly pool_mode: string;
                readonly default_pool_size: number;
                readonly max_client_conn: number;
            };
            readonly migrations: {
                readonly enabled: boolean;
                readonly schema_paths: readonly string[];
            };
            readonly seed: {
                readonly enabled: boolean;
                readonly sql_paths: readonly string[];
            };
            readonly settings?: {
                readonly effective_cache_size?: string | undefined;
                readonly logical_decoding_work_mem?: string | undefined;
                readonly maintenance_work_mem?: string | undefined;
                readonly max_connections?: number | undefined;
                readonly max_locks_per_transaction?: number | undefined;
                readonly max_parallel_maintenance_workers?: number | undefined;
                readonly max_parallel_workers?: number | undefined;
                readonly max_parallel_workers_per_gather?: number | undefined;
                readonly max_replication_slots?: number | undefined;
                readonly max_slot_wal_keep_size?: string | undefined;
                readonly max_standby_archive_delay?: string | undefined;
                readonly max_standby_streaming_delay?: string | undefined;
                readonly max_wal_size?: string | undefined;
                readonly max_wal_senders?: number | undefined;
                readonly max_worker_processes?: number | undefined;
                readonly session_replication_role?: string | undefined;
                readonly shared_buffers?: string | undefined;
                readonly statement_timeout?: string | undefined;
                readonly track_activity_query_size?: string | undefined;
                readonly track_commit_timestamp?: boolean | undefined;
                readonly wal_keep_size?: string | undefined;
                readonly wal_sender_timeout?: string | undefined;
                readonly work_mem?: string | undefined;
            } | undefined;
            readonly network_restrictions: {
                readonly enabled: boolean;
                readonly allowed_cidrs: readonly string[];
                readonly allowed_cidrs_v6: readonly string[];
            };
            readonly ssl_enforcement?: {
                readonly enabled: boolean;
            } | undefined;
            readonly vault?: {
                readonly [x: string]: string;
            } | undefined;
        };
        readonly edge_runtime: {
            readonly enabled: boolean;
            readonly policy: string;
            readonly inspector_port: number;
            readonly deno_version: number;
            readonly secrets?: {
                readonly [x: string]: string;
            } | undefined;
        };
        readonly functions: {
            readonly [x: string]: {
                readonly enabled: boolean;
                readonly verify_jwt: boolean;
                readonly import_map: string;
                readonly entrypoint: string;
                readonly static_files: readonly string[];
                readonly env: {
                    readonly [x: string]: string;
                };
            };
        };
        readonly local_smtp: {
            readonly enabled: boolean;
            readonly port: number;
            readonly smtp_port?: number | undefined;
            readonly pop3_port?: number | undefined;
            readonly admin_email?: string | undefined;
            readonly sender_name?: string | undefined;
        };
        readonly realtime: {
            readonly enabled: boolean;
            readonly ip_version: string;
            readonly max_header_length: number;
        };
        readonly storage: {
            readonly enabled: boolean;
            readonly file_size_limit: string;
            readonly image_transformation?: {
                readonly enabled: boolean;
            } | undefined;
            readonly buckets?: {
                readonly [x: string]: {
                    readonly public: boolean;
                    readonly file_size_limit: string;
                    readonly allowed_mime_types: readonly string[];
                    readonly objects_path: string;
                };
            } | undefined;
            readonly s3_protocol: {
                readonly enabled: boolean;
            };
            readonly analytics: {
                readonly enabled: boolean;
                readonly max_namespaces: number;
                readonly max_tables: number;
                readonly max_catalogs: number;
                readonly buckets: {
                    readonly [x: string]: {};
                };
            };
            readonly vector: {
                readonly enabled: boolean;
                readonly max_buckets: number;
                readonly max_indexes: number;
                readonly buckets: {
                    readonly [x: string]: {};
                };
            };
        };
        readonly studio: {
            readonly enabled: boolean;
            readonly port: number;
            readonly api_url: string;
            readonly openai_api_key?: string | undefined;
        };
        readonly workers: {
            readonly [x: string]: {
                readonly runtime?: string | undefined;
                readonly size?: string | undefined;
                readonly instances?: number | undefined;
                readonly source?: string | undefined;
            };
        };
        readonly experimental: {
            readonly orioledb_version?: string | undefined;
            readonly s3_host?: string | undefined;
            readonly s3_region?: string | undefined;
            readonly s3_access_key?: string | undefined;
            readonly s3_secret_key?: string | undefined;
            readonly webhooks?: {
                readonly enabled: boolean;
            } | undefined;
            readonly pgdelta?: {
                readonly enabled: boolean;
                readonly declarative_schema_path?: string | undefined;
                readonly format_options?: string | undefined;
            } | undefined;
            readonly inspect?: {
                readonly rules: readonly {
                    readonly query?: string | undefined;
                    readonly name?: string | undefined;
                    readonly pass?: string | undefined;
                    readonly fail?: string | undefined;
                }[];
            } | undefined;
        };
        readonly remotes: {
            readonly [x: string]: {
                readonly project_id: string;
                readonly analytics: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly backend: string;
                    readonly vector_port?: number | undefined;
                    readonly gcp_project_id?: string | undefined;
                    readonly gcp_project_number?: string | undefined;
                    readonly gcp_jwt_path?: string | undefined;
                };
                readonly api: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly schemas: readonly string[];
                    readonly extra_search_path: readonly string[];
                    readonly max_rows: number;
                    readonly auto_expose_new_tables?: boolean | undefined;
                    readonly tls: {
                        readonly enabled: boolean;
                        readonly cert_path?: string | undefined;
                        readonly key_path?: string | undefined;
                    };
                    readonly external_url?: string | undefined;
                };
                readonly auth: {
                    readonly enabled: boolean;
                    readonly site_url: string;
                    readonly additional_redirect_urls: readonly string[];
                    readonly jwt_expiry: number;
                    readonly jwt_issuer?: string | undefined;
                    readonly signing_keys_path?: string | undefined;
                    readonly enable_refresh_token_rotation: boolean;
                    readonly refresh_token_reuse_interval: number;
                    readonly enable_manual_linking: boolean;
                    readonly enable_signup: boolean;
                    readonly enable_anonymous_sign_ins: boolean;
                    readonly minimum_password_length: number;
                    readonly password_requirements: string;
                    readonly publishable_key?: string | undefined;
                    readonly secret_key?: string | undefined;
                    readonly jwt_secret?: string | undefined;
                    readonly anon_key?: string | undefined;
                    readonly service_role_key?: string | undefined;
                    readonly rate_limit: {
                        readonly email_sent: number;
                        readonly sms_sent: number;
                        readonly anonymous_users: number;
                        readonly token_refresh: number;
                        readonly sign_in_sign_ups: number;
                        readonly token_verifications: number;
                        readonly web3: number;
                    };
                    readonly captcha?: {
                        readonly enabled: boolean;
                        readonly provider?: string | undefined;
                        readonly secret?: string | undefined;
                    } | undefined;
                    readonly hook: {
                        readonly mfa_verification_attempt: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly password_verification_attempt: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly custom_access_token: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly send_sms: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly send_email: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly before_user_created: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                    };
                    readonly mfa: {
                        readonly totp: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                        };
                        readonly phone: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                            readonly otp_length: number;
                            readonly template: string;
                            readonly max_frequency: string;
                        };
                        readonly web_authn: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                        };
                        readonly max_enrolled_factors: number;
                    };
                    readonly sessions?: {
                        readonly timebox?: string | undefined;
                        readonly inactivity_timeout?: string | undefined;
                    } | undefined;
                    readonly email: {
                        readonly enable_signup: boolean;
                        readonly double_confirm_changes: boolean;
                        readonly enable_confirmations: boolean;
                        readonly secure_password_change: boolean;
                        readonly max_frequency: string;
                        readonly otp_length: number;
                        readonly otp_expiry: number;
                        readonly smtp?: {
                            readonly enabled: boolean;
                            readonly host?: string | undefined;
                            readonly port?: number | undefined;
                            readonly user?: string | undefined;
                            readonly pass?: string | undefined;
                            readonly admin_email?: string | undefined;
                            readonly sender_name?: string | undefined;
                        } | undefined;
                        readonly template: {
                            readonly [x: string]: {
                                readonly subject: string;
                                readonly content_path: string;
                            };
                        };
                        readonly notification: {
                            readonly [x: string]: {
                                readonly enabled: boolean;
                                readonly subject: string;
                                readonly content_path: string;
                            };
                        };
                    };
                    readonly sms: {
                        readonly enable_signup: boolean;
                        readonly enable_confirmations: boolean;
                        readonly template: string;
                        readonly max_frequency: string;
                        readonly twilio: {
                            readonly enabled: boolean;
                            readonly account_sid: string;
                            readonly message_service_sid: string;
                            readonly auth_token?: string | undefined;
                        };
                        readonly twilio_verify: {
                            readonly enabled: boolean;
                            readonly account_sid?: string | undefined;
                            readonly message_service_sid?: string | undefined;
                            readonly auth_token?: string | undefined;
                        };
                        readonly messagebird: {
                            readonly enabled: boolean;
                            readonly originator?: string | undefined;
                            readonly access_key?: string | undefined;
                        };
                        readonly textlocal: {
                            readonly enabled: boolean;
                            readonly sender?: string | undefined;
                            readonly api_key?: string | undefined;
                        };
                        readonly vonage: {
                            readonly enabled: boolean;
                            readonly from?: string | undefined;
                            readonly api_key?: string | undefined;
                            readonly api_secret?: string | undefined;
                        };
                        readonly test_otp?: {
                            readonly [x: string]: string;
                        } | undefined;
                    };
                    readonly external: {
                        readonly apple: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly azure: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly bitbucket: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly discord: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly facebook: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly github: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly gitlab: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly google: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly kakao: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly keycloak: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly linkedin_oidc: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly notion: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly twitch: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly twitter: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly x: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly slack_oidc: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly spotify: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly workos: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly zoom: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                    };
                    readonly web3: {
                        readonly solana: {
                            readonly enabled: boolean;
                        };
                        readonly ethereum: {
                            readonly enabled: boolean;
                        };
                    };
                    readonly oauth_server: {
                        readonly enabled: boolean;
                        readonly authorization_url_path: string;
                        readonly allow_dynamic_registration: boolean;
                    };
                    readonly third_party: {
                        readonly firebase: {
                            readonly enabled: boolean;
                            readonly project_id?: string | undefined;
                        };
                        readonly auth0: {
                            readonly enabled: boolean;
                            readonly tenant?: string | undefined;
                            readonly tenant_region?: string | undefined;
                        };
                        readonly aws_cognito: {
                            readonly enabled: boolean;
                            readonly user_pool_id?: string | undefined;
                            readonly user_pool_region?: string | undefined;
                        };
                        readonly clerk: {
                            readonly enabled: boolean;
                            readonly domain?: string | undefined;
                        };
                        readonly workos: {
                            readonly enabled: boolean;
                            readonly issuer_url?: string | undefined;
                        };
                    };
                };
                readonly db: {
                    readonly port: number;
                    readonly shadow_port: number;
                    readonly health_timeout: string;
                    readonly major_version: number;
                    readonly pooler: {
                        readonly enabled: boolean;
                        readonly port: number;
                        readonly pool_mode: string;
                        readonly default_pool_size: number;
                        readonly max_client_conn: number;
                    };
                    readonly migrations: {
                        readonly enabled: boolean;
                        readonly schema_paths: readonly string[];
                    };
                    readonly seed: {
                        readonly enabled: boolean;
                        readonly sql_paths: readonly string[];
                    };
                    readonly settings?: {
                        readonly effective_cache_size?: string | undefined;
                        readonly logical_decoding_work_mem?: string | undefined;
                        readonly maintenance_work_mem?: string | undefined;
                        readonly max_connections?: number | undefined;
                        readonly max_locks_per_transaction?: number | undefined;
                        readonly max_parallel_maintenance_workers?: number | undefined;
                        readonly max_parallel_workers?: number | undefined;
                        readonly max_parallel_workers_per_gather?: number | undefined;
                        readonly max_replication_slots?: number | undefined;
                        readonly max_slot_wal_keep_size?: string | undefined;
                        readonly max_standby_archive_delay?: string | undefined;
                        readonly max_standby_streaming_delay?: string | undefined;
                        readonly max_wal_size?: string | undefined;
                        readonly max_wal_senders?: number | undefined;
                        readonly max_worker_processes?: number | undefined;
                        readonly session_replication_role?: string | undefined;
                        readonly shared_buffers?: string | undefined;
                        readonly statement_timeout?: string | undefined;
                        readonly track_activity_query_size?: string | undefined;
                        readonly track_commit_timestamp?: boolean | undefined;
                        readonly wal_keep_size?: string | undefined;
                        readonly wal_sender_timeout?: string | undefined;
                        readonly work_mem?: string | undefined;
                    } | undefined;
                    readonly network_restrictions: {
                        readonly enabled: boolean;
                        readonly allowed_cidrs: readonly string[];
                        readonly allowed_cidrs_v6: readonly string[];
                    };
                    readonly ssl_enforcement?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly vault?: {
                        readonly [x: string]: string;
                    } | undefined;
                };
                readonly edge_runtime: {
                    readonly enabled: boolean;
                    readonly policy: string;
                    readonly inspector_port: number;
                    readonly deno_version: number;
                    readonly secrets?: {
                        readonly [x: string]: string;
                    } | undefined;
                };
                readonly functions: {
                    readonly [x: string]: {
                        readonly enabled: boolean;
                        readonly verify_jwt: boolean;
                        readonly import_map: string;
                        readonly entrypoint: string;
                        readonly static_files: readonly string[];
                        readonly env: {
                            readonly [x: string]: string;
                        };
                    };
                };
                readonly local_smtp: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly smtp_port?: number | undefined;
                    readonly pop3_port?: number | undefined;
                    readonly admin_email?: string | undefined;
                    readonly sender_name?: string | undefined;
                };
                readonly realtime: {
                    readonly enabled: boolean;
                    readonly ip_version: string;
                    readonly max_header_length: number;
                };
                readonly storage: {
                    readonly enabled: boolean;
                    readonly file_size_limit: string;
                    readonly image_transformation?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly buckets?: {
                        readonly [x: string]: {
                            readonly public: boolean;
                            readonly file_size_limit: string;
                            readonly allowed_mime_types: readonly string[];
                            readonly objects_path: string;
                        };
                    } | undefined;
                    readonly s3_protocol: {
                        readonly enabled: boolean;
                    };
                    readonly analytics: {
                        readonly enabled: boolean;
                        readonly max_namespaces: number;
                        readonly max_tables: number;
                        readonly max_catalogs: number;
                        readonly buckets: {
                            readonly [x: string]: {};
                        };
                    };
                    readonly vector: {
                        readonly enabled: boolean;
                        readonly max_buckets: number;
                        readonly max_indexes: number;
                        readonly buckets: {
                            readonly [x: string]: {};
                        };
                    };
                };
                readonly studio: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly api_url: string;
                    readonly openai_api_key?: string | undefined;
                };
                readonly workers: {
                    readonly [x: string]: {
                        readonly runtime?: string | undefined;
                        readonly size?: string | undefined;
                        readonly instances?: number | undefined;
                        readonly source?: string | undefined;
                    };
                };
                readonly experimental: {
                    readonly orioledb_version?: string | undefined;
                    readonly s3_host?: string | undefined;
                    readonly s3_region?: string | undefined;
                    readonly s3_access_key?: string | undefined;
                    readonly s3_secret_key?: string | undefined;
                    readonly webhooks?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly pgdelta?: {
                        readonly enabled: boolean;
                        readonly declarative_schema_path?: string | undefined;
                        readonly format_options?: string | undefined;
                    } | undefined;
                    readonly inspect?: {
                        readonly rules: readonly {
                            readonly query?: string | undefined;
                            readonly name?: string | undefined;
                            readonly pass?: string | undefined;
                            readonly fail?: string | undefined;
                        }[];
                    } | undefined;
                };
            };
        };
    };
    schemaRef: string | undefined;
    ignoredPaths: never[];
    document: Record<string, unknown> | undefined;
    appliedRemote: string | undefined;
    removedDeprecatedExternalProviders: Readonly<Record<string, unknown>>;
    valueOrigins: {
        path: string[];
        source: CliConfigValueSource;
    }[];
}, CliConfigParseError | import("./errors.ts").CliProjectEnvParseError | DuplicateRemoteProjectIdError | InvalidRemoteProjectIdError | import("effect/PlatformError").PlatformError, FileSystem.FileSystem | Path.Path>;
export declare const loadCliConfig: (cwd: string, options?: InternalLoadCliConfigOptions | undefined) => Effect.Effect<{
    path: string;
    format: "json" | "toml";
    config: {
        readonly project_id?: string | undefined;
        readonly analytics: {
            readonly enabled: boolean;
            readonly port: number;
            readonly backend: string;
            readonly vector_port?: number | undefined;
            readonly gcp_project_id?: string | undefined;
            readonly gcp_project_number?: string | undefined;
            readonly gcp_jwt_path?: string | undefined;
        };
        readonly api: {
            readonly enabled: boolean;
            readonly port: number;
            readonly schemas: readonly string[];
            readonly extra_search_path: readonly string[];
            readonly max_rows: number;
            readonly auto_expose_new_tables?: boolean | undefined;
            readonly tls: {
                readonly enabled: boolean;
                readonly cert_path?: string | undefined;
                readonly key_path?: string | undefined;
            };
            readonly external_url?: string | undefined;
        };
        readonly auth: {
            readonly enabled: boolean;
            readonly site_url: string;
            readonly additional_redirect_urls: readonly string[];
            readonly jwt_expiry: number;
            readonly jwt_issuer?: string | undefined;
            readonly signing_keys_path?: string | undefined;
            readonly enable_refresh_token_rotation: boolean;
            readonly refresh_token_reuse_interval: number;
            readonly enable_manual_linking: boolean;
            readonly enable_signup: boolean;
            readonly enable_anonymous_sign_ins: boolean;
            readonly minimum_password_length: number;
            readonly password_requirements: string;
            readonly publishable_key?: string | undefined;
            readonly secret_key?: string | undefined;
            readonly jwt_secret?: string | undefined;
            readonly anon_key?: string | undefined;
            readonly service_role_key?: string | undefined;
            readonly rate_limit: {
                readonly email_sent: number;
                readonly sms_sent: number;
                readonly anonymous_users: number;
                readonly token_refresh: number;
                readonly sign_in_sign_ups: number;
                readonly token_verifications: number;
                readonly web3: number;
            };
            readonly captcha?: {
                readonly enabled: boolean;
                readonly provider?: string | undefined;
                readonly secret?: string | undefined;
            } | undefined;
            readonly hook: {
                readonly mfa_verification_attempt: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly password_verification_attempt: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly custom_access_token: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly send_sms: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly send_email: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly before_user_created: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
            };
            readonly mfa: {
                readonly totp: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                };
                readonly phone: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                    readonly otp_length: number;
                    readonly template: string;
                    readonly max_frequency: string;
                };
                readonly web_authn: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                };
                readonly max_enrolled_factors: number;
            };
            readonly sessions?: {
                readonly timebox?: string | undefined;
                readonly inactivity_timeout?: string | undefined;
            } | undefined;
            readonly email: {
                readonly enable_signup: boolean;
                readonly double_confirm_changes: boolean;
                readonly enable_confirmations: boolean;
                readonly secure_password_change: boolean;
                readonly max_frequency: string;
                readonly otp_length: number;
                readonly otp_expiry: number;
                readonly smtp?: {
                    readonly enabled: boolean;
                    readonly host?: string | undefined;
                    readonly port?: number | undefined;
                    readonly user?: string | undefined;
                    readonly pass?: string | undefined;
                    readonly admin_email?: string | undefined;
                    readonly sender_name?: string | undefined;
                } | undefined;
                readonly template: {
                    readonly [x: string]: {
                        readonly subject: string;
                        readonly content_path: string;
                    };
                };
                readonly notification: {
                    readonly [x: string]: {
                        readonly enabled: boolean;
                        readonly subject: string;
                        readonly content_path: string;
                    };
                };
            };
            readonly sms: {
                readonly enable_signup: boolean;
                readonly enable_confirmations: boolean;
                readonly template: string;
                readonly max_frequency: string;
                readonly twilio: {
                    readonly enabled: boolean;
                    readonly account_sid: string;
                    readonly message_service_sid: string;
                    readonly auth_token?: string | undefined;
                };
                readonly twilio_verify: {
                    readonly enabled: boolean;
                    readonly account_sid?: string | undefined;
                    readonly message_service_sid?: string | undefined;
                    readonly auth_token?: string | undefined;
                };
                readonly messagebird: {
                    readonly enabled: boolean;
                    readonly originator?: string | undefined;
                    readonly access_key?: string | undefined;
                };
                readonly textlocal: {
                    readonly enabled: boolean;
                    readonly sender?: string | undefined;
                    readonly api_key?: string | undefined;
                };
                readonly vonage: {
                    readonly enabled: boolean;
                    readonly from?: string | undefined;
                    readonly api_key?: string | undefined;
                    readonly api_secret?: string | undefined;
                };
                readonly test_otp?: {
                    readonly [x: string]: string;
                } | undefined;
            };
            readonly external: {
                readonly apple: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly azure: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly bitbucket: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly discord: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly facebook: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly github: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly gitlab: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly google: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly kakao: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly keycloak: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly linkedin_oidc: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly notion: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly twitch: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly twitter: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly x: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly slack_oidc: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly spotify: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly workos: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly zoom: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
            };
            readonly web3: {
                readonly solana: {
                    readonly enabled: boolean;
                };
                readonly ethereum: {
                    readonly enabled: boolean;
                };
            };
            readonly oauth_server: {
                readonly enabled: boolean;
                readonly authorization_url_path: string;
                readonly allow_dynamic_registration: boolean;
            };
            readonly third_party: {
                readonly firebase: {
                    readonly enabled: boolean;
                    readonly project_id?: string | undefined;
                };
                readonly auth0: {
                    readonly enabled: boolean;
                    readonly tenant?: string | undefined;
                    readonly tenant_region?: string | undefined;
                };
                readonly aws_cognito: {
                    readonly enabled: boolean;
                    readonly user_pool_id?: string | undefined;
                    readonly user_pool_region?: string | undefined;
                };
                readonly clerk: {
                    readonly enabled: boolean;
                    readonly domain?: string | undefined;
                };
                readonly workos: {
                    readonly enabled: boolean;
                    readonly issuer_url?: string | undefined;
                };
            };
        };
        readonly db: {
            readonly port: number;
            readonly shadow_port: number;
            readonly health_timeout: string;
            readonly major_version: number;
            readonly pooler: {
                readonly enabled: boolean;
                readonly port: number;
                readonly pool_mode: string;
                readonly default_pool_size: number;
                readonly max_client_conn: number;
            };
            readonly migrations: {
                readonly enabled: boolean;
                readonly schema_paths: readonly string[];
            };
            readonly seed: {
                readonly enabled: boolean;
                readonly sql_paths: readonly string[];
            };
            readonly settings?: {
                readonly effective_cache_size?: string | undefined;
                readonly logical_decoding_work_mem?: string | undefined;
                readonly maintenance_work_mem?: string | undefined;
                readonly max_connections?: number | undefined;
                readonly max_locks_per_transaction?: number | undefined;
                readonly max_parallel_maintenance_workers?: number | undefined;
                readonly max_parallel_workers?: number | undefined;
                readonly max_parallel_workers_per_gather?: number | undefined;
                readonly max_replication_slots?: number | undefined;
                readonly max_slot_wal_keep_size?: string | undefined;
                readonly max_standby_archive_delay?: string | undefined;
                readonly max_standby_streaming_delay?: string | undefined;
                readonly max_wal_size?: string | undefined;
                readonly max_wal_senders?: number | undefined;
                readonly max_worker_processes?: number | undefined;
                readonly session_replication_role?: string | undefined;
                readonly shared_buffers?: string | undefined;
                readonly statement_timeout?: string | undefined;
                readonly track_activity_query_size?: string | undefined;
                readonly track_commit_timestamp?: boolean | undefined;
                readonly wal_keep_size?: string | undefined;
                readonly wal_sender_timeout?: string | undefined;
                readonly work_mem?: string | undefined;
            } | undefined;
            readonly network_restrictions: {
                readonly enabled: boolean;
                readonly allowed_cidrs: readonly string[];
                readonly allowed_cidrs_v6: readonly string[];
            };
            readonly ssl_enforcement?: {
                readonly enabled: boolean;
            } | undefined;
            readonly vault?: {
                readonly [x: string]: string;
            } | undefined;
        };
        readonly edge_runtime: {
            readonly enabled: boolean;
            readonly policy: string;
            readonly inspector_port: number;
            readonly deno_version: number;
            readonly secrets?: {
                readonly [x: string]: string;
            } | undefined;
        };
        readonly functions: {
            readonly [x: string]: {
                readonly enabled: boolean;
                readonly verify_jwt: boolean;
                readonly import_map: string;
                readonly entrypoint: string;
                readonly static_files: readonly string[];
                readonly env: {
                    readonly [x: string]: string;
                };
            };
        };
        readonly local_smtp: {
            readonly enabled: boolean;
            readonly port: number;
            readonly smtp_port?: number | undefined;
            readonly pop3_port?: number | undefined;
            readonly admin_email?: string | undefined;
            readonly sender_name?: string | undefined;
        };
        readonly realtime: {
            readonly enabled: boolean;
            readonly ip_version: string;
            readonly max_header_length: number;
        };
        readonly storage: {
            readonly enabled: boolean;
            readonly file_size_limit: string;
            readonly image_transformation?: {
                readonly enabled: boolean;
            } | undefined;
            readonly buckets?: {
                readonly [x: string]: {
                    readonly public: boolean;
                    readonly file_size_limit: string;
                    readonly allowed_mime_types: readonly string[];
                    readonly objects_path: string;
                };
            } | undefined;
            readonly s3_protocol: {
                readonly enabled: boolean;
            };
            readonly analytics: {
                readonly enabled: boolean;
                readonly max_namespaces: number;
                readonly max_tables: number;
                readonly max_catalogs: number;
                readonly buckets: {
                    readonly [x: string]: {};
                };
            };
            readonly vector: {
                readonly enabled: boolean;
                readonly max_buckets: number;
                readonly max_indexes: number;
                readonly buckets: {
                    readonly [x: string]: {};
                };
            };
        };
        readonly studio: {
            readonly enabled: boolean;
            readonly port: number;
            readonly api_url: string;
            readonly openai_api_key?: string | undefined;
        };
        readonly workers: {
            readonly [x: string]: {
                readonly runtime?: string | undefined;
                readonly size?: string | undefined;
                readonly instances?: number | undefined;
                readonly source?: string | undefined;
            };
        };
        readonly experimental: {
            readonly orioledb_version?: string | undefined;
            readonly s3_host?: string | undefined;
            readonly s3_region?: string | undefined;
            readonly s3_access_key?: string | undefined;
            readonly s3_secret_key?: string | undefined;
            readonly webhooks?: {
                readonly enabled: boolean;
            } | undefined;
            readonly pgdelta?: {
                readonly enabled: boolean;
                readonly declarative_schema_path?: string | undefined;
                readonly format_options?: string | undefined;
            } | undefined;
            readonly inspect?: {
                readonly rules: readonly {
                    readonly query?: string | undefined;
                    readonly name?: string | undefined;
                    readonly pass?: string | undefined;
                    readonly fail?: string | undefined;
                }[];
            } | undefined;
        };
        readonly remotes: {
            readonly [x: string]: {
                readonly project_id: string;
                readonly analytics: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly backend: string;
                    readonly vector_port?: number | undefined;
                    readonly gcp_project_id?: string | undefined;
                    readonly gcp_project_number?: string | undefined;
                    readonly gcp_jwt_path?: string | undefined;
                };
                readonly api: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly schemas: readonly string[];
                    readonly extra_search_path: readonly string[];
                    readonly max_rows: number;
                    readonly auto_expose_new_tables?: boolean | undefined;
                    readonly tls: {
                        readonly enabled: boolean;
                        readonly cert_path?: string | undefined;
                        readonly key_path?: string | undefined;
                    };
                    readonly external_url?: string | undefined;
                };
                readonly auth: {
                    readonly enabled: boolean;
                    readonly site_url: string;
                    readonly additional_redirect_urls: readonly string[];
                    readonly jwt_expiry: number;
                    readonly jwt_issuer?: string | undefined;
                    readonly signing_keys_path?: string | undefined;
                    readonly enable_refresh_token_rotation: boolean;
                    readonly refresh_token_reuse_interval: number;
                    readonly enable_manual_linking: boolean;
                    readonly enable_signup: boolean;
                    readonly enable_anonymous_sign_ins: boolean;
                    readonly minimum_password_length: number;
                    readonly password_requirements: string;
                    readonly publishable_key?: string | undefined;
                    readonly secret_key?: string | undefined;
                    readonly jwt_secret?: string | undefined;
                    readonly anon_key?: string | undefined;
                    readonly service_role_key?: string | undefined;
                    readonly rate_limit: {
                        readonly email_sent: number;
                        readonly sms_sent: number;
                        readonly anonymous_users: number;
                        readonly token_refresh: number;
                        readonly sign_in_sign_ups: number;
                        readonly token_verifications: number;
                        readonly web3: number;
                    };
                    readonly captcha?: {
                        readonly enabled: boolean;
                        readonly provider?: string | undefined;
                        readonly secret?: string | undefined;
                    } | undefined;
                    readonly hook: {
                        readonly mfa_verification_attempt: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly password_verification_attempt: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly custom_access_token: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly send_sms: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly send_email: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly before_user_created: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                    };
                    readonly mfa: {
                        readonly totp: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                        };
                        readonly phone: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                            readonly otp_length: number;
                            readonly template: string;
                            readonly max_frequency: string;
                        };
                        readonly web_authn: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                        };
                        readonly max_enrolled_factors: number;
                    };
                    readonly sessions?: {
                        readonly timebox?: string | undefined;
                        readonly inactivity_timeout?: string | undefined;
                    } | undefined;
                    readonly email: {
                        readonly enable_signup: boolean;
                        readonly double_confirm_changes: boolean;
                        readonly enable_confirmations: boolean;
                        readonly secure_password_change: boolean;
                        readonly max_frequency: string;
                        readonly otp_length: number;
                        readonly otp_expiry: number;
                        readonly smtp?: {
                            readonly enabled: boolean;
                            readonly host?: string | undefined;
                            readonly port?: number | undefined;
                            readonly user?: string | undefined;
                            readonly pass?: string | undefined;
                            readonly admin_email?: string | undefined;
                            readonly sender_name?: string | undefined;
                        } | undefined;
                        readonly template: {
                            readonly [x: string]: {
                                readonly subject: string;
                                readonly content_path: string;
                            };
                        };
                        readonly notification: {
                            readonly [x: string]: {
                                readonly enabled: boolean;
                                readonly subject: string;
                                readonly content_path: string;
                            };
                        };
                    };
                    readonly sms: {
                        readonly enable_signup: boolean;
                        readonly enable_confirmations: boolean;
                        readonly template: string;
                        readonly max_frequency: string;
                        readonly twilio: {
                            readonly enabled: boolean;
                            readonly account_sid: string;
                            readonly message_service_sid: string;
                            readonly auth_token?: string | undefined;
                        };
                        readonly twilio_verify: {
                            readonly enabled: boolean;
                            readonly account_sid?: string | undefined;
                            readonly message_service_sid?: string | undefined;
                            readonly auth_token?: string | undefined;
                        };
                        readonly messagebird: {
                            readonly enabled: boolean;
                            readonly originator?: string | undefined;
                            readonly access_key?: string | undefined;
                        };
                        readonly textlocal: {
                            readonly enabled: boolean;
                            readonly sender?: string | undefined;
                            readonly api_key?: string | undefined;
                        };
                        readonly vonage: {
                            readonly enabled: boolean;
                            readonly from?: string | undefined;
                            readonly api_key?: string | undefined;
                            readonly api_secret?: string | undefined;
                        };
                        readonly test_otp?: {
                            readonly [x: string]: string;
                        } | undefined;
                    };
                    readonly external: {
                        readonly apple: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly azure: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly bitbucket: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly discord: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly facebook: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly github: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly gitlab: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly google: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly kakao: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly keycloak: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly linkedin_oidc: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly notion: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly twitch: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly twitter: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly x: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly slack_oidc: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly spotify: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly workos: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly zoom: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                    };
                    readonly web3: {
                        readonly solana: {
                            readonly enabled: boolean;
                        };
                        readonly ethereum: {
                            readonly enabled: boolean;
                        };
                    };
                    readonly oauth_server: {
                        readonly enabled: boolean;
                        readonly authorization_url_path: string;
                        readonly allow_dynamic_registration: boolean;
                    };
                    readonly third_party: {
                        readonly firebase: {
                            readonly enabled: boolean;
                            readonly project_id?: string | undefined;
                        };
                        readonly auth0: {
                            readonly enabled: boolean;
                            readonly tenant?: string | undefined;
                            readonly tenant_region?: string | undefined;
                        };
                        readonly aws_cognito: {
                            readonly enabled: boolean;
                            readonly user_pool_id?: string | undefined;
                            readonly user_pool_region?: string | undefined;
                        };
                        readonly clerk: {
                            readonly enabled: boolean;
                            readonly domain?: string | undefined;
                        };
                        readonly workos: {
                            readonly enabled: boolean;
                            readonly issuer_url?: string | undefined;
                        };
                    };
                };
                readonly db: {
                    readonly port: number;
                    readonly shadow_port: number;
                    readonly health_timeout: string;
                    readonly major_version: number;
                    readonly pooler: {
                        readonly enabled: boolean;
                        readonly port: number;
                        readonly pool_mode: string;
                        readonly default_pool_size: number;
                        readonly max_client_conn: number;
                    };
                    readonly migrations: {
                        readonly enabled: boolean;
                        readonly schema_paths: readonly string[];
                    };
                    readonly seed: {
                        readonly enabled: boolean;
                        readonly sql_paths: readonly string[];
                    };
                    readonly settings?: {
                        readonly effective_cache_size?: string | undefined;
                        readonly logical_decoding_work_mem?: string | undefined;
                        readonly maintenance_work_mem?: string | undefined;
                        readonly max_connections?: number | undefined;
                        readonly max_locks_per_transaction?: number | undefined;
                        readonly max_parallel_maintenance_workers?: number | undefined;
                        readonly max_parallel_workers?: number | undefined;
                        readonly max_parallel_workers_per_gather?: number | undefined;
                        readonly max_replication_slots?: number | undefined;
                        readonly max_slot_wal_keep_size?: string | undefined;
                        readonly max_standby_archive_delay?: string | undefined;
                        readonly max_standby_streaming_delay?: string | undefined;
                        readonly max_wal_size?: string | undefined;
                        readonly max_wal_senders?: number | undefined;
                        readonly max_worker_processes?: number | undefined;
                        readonly session_replication_role?: string | undefined;
                        readonly shared_buffers?: string | undefined;
                        readonly statement_timeout?: string | undefined;
                        readonly track_activity_query_size?: string | undefined;
                        readonly track_commit_timestamp?: boolean | undefined;
                        readonly wal_keep_size?: string | undefined;
                        readonly wal_sender_timeout?: string | undefined;
                        readonly work_mem?: string | undefined;
                    } | undefined;
                    readonly network_restrictions: {
                        readonly enabled: boolean;
                        readonly allowed_cidrs: readonly string[];
                        readonly allowed_cidrs_v6: readonly string[];
                    };
                    readonly ssl_enforcement?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly vault?: {
                        readonly [x: string]: string;
                    } | undefined;
                };
                readonly edge_runtime: {
                    readonly enabled: boolean;
                    readonly policy: string;
                    readonly inspector_port: number;
                    readonly deno_version: number;
                    readonly secrets?: {
                        readonly [x: string]: string;
                    } | undefined;
                };
                readonly functions: {
                    readonly [x: string]: {
                        readonly enabled: boolean;
                        readonly verify_jwt: boolean;
                        readonly import_map: string;
                        readonly entrypoint: string;
                        readonly static_files: readonly string[];
                        readonly env: {
                            readonly [x: string]: string;
                        };
                    };
                };
                readonly local_smtp: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly smtp_port?: number | undefined;
                    readonly pop3_port?: number | undefined;
                    readonly admin_email?: string | undefined;
                    readonly sender_name?: string | undefined;
                };
                readonly realtime: {
                    readonly enabled: boolean;
                    readonly ip_version: string;
                    readonly max_header_length: number;
                };
                readonly storage: {
                    readonly enabled: boolean;
                    readonly file_size_limit: string;
                    readonly image_transformation?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly buckets?: {
                        readonly [x: string]: {
                            readonly public: boolean;
                            readonly file_size_limit: string;
                            readonly allowed_mime_types: readonly string[];
                            readonly objects_path: string;
                        };
                    } | undefined;
                    readonly s3_protocol: {
                        readonly enabled: boolean;
                    };
                    readonly analytics: {
                        readonly enabled: boolean;
                        readonly max_namespaces: number;
                        readonly max_tables: number;
                        readonly max_catalogs: number;
                        readonly buckets: {
                            readonly [x: string]: {};
                        };
                    };
                    readonly vector: {
                        readonly enabled: boolean;
                        readonly max_buckets: number;
                        readonly max_indexes: number;
                        readonly buckets: {
                            readonly [x: string]: {};
                        };
                    };
                };
                readonly studio: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly api_url: string;
                    readonly openai_api_key?: string | undefined;
                };
                readonly workers: {
                    readonly [x: string]: {
                        readonly runtime?: string | undefined;
                        readonly size?: string | undefined;
                        readonly instances?: number | undefined;
                        readonly source?: string | undefined;
                    };
                };
                readonly experimental: {
                    readonly orioledb_version?: string | undefined;
                    readonly s3_host?: string | undefined;
                    readonly s3_region?: string | undefined;
                    readonly s3_access_key?: string | undefined;
                    readonly s3_secret_key?: string | undefined;
                    readonly webhooks?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly pgdelta?: {
                        readonly enabled: boolean;
                        readonly declarative_schema_path?: string | undefined;
                        readonly format_options?: string | undefined;
                    } | undefined;
                    readonly inspect?: {
                        readonly rules: readonly {
                            readonly query?: string | undefined;
                            readonly name?: string | undefined;
                            readonly pass?: string | undefined;
                            readonly fail?: string | undefined;
                        }[];
                    } | undefined;
                };
            };
        };
    };
    schemaRef: string | undefined;
    document: Record<string, unknown> | undefined;
    appliedRemote: string | undefined;
    removedDeprecatedExternalProviders: Readonly<Record<string, unknown>>;
    valueOrigins: {
        path: string[];
        source: CliConfigValueSource;
    }[];
    ignoredPaths: string[];
} | null, CliConfigParseError | import("./errors.ts").CliProjectEnvParseError | DuplicateRemoteProjectIdError | InvalidRemoteProjectIdError | import("effect/PlatformError").PlatformError, FileSystem.FileSystem | Path.Path>;
export declare const saveCliConfig: (options: SaveCliConfigOptions) => Effect.Effect<{
    path: string;
    format: ConfigFormat;
    config: {
        readonly project_id?: string | undefined;
        readonly analytics: {
            readonly enabled: boolean;
            readonly port: number;
            readonly backend: string;
            readonly vector_port?: number | undefined;
            readonly gcp_project_id?: string | undefined;
            readonly gcp_project_number?: string | undefined;
            readonly gcp_jwt_path?: string | undefined;
        };
        readonly api: {
            readonly enabled: boolean;
            readonly port: number;
            readonly schemas: readonly string[];
            readonly extra_search_path: readonly string[];
            readonly max_rows: number;
            readonly auto_expose_new_tables?: boolean | undefined;
            readonly tls: {
                readonly enabled: boolean;
                readonly cert_path?: string | undefined;
                readonly key_path?: string | undefined;
            };
            readonly external_url?: string | undefined;
        };
        readonly auth: {
            readonly enabled: boolean;
            readonly site_url: string;
            readonly additional_redirect_urls: readonly string[];
            readonly jwt_expiry: number;
            readonly jwt_issuer?: string | undefined;
            readonly signing_keys_path?: string | undefined;
            readonly enable_refresh_token_rotation: boolean;
            readonly refresh_token_reuse_interval: number;
            readonly enable_manual_linking: boolean;
            readonly enable_signup: boolean;
            readonly enable_anonymous_sign_ins: boolean;
            readonly minimum_password_length: number;
            readonly password_requirements: string;
            readonly publishable_key?: string | undefined;
            readonly secret_key?: string | undefined;
            readonly jwt_secret?: string | undefined;
            readonly anon_key?: string | undefined;
            readonly service_role_key?: string | undefined;
            readonly rate_limit: {
                readonly email_sent: number;
                readonly sms_sent: number;
                readonly anonymous_users: number;
                readonly token_refresh: number;
                readonly sign_in_sign_ups: number;
                readonly token_verifications: number;
                readonly web3: number;
            };
            readonly captcha?: {
                readonly enabled: boolean;
                readonly provider?: string | undefined;
                readonly secret?: string | undefined;
            } | undefined;
            readonly hook: {
                readonly mfa_verification_attempt: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly password_verification_attempt: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly custom_access_token: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly send_sms: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly send_email: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
                readonly before_user_created: {
                    readonly enabled: boolean;
                    readonly uri?: string | undefined;
                    readonly secrets?: string | undefined;
                };
            };
            readonly mfa: {
                readonly totp: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                };
                readonly phone: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                    readonly otp_length: number;
                    readonly template: string;
                    readonly max_frequency: string;
                };
                readonly web_authn: {
                    readonly enroll_enabled: boolean;
                    readonly verify_enabled: boolean;
                };
                readonly max_enrolled_factors: number;
            };
            readonly sessions?: {
                readonly timebox?: string | undefined;
                readonly inactivity_timeout?: string | undefined;
            } | undefined;
            readonly email: {
                readonly enable_signup: boolean;
                readonly double_confirm_changes: boolean;
                readonly enable_confirmations: boolean;
                readonly secure_password_change: boolean;
                readonly max_frequency: string;
                readonly otp_length: number;
                readonly otp_expiry: number;
                readonly smtp?: {
                    readonly enabled: boolean;
                    readonly host?: string | undefined;
                    readonly port?: number | undefined;
                    readonly user?: string | undefined;
                    readonly pass?: string | undefined;
                    readonly admin_email?: string | undefined;
                    readonly sender_name?: string | undefined;
                } | undefined;
                readonly template: {
                    readonly [x: string]: {
                        readonly subject: string;
                        readonly content_path: string;
                    };
                };
                readonly notification: {
                    readonly [x: string]: {
                        readonly enabled: boolean;
                        readonly subject: string;
                        readonly content_path: string;
                    };
                };
            };
            readonly sms: {
                readonly enable_signup: boolean;
                readonly enable_confirmations: boolean;
                readonly template: string;
                readonly max_frequency: string;
                readonly twilio: {
                    readonly enabled: boolean;
                    readonly account_sid: string;
                    readonly message_service_sid: string;
                    readonly auth_token?: string | undefined;
                };
                readonly twilio_verify: {
                    readonly enabled: boolean;
                    readonly account_sid?: string | undefined;
                    readonly message_service_sid?: string | undefined;
                    readonly auth_token?: string | undefined;
                };
                readonly messagebird: {
                    readonly enabled: boolean;
                    readonly originator?: string | undefined;
                    readonly access_key?: string | undefined;
                };
                readonly textlocal: {
                    readonly enabled: boolean;
                    readonly sender?: string | undefined;
                    readonly api_key?: string | undefined;
                };
                readonly vonage: {
                    readonly enabled: boolean;
                    readonly from?: string | undefined;
                    readonly api_key?: string | undefined;
                    readonly api_secret?: string | undefined;
                };
                readonly test_otp?: {
                    readonly [x: string]: string;
                } | undefined;
            };
            readonly external: {
                readonly apple: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly azure: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly bitbucket: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly discord: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly facebook: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly github: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly gitlab: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly google: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly kakao: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly keycloak: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly linkedin_oidc: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly notion: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly twitch: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly twitter: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly x: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly slack_oidc: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly spotify: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly workos: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
                readonly zoom: {
                    readonly enabled: boolean;
                    readonly client_id: string;
                    readonly secret?: string | undefined;
                    readonly url: string;
                    readonly redirect_uri: string;
                    readonly skip_nonce_check: boolean;
                    readonly email_optional: boolean;
                };
            };
            readonly web3: {
                readonly solana: {
                    readonly enabled: boolean;
                };
                readonly ethereum: {
                    readonly enabled: boolean;
                };
            };
            readonly oauth_server: {
                readonly enabled: boolean;
                readonly authorization_url_path: string;
                readonly allow_dynamic_registration: boolean;
            };
            readonly third_party: {
                readonly firebase: {
                    readonly enabled: boolean;
                    readonly project_id?: string | undefined;
                };
                readonly auth0: {
                    readonly enabled: boolean;
                    readonly tenant?: string | undefined;
                    readonly tenant_region?: string | undefined;
                };
                readonly aws_cognito: {
                    readonly enabled: boolean;
                    readonly user_pool_id?: string | undefined;
                    readonly user_pool_region?: string | undefined;
                };
                readonly clerk: {
                    readonly enabled: boolean;
                    readonly domain?: string | undefined;
                };
                readonly workos: {
                    readonly enabled: boolean;
                    readonly issuer_url?: string | undefined;
                };
            };
        };
        readonly db: {
            readonly port: number;
            readonly shadow_port: number;
            readonly health_timeout: string;
            readonly major_version: number;
            readonly pooler: {
                readonly enabled: boolean;
                readonly port: number;
                readonly pool_mode: string;
                readonly default_pool_size: number;
                readonly max_client_conn: number;
            };
            readonly migrations: {
                readonly enabled: boolean;
                readonly schema_paths: readonly string[];
            };
            readonly seed: {
                readonly enabled: boolean;
                readonly sql_paths: readonly string[];
            };
            readonly settings?: {
                readonly effective_cache_size?: string | undefined;
                readonly logical_decoding_work_mem?: string | undefined;
                readonly maintenance_work_mem?: string | undefined;
                readonly max_connections?: number | undefined;
                readonly max_locks_per_transaction?: number | undefined;
                readonly max_parallel_maintenance_workers?: number | undefined;
                readonly max_parallel_workers?: number | undefined;
                readonly max_parallel_workers_per_gather?: number | undefined;
                readonly max_replication_slots?: number | undefined;
                readonly max_slot_wal_keep_size?: string | undefined;
                readonly max_standby_archive_delay?: string | undefined;
                readonly max_standby_streaming_delay?: string | undefined;
                readonly max_wal_size?: string | undefined;
                readonly max_wal_senders?: number | undefined;
                readonly max_worker_processes?: number | undefined;
                readonly session_replication_role?: string | undefined;
                readonly shared_buffers?: string | undefined;
                readonly statement_timeout?: string | undefined;
                readonly track_activity_query_size?: string | undefined;
                readonly track_commit_timestamp?: boolean | undefined;
                readonly wal_keep_size?: string | undefined;
                readonly wal_sender_timeout?: string | undefined;
                readonly work_mem?: string | undefined;
            } | undefined;
            readonly network_restrictions: {
                readonly enabled: boolean;
                readonly allowed_cidrs: readonly string[];
                readonly allowed_cidrs_v6: readonly string[];
            };
            readonly ssl_enforcement?: {
                readonly enabled: boolean;
            } | undefined;
            readonly vault?: {
                readonly [x: string]: string;
            } | undefined;
        };
        readonly edge_runtime: {
            readonly enabled: boolean;
            readonly policy: string;
            readonly inspector_port: number;
            readonly deno_version: number;
            readonly secrets?: {
                readonly [x: string]: string;
            } | undefined;
        };
        readonly functions: {
            readonly [x: string]: {
                readonly enabled: boolean;
                readonly verify_jwt: boolean;
                readonly import_map: string;
                readonly entrypoint: string;
                readonly static_files: readonly string[];
                readonly env: {
                    readonly [x: string]: string;
                };
            };
        };
        readonly local_smtp: {
            readonly enabled: boolean;
            readonly port: number;
            readonly smtp_port?: number | undefined;
            readonly pop3_port?: number | undefined;
            readonly admin_email?: string | undefined;
            readonly sender_name?: string | undefined;
        };
        readonly realtime: {
            readonly enabled: boolean;
            readonly ip_version: string;
            readonly max_header_length: number;
        };
        readonly storage: {
            readonly enabled: boolean;
            readonly file_size_limit: string;
            readonly image_transformation?: {
                readonly enabled: boolean;
            } | undefined;
            readonly buckets?: {
                readonly [x: string]: {
                    readonly public: boolean;
                    readonly file_size_limit: string;
                    readonly allowed_mime_types: readonly string[];
                    readonly objects_path: string;
                };
            } | undefined;
            readonly s3_protocol: {
                readonly enabled: boolean;
            };
            readonly analytics: {
                readonly enabled: boolean;
                readonly max_namespaces: number;
                readonly max_tables: number;
                readonly max_catalogs: number;
                readonly buckets: {
                    readonly [x: string]: {};
                };
            };
            readonly vector: {
                readonly enabled: boolean;
                readonly max_buckets: number;
                readonly max_indexes: number;
                readonly buckets: {
                    readonly [x: string]: {};
                };
            };
        };
        readonly studio: {
            readonly enabled: boolean;
            readonly port: number;
            readonly api_url: string;
            readonly openai_api_key?: string | undefined;
        };
        readonly workers: {
            readonly [x: string]: {
                readonly runtime?: string | undefined;
                readonly size?: string | undefined;
                readonly instances?: number | undefined;
                readonly source?: string | undefined;
            };
        };
        readonly experimental: {
            readonly orioledb_version?: string | undefined;
            readonly s3_host?: string | undefined;
            readonly s3_region?: string | undefined;
            readonly s3_access_key?: string | undefined;
            readonly s3_secret_key?: string | undefined;
            readonly webhooks?: {
                readonly enabled: boolean;
            } | undefined;
            readonly pgdelta?: {
                readonly enabled: boolean;
                readonly declarative_schema_path?: string | undefined;
                readonly format_options?: string | undefined;
            } | undefined;
            readonly inspect?: {
                readonly rules: readonly {
                    readonly query?: string | undefined;
                    readonly name?: string | undefined;
                    readonly pass?: string | undefined;
                    readonly fail?: string | undefined;
                }[];
            } | undefined;
        };
        readonly remotes: {
            readonly [x: string]: {
                readonly project_id: string;
                readonly analytics: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly backend: string;
                    readonly vector_port?: number | undefined;
                    readonly gcp_project_id?: string | undefined;
                    readonly gcp_project_number?: string | undefined;
                    readonly gcp_jwt_path?: string | undefined;
                };
                readonly api: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly schemas: readonly string[];
                    readonly extra_search_path: readonly string[];
                    readonly max_rows: number;
                    readonly auto_expose_new_tables?: boolean | undefined;
                    readonly tls: {
                        readonly enabled: boolean;
                        readonly cert_path?: string | undefined;
                        readonly key_path?: string | undefined;
                    };
                    readonly external_url?: string | undefined;
                };
                readonly auth: {
                    readonly enabled: boolean;
                    readonly site_url: string;
                    readonly additional_redirect_urls: readonly string[];
                    readonly jwt_expiry: number;
                    readonly jwt_issuer?: string | undefined;
                    readonly signing_keys_path?: string | undefined;
                    readonly enable_refresh_token_rotation: boolean;
                    readonly refresh_token_reuse_interval: number;
                    readonly enable_manual_linking: boolean;
                    readonly enable_signup: boolean;
                    readonly enable_anonymous_sign_ins: boolean;
                    readonly minimum_password_length: number;
                    readonly password_requirements: string;
                    readonly publishable_key?: string | undefined;
                    readonly secret_key?: string | undefined;
                    readonly jwt_secret?: string | undefined;
                    readonly anon_key?: string | undefined;
                    readonly service_role_key?: string | undefined;
                    readonly rate_limit: {
                        readonly email_sent: number;
                        readonly sms_sent: number;
                        readonly anonymous_users: number;
                        readonly token_refresh: number;
                        readonly sign_in_sign_ups: number;
                        readonly token_verifications: number;
                        readonly web3: number;
                    };
                    readonly captcha?: {
                        readonly enabled: boolean;
                        readonly provider?: string | undefined;
                        readonly secret?: string | undefined;
                    } | undefined;
                    readonly hook: {
                        readonly mfa_verification_attempt: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly password_verification_attempt: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly custom_access_token: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly send_sms: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly send_email: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                        readonly before_user_created: {
                            readonly enabled: boolean;
                            readonly uri?: string | undefined;
                            readonly secrets?: string | undefined;
                        };
                    };
                    readonly mfa: {
                        readonly totp: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                        };
                        readonly phone: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                            readonly otp_length: number;
                            readonly template: string;
                            readonly max_frequency: string;
                        };
                        readonly web_authn: {
                            readonly enroll_enabled: boolean;
                            readonly verify_enabled: boolean;
                        };
                        readonly max_enrolled_factors: number;
                    };
                    readonly sessions?: {
                        readonly timebox?: string | undefined;
                        readonly inactivity_timeout?: string | undefined;
                    } | undefined;
                    readonly email: {
                        readonly enable_signup: boolean;
                        readonly double_confirm_changes: boolean;
                        readonly enable_confirmations: boolean;
                        readonly secure_password_change: boolean;
                        readonly max_frequency: string;
                        readonly otp_length: number;
                        readonly otp_expiry: number;
                        readonly smtp?: {
                            readonly enabled: boolean;
                            readonly host?: string | undefined;
                            readonly port?: number | undefined;
                            readonly user?: string | undefined;
                            readonly pass?: string | undefined;
                            readonly admin_email?: string | undefined;
                            readonly sender_name?: string | undefined;
                        } | undefined;
                        readonly template: {
                            readonly [x: string]: {
                                readonly subject: string;
                                readonly content_path: string;
                            };
                        };
                        readonly notification: {
                            readonly [x: string]: {
                                readonly enabled: boolean;
                                readonly subject: string;
                                readonly content_path: string;
                            };
                        };
                    };
                    readonly sms: {
                        readonly enable_signup: boolean;
                        readonly enable_confirmations: boolean;
                        readonly template: string;
                        readonly max_frequency: string;
                        readonly twilio: {
                            readonly enabled: boolean;
                            readonly account_sid: string;
                            readonly message_service_sid: string;
                            readonly auth_token?: string | undefined;
                        };
                        readonly twilio_verify: {
                            readonly enabled: boolean;
                            readonly account_sid?: string | undefined;
                            readonly message_service_sid?: string | undefined;
                            readonly auth_token?: string | undefined;
                        };
                        readonly messagebird: {
                            readonly enabled: boolean;
                            readonly originator?: string | undefined;
                            readonly access_key?: string | undefined;
                        };
                        readonly textlocal: {
                            readonly enabled: boolean;
                            readonly sender?: string | undefined;
                            readonly api_key?: string | undefined;
                        };
                        readonly vonage: {
                            readonly enabled: boolean;
                            readonly from?: string | undefined;
                            readonly api_key?: string | undefined;
                            readonly api_secret?: string | undefined;
                        };
                        readonly test_otp?: {
                            readonly [x: string]: string;
                        } | undefined;
                    };
                    readonly external: {
                        readonly apple: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly azure: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly bitbucket: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly discord: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly facebook: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly github: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly gitlab: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly google: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly kakao: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly keycloak: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly linkedin_oidc: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly notion: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly twitch: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly twitter: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly x: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly slack_oidc: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly spotify: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly workos: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                        readonly zoom: {
                            readonly enabled: boolean;
                            readonly client_id: string;
                            readonly secret?: string | undefined;
                            readonly url: string;
                            readonly redirect_uri: string;
                            readonly skip_nonce_check: boolean;
                            readonly email_optional: boolean;
                        };
                    };
                    readonly web3: {
                        readonly solana: {
                            readonly enabled: boolean;
                        };
                        readonly ethereum: {
                            readonly enabled: boolean;
                        };
                    };
                    readonly oauth_server: {
                        readonly enabled: boolean;
                        readonly authorization_url_path: string;
                        readonly allow_dynamic_registration: boolean;
                    };
                    readonly third_party: {
                        readonly firebase: {
                            readonly enabled: boolean;
                            readonly project_id?: string | undefined;
                        };
                        readonly auth0: {
                            readonly enabled: boolean;
                            readonly tenant?: string | undefined;
                            readonly tenant_region?: string | undefined;
                        };
                        readonly aws_cognito: {
                            readonly enabled: boolean;
                            readonly user_pool_id?: string | undefined;
                            readonly user_pool_region?: string | undefined;
                        };
                        readonly clerk: {
                            readonly enabled: boolean;
                            readonly domain?: string | undefined;
                        };
                        readonly workos: {
                            readonly enabled: boolean;
                            readonly issuer_url?: string | undefined;
                        };
                    };
                };
                readonly db: {
                    readonly port: number;
                    readonly shadow_port: number;
                    readonly health_timeout: string;
                    readonly major_version: number;
                    readonly pooler: {
                        readonly enabled: boolean;
                        readonly port: number;
                        readonly pool_mode: string;
                        readonly default_pool_size: number;
                        readonly max_client_conn: number;
                    };
                    readonly migrations: {
                        readonly enabled: boolean;
                        readonly schema_paths: readonly string[];
                    };
                    readonly seed: {
                        readonly enabled: boolean;
                        readonly sql_paths: readonly string[];
                    };
                    readonly settings?: {
                        readonly effective_cache_size?: string | undefined;
                        readonly logical_decoding_work_mem?: string | undefined;
                        readonly maintenance_work_mem?: string | undefined;
                        readonly max_connections?: number | undefined;
                        readonly max_locks_per_transaction?: number | undefined;
                        readonly max_parallel_maintenance_workers?: number | undefined;
                        readonly max_parallel_workers?: number | undefined;
                        readonly max_parallel_workers_per_gather?: number | undefined;
                        readonly max_replication_slots?: number | undefined;
                        readonly max_slot_wal_keep_size?: string | undefined;
                        readonly max_standby_archive_delay?: string | undefined;
                        readonly max_standby_streaming_delay?: string | undefined;
                        readonly max_wal_size?: string | undefined;
                        readonly max_wal_senders?: number | undefined;
                        readonly max_worker_processes?: number | undefined;
                        readonly session_replication_role?: string | undefined;
                        readonly shared_buffers?: string | undefined;
                        readonly statement_timeout?: string | undefined;
                        readonly track_activity_query_size?: string | undefined;
                        readonly track_commit_timestamp?: boolean | undefined;
                        readonly wal_keep_size?: string | undefined;
                        readonly wal_sender_timeout?: string | undefined;
                        readonly work_mem?: string | undefined;
                    } | undefined;
                    readonly network_restrictions: {
                        readonly enabled: boolean;
                        readonly allowed_cidrs: readonly string[];
                        readonly allowed_cidrs_v6: readonly string[];
                    };
                    readonly ssl_enforcement?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly vault?: {
                        readonly [x: string]: string;
                    } | undefined;
                };
                readonly edge_runtime: {
                    readonly enabled: boolean;
                    readonly policy: string;
                    readonly inspector_port: number;
                    readonly deno_version: number;
                    readonly secrets?: {
                        readonly [x: string]: string;
                    } | undefined;
                };
                readonly functions: {
                    readonly [x: string]: {
                        readonly enabled: boolean;
                        readonly verify_jwt: boolean;
                        readonly import_map: string;
                        readonly entrypoint: string;
                        readonly static_files: readonly string[];
                        readonly env: {
                            readonly [x: string]: string;
                        };
                    };
                };
                readonly local_smtp: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly smtp_port?: number | undefined;
                    readonly pop3_port?: number | undefined;
                    readonly admin_email?: string | undefined;
                    readonly sender_name?: string | undefined;
                };
                readonly realtime: {
                    readonly enabled: boolean;
                    readonly ip_version: string;
                    readonly max_header_length: number;
                };
                readonly storage: {
                    readonly enabled: boolean;
                    readonly file_size_limit: string;
                    readonly image_transformation?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly buckets?: {
                        readonly [x: string]: {
                            readonly public: boolean;
                            readonly file_size_limit: string;
                            readonly allowed_mime_types: readonly string[];
                            readonly objects_path: string;
                        };
                    } | undefined;
                    readonly s3_protocol: {
                        readonly enabled: boolean;
                    };
                    readonly analytics: {
                        readonly enabled: boolean;
                        readonly max_namespaces: number;
                        readonly max_tables: number;
                        readonly max_catalogs: number;
                        readonly buckets: {
                            readonly [x: string]: {};
                        };
                    };
                    readonly vector: {
                        readonly enabled: boolean;
                        readonly max_buckets: number;
                        readonly max_indexes: number;
                        readonly buckets: {
                            readonly [x: string]: {};
                        };
                    };
                };
                readonly studio: {
                    readonly enabled: boolean;
                    readonly port: number;
                    readonly api_url: string;
                    readonly openai_api_key?: string | undefined;
                };
                readonly workers: {
                    readonly [x: string]: {
                        readonly runtime?: string | undefined;
                        readonly size?: string | undefined;
                        readonly instances?: number | undefined;
                        readonly source?: string | undefined;
                    };
                };
                readonly experimental: {
                    readonly orioledb_version?: string | undefined;
                    readonly s3_host?: string | undefined;
                    readonly s3_region?: string | undefined;
                    readonly s3_access_key?: string | undefined;
                    readonly s3_secret_key?: string | undefined;
                    readonly webhooks?: {
                        readonly enabled: boolean;
                    } | undefined;
                    readonly pgdelta?: {
                        readonly enabled: boolean;
                        readonly declarative_schema_path?: string | undefined;
                        readonly format_options?: string | undefined;
                    } | undefined;
                    readonly inspect?: {
                        readonly rules: readonly {
                            readonly query?: string | undefined;
                            readonly name?: string | undefined;
                            readonly pass?: string | undefined;
                            readonly fail?: string | undefined;
                        }[];
                    } | undefined;
                };
            };
        };
    };
    schemaRef: string | undefined;
    ignoredPaths: never[];
}, CliConfigParseError | import("./errors.ts").CliProjectEnvParseError | DuplicateRemoteProjectIdError | InvalidRemoteProjectIdError | import("effect/PlatformError").PlatformError, FileSystem.FileSystem | Path.Path>;
