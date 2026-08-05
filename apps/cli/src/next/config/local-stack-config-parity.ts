import type { ProjectConfig } from "@supabase/config";

/**
 * The disposition of one project-config leaf in the next local-stack flow.
 *
 * `presence` tells the future launch resolver whether the decoded value is
 * sufficient or whether it must also inspect the loaded source document. Most
 * schema defaults erase the distinction between an omitted field and an
 * explicitly configured default value, which matters when unsupported fields
 * must be rejected or warned about without rejecting untouched defaults.
 */
export type LocalStackConfigParityDecision =
  | {
      readonly _tag: "mapped";
      readonly presence: "decoded-value" | "raw-document";
      readonly mappedBy: "start" | "functions-dev" | "stack-functions-runtime";
      readonly rationale: string;
    }
  | {
      readonly _tag: "not-applicable";
      readonly presence: "decoded-value" | "raw-document";
      readonly rationale: string;
    }
  | {
      readonly _tag: "unsupported-blocking";
      readonly presence: "decoded-value" | "raw-document";
      readonly rationale: string;
    }
  | {
      readonly _tag: "unsupported-warning";
      readonly presence: "decoded-value" | "raw-document";
      readonly rationale: string;
    };

export interface LocalStackConfigParitySection {
  readonly [field: string]: LocalStackConfigParityDecision | LocalStackConfigParitySection;
}

type Node = LocalStackConfigParityDecision | LocalStackConfigParitySection;

const unsupportedRuntimeField: LocalStackConfigParityDecision = {
  _tag: "unsupported-blocking",
  presence: "raw-document",
  rationale:
    "An explicit value changes local runtime behavior but the next stack launch Adapter does not translate it yet.",
};

const unsupportedOptionalRuntimeField: LocalStackConfigParityDecision = {
  _tag: "unsupported-blocking",
  presence: "decoded-value",
  rationale:
    "An explicitly present optional value changes local runtime behavior but the next stack launch Adapter does not translate it yet.",
};

const unsupportedSecretRuntimeField: LocalStackConfigParityDecision = {
  _tag: "unsupported-blocking",
  presence: "decoded-value",
  rationale:
    "An explicitly configured secret changes local runtime credentials but the next stack launch Adapter does not translate it yet.",
};

const mappedAutoExposeNewTables: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "start",
  rationale:
    "The start command resolves the tri-state value, emits its deprecation warning, and passes it to PostgreSQL initialization.",
};

const mappedDatabaseHealthTimeout: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "start",
  rationale:
    "The launch Adapter resolves the legacy environment override, applies the duration to PostgreSQL startup health, and derives the stack readiness deadline from it.",
};

const mappedDatabaseSeedField: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "start",
  rationale:
    "The launch Adapter expands ordered seed inputs and the stack executes them as an internal PostgreSQL bootstrap phase with legacy-compatible seed history semantics.",
};

const mappedCoreTopologyField: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "start",
  rationale:
    "The launch Adapter applies project values, legacy environment overrides, and CLI exclusions before constructing StackConfig.",
};

const mappedDataPlaneRuntimeField: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "start",
  rationale:
    "The data-plane launch module applies the project value and legacy environment override to the service factory runtime.",
};

const mappedOptionalDataPlaneRuntimeField: LocalStackConfigParityDecision = {
  ...mappedDataPlaneRuntimeField,
  presence: "decoded-value",
};

const mappedAuthRuntimeField: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "start",
  rationale:
    "The Auth launch translator passes this project setting to the stack-owned Auth runtime configuration.",
};

const mappedAuthOptionalRuntimeField: LocalStackConfigParityDecision = {
  ...mappedAuthRuntimeField,
  presence: "decoded-value",
};

const mappedAuthSecretRuntimeField: LocalStackConfigParityDecision = {
  ...mappedAuthRuntimeField,
  presence: "decoded-value",
  rationale:
    "The Auth launch translator passes this credential to the stack without retaining it in diagnostics.",
};
const projectIdentityField: LocalStackConfigParityDecision = {
  _tag: "not-applicable",
  presence: "raw-document",
  rationale:
    "Project identity and managed state paths are resolved before the launch Adapter; this value does not configure a stack runtime.",
};

const mappedFunctionManifest: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "stack-functions-runtime",
  rationale:
    "The current stack functions runtime resolves every configured function entry, including enablement, JWT verification, paths, static files, and environment values.",
};

const functionConfigParity = {
  enabled: mappedFunctionManifest,
  verify_jwt: mappedFunctionManifest,
  import_map: mappedFunctionManifest,
  entrypoint: mappedFunctionManifest,
  static_files: mappedFunctionManifest,
  env: mappedFunctionManifest,
} satisfies Record<keyof ProjectConfig["functions"][string], Node>;

const mappedFunctionsDevEdgeRuntime: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "functions-dev",
  rationale:
    "The functions-dev Adapter resolves this field and passes it to the stack edge-runtime configuration.",
};

const commandOnlyDatabaseField: LocalStackConfigParityDecision = {
  _tag: "not-applicable",
  presence: "raw-document",
  rationale:
    "This field configures database tooling outside local stack startup and does not belong in StackConfig.",
};

const remoteOverlayField: LocalStackConfigParityDecision = {
  _tag: "not-applicable",
  presence: "raw-document",
  rationale:
    "Remote overlays are selected and merged by project configuration resolution before the local stack launch Adapter runs.",
};

const unsupportedFutureRuntimeField: LocalStackConfigParityDecision = {
  _tag: "unsupported-warning",
  presence: "raw-document",
  rationale:
    "This experimental field has no stable local stack contract yet; an explicit value must be surfaced rather than silently ignored.",
};

const authExternalProviderParity = {
  enabled: mappedAuthRuntimeField,
  client_id: mappedAuthRuntimeField,
  secret: mappedAuthSecretRuntimeField,
  url: mappedAuthRuntimeField,
  redirect_uri: mappedAuthRuntimeField,
  skip_nonce_check: mappedAuthRuntimeField,
  email_optional: mappedAuthRuntimeField,
} satisfies Record<keyof ProjectConfig["auth"]["external"]["apple"], Node>;

const authHookParity = {
  enabled: mappedAuthRuntimeField,
  uri: mappedAuthOptionalRuntimeField,
  secrets: mappedAuthSecretRuntimeField,
} satisfies Record<keyof ProjectConfig["auth"]["hook"]["send_email"], Node>;

const authRateLimitParity = {
  email_sent: unsupportedRuntimeField,
  sms_sent: unsupportedRuntimeField,
  anonymous_users: unsupportedRuntimeField,
  token_refresh: unsupportedRuntimeField,
  sign_in_sign_ups: unsupportedRuntimeField,
  token_verifications: unsupportedRuntimeField,
  web3: unsupportedRuntimeField,
} satisfies Record<keyof ProjectConfig["auth"]["rate_limit"], Node>;

const authExternalParity = {
  apple: authExternalProviderParity,
  azure: authExternalProviderParity,
  bitbucket: authExternalProviderParity,
  discord: authExternalProviderParity,
  facebook: authExternalProviderParity,
  github: authExternalProviderParity,
  gitlab: authExternalProviderParity,
  google: authExternalProviderParity,
  kakao: authExternalProviderParity,
  keycloak: authExternalProviderParity,
  linkedin_oidc: authExternalProviderParity,
  notion: authExternalProviderParity,
  twitch: authExternalProviderParity,
  twitter: authExternalProviderParity,
  x: authExternalProviderParity,
  slack_oidc: authExternalProviderParity,
  spotify: authExternalProviderParity,
  workos: authExternalProviderParity,
  zoom: authExternalProviderParity,
} satisfies Record<keyof ProjectConfig["auth"]["external"], Node>;

const authHooksParity = {
  mfa_verification_attempt: authHookParity,
  password_verification_attempt: authHookParity,
  custom_access_token: authHookParity,
  send_sms: authHookParity,
  send_email: authHookParity,
  before_user_created: authHookParity,
} satisfies Record<keyof ProjectConfig["auth"]["hook"], Node>;

const authSmsParity = {
  enable_signup: mappedAuthRuntimeField,
  enable_confirmations: mappedAuthRuntimeField,
  template: mappedAuthRuntimeField,
  max_frequency: mappedAuthRuntimeField,
  twilio: {
    enabled: mappedAuthRuntimeField,
    account_sid: mappedAuthRuntimeField,
    message_service_sid: mappedAuthRuntimeField,
    auth_token: mappedAuthSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["twilio"], Node>,
  twilio_verify: {
    enabled: mappedAuthRuntimeField,
    account_sid: mappedAuthOptionalRuntimeField,
    message_service_sid: mappedAuthOptionalRuntimeField,
    auth_token: mappedAuthSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["twilio_verify"], Node>,
  messagebird: {
    enabled: mappedAuthRuntimeField,
    originator: mappedAuthOptionalRuntimeField,
    access_key: mappedAuthSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["messagebird"], Node>,
  textlocal: {
    enabled: mappedAuthRuntimeField,
    sender: mappedAuthOptionalRuntimeField,
    api_key: mappedAuthSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["textlocal"], Node>,
  vonage: {
    enabled: mappedAuthRuntimeField,
    from: mappedAuthOptionalRuntimeField,
    api_key: mappedAuthOptionalRuntimeField,
    api_secret: mappedAuthSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["vonage"], Node>,
  test_otp: mappedAuthOptionalRuntimeField,
} satisfies Record<keyof ProjectConfig["auth"]["sms"], Node>;

const authParity = {
  enabled: mappedAuthRuntimeField,
  site_url: mappedAuthRuntimeField,
  additional_redirect_urls: mappedAuthRuntimeField,
  jwt_expiry: mappedAuthRuntimeField,
  jwt_issuer: mappedAuthOptionalRuntimeField,
  signing_keys_path: mappedAuthOptionalRuntimeField,
  enable_refresh_token_rotation: mappedAuthRuntimeField,
  refresh_token_reuse_interval: mappedAuthRuntimeField,
  enable_manual_linking: mappedAuthRuntimeField,
  enable_signup: mappedAuthRuntimeField,
  enable_anonymous_sign_ins: mappedAuthRuntimeField,
  minimum_password_length: mappedAuthRuntimeField,
  password_requirements: mappedAuthRuntimeField,
  publishable_key: mappedAuthSecretRuntimeField,
  secret_key: mappedAuthSecretRuntimeField,
  jwt_secret: mappedAuthSecretRuntimeField,
  anon_key: mappedAuthSecretRuntimeField,
  service_role_key: mappedAuthSecretRuntimeField,
  rate_limit: authRateLimitParity,
  captcha: {
    enabled: unsupportedRuntimeField,
    provider: unsupportedOptionalRuntimeField,
    secret: unsupportedSecretRuntimeField,
  } satisfies Record<keyof NonNullable<ProjectConfig["auth"]["captcha"]>, Node>,
  hook: authHooksParity,
  mfa: {
    totp: {
      enroll_enabled: unsupportedRuntimeField,
      verify_enabled: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["mfa"]["totp"], Node>,
    phone: {
      enroll_enabled: unsupportedRuntimeField,
      verify_enabled: unsupportedRuntimeField,
      otp_length: unsupportedRuntimeField,
      template: unsupportedRuntimeField,
      max_frequency: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["mfa"]["phone"], Node>,
    web_authn: {
      enroll_enabled: unsupportedRuntimeField,
      verify_enabled: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["mfa"]["web_authn"], Node>,
    max_enrolled_factors: unsupportedRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["mfa"], Node>,
  sessions: {
    timebox: unsupportedOptionalRuntimeField,
    inactivity_timeout: unsupportedOptionalRuntimeField,
  } satisfies Record<keyof NonNullable<ProjectConfig["auth"]["sessions"]>, Node>,
  email: {
    enable_signup: mappedAuthRuntimeField,
    double_confirm_changes: mappedAuthRuntimeField,
    enable_confirmations: mappedAuthRuntimeField,
    secure_password_change: mappedAuthRuntimeField,
    max_frequency: mappedAuthRuntimeField,
    otp_length: mappedAuthRuntimeField,
    otp_expiry: mappedAuthRuntimeField,
    smtp: {
      enabled: mappedAuthRuntimeField,
      host: mappedAuthOptionalRuntimeField,
      port: mappedAuthOptionalRuntimeField,
      user: mappedAuthOptionalRuntimeField,
      pass: mappedAuthSecretRuntimeField,
      admin_email: mappedAuthOptionalRuntimeField,
      sender_name: mappedAuthOptionalRuntimeField,
    } satisfies Record<keyof NonNullable<ProjectConfig["auth"]["email"]["smtp"]>, Node>,
    template: {
      "*": {
        subject: unsupportedRuntimeField,
        content_path: unsupportedRuntimeField,
      } satisfies Record<keyof ProjectConfig["auth"]["email"]["template"][string], Node>,
    },
    notification: {
      "*": {
        enabled: unsupportedRuntimeField,
        subject: unsupportedRuntimeField,
        content_path: unsupportedRuntimeField,
      } satisfies Record<keyof ProjectConfig["auth"]["email"]["notification"][string], Node>,
    },
  } satisfies Record<keyof ProjectConfig["auth"]["email"], Node>,
  sms: authSmsParity,
  external: authExternalParity,
  web3: {
    solana: {
      enabled: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["web3"]["solana"], Node>,
    ethereum: {
      enabled: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["web3"]["ethereum"], Node>,
  } satisfies Record<keyof ProjectConfig["auth"]["web3"], Node>,
  oauth_server: {
    enabled: unsupportedRuntimeField,
    authorization_url_path: unsupportedRuntimeField,
    allow_dynamic_registration: unsupportedRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["oauth_server"], Node>,
  third_party: {
    firebase: {
      enabled: unsupportedRuntimeField,
      project_id: unsupportedOptionalRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["third_party"]["firebase"], Node>,
    auth0: {
      enabled: unsupportedRuntimeField,
      tenant: unsupportedOptionalRuntimeField,
      tenant_region: unsupportedOptionalRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["third_party"]["auth0"], Node>,
    aws_cognito: {
      enabled: unsupportedRuntimeField,
      user_pool_id: unsupportedOptionalRuntimeField,
      user_pool_region: unsupportedOptionalRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["third_party"]["aws_cognito"], Node>,
    clerk: {
      enabled: unsupportedRuntimeField,
      domain: unsupportedOptionalRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["third_party"]["clerk"], Node>,
    workos: {
      enabled: unsupportedRuntimeField,
      issuer_url: unsupportedOptionalRuntimeField,
    } satisfies Record<keyof ProjectConfig["auth"]["third_party"]["workos"], Node>,
  } satisfies Record<keyof ProjectConfig["auth"]["third_party"], Node>,
} satisfies Record<keyof ProjectConfig["auth"], Node>;

const dbSettingsParity = {
  effective_cache_size: unsupportedOptionalRuntimeField,
  logical_decoding_work_mem: unsupportedOptionalRuntimeField,
  maintenance_work_mem: unsupportedOptionalRuntimeField,
  max_connections: unsupportedOptionalRuntimeField,
  max_locks_per_transaction: unsupportedOptionalRuntimeField,
  max_parallel_maintenance_workers: unsupportedOptionalRuntimeField,
  max_parallel_workers: unsupportedOptionalRuntimeField,
  max_parallel_workers_per_gather: unsupportedOptionalRuntimeField,
  max_replication_slots: unsupportedOptionalRuntimeField,
  max_slot_wal_keep_size: unsupportedOptionalRuntimeField,
  max_standby_archive_delay: unsupportedOptionalRuntimeField,
  max_standby_streaming_delay: unsupportedOptionalRuntimeField,
  max_wal_size: unsupportedOptionalRuntimeField,
  max_wal_senders: unsupportedOptionalRuntimeField,
  max_worker_processes: unsupportedOptionalRuntimeField,
  session_replication_role: unsupportedOptionalRuntimeField,
  shared_buffers: unsupportedOptionalRuntimeField,
  statement_timeout: unsupportedOptionalRuntimeField,
  track_activity_query_size: unsupportedOptionalRuntimeField,
  track_commit_timestamp: unsupportedOptionalRuntimeField,
  wal_keep_size: unsupportedOptionalRuntimeField,
  wal_sender_timeout: unsupportedOptionalRuntimeField,
  work_mem: unsupportedOptionalRuntimeField,
} satisfies Record<keyof NonNullable<ProjectConfig["db"]["settings"]>, Node>;

/**
 * Executable inventory for the current next local-stack implementation.
 *
 * Every fixed project-config object is checked against its schema-derived
 * `keyof` type. Adding or removing a field in `@supabase/config` therefore
 * requires an explicit parity decision here before the CLI type-check passes.
 * Dynamic records use `*` for user-provided keys while their fixed value shape
 * is checked exhaustively. Scalar-valued records such as vault and secrets are
 * classified at the record field itself.
 */
const localStackConfigParity = {
  project_id: projectIdentityField,
  analytics: {
    enabled: mappedCoreTopologyField,
    port: mappedCoreTopologyField,
    backend: mappedCoreTopologyField,
    vector_port: unsupportedOptionalRuntimeField,
    gcp_project_id: mappedOptionalDataPlaneRuntimeField,
    gcp_project_number: mappedOptionalDataPlaneRuntimeField,
    gcp_jwt_path: mappedOptionalDataPlaneRuntimeField,
  } satisfies Record<keyof ProjectConfig["analytics"], Node>,
  api: {
    enabled: mappedCoreTopologyField,
    port: mappedCoreTopologyField,
    schemas: mappedCoreTopologyField,
    extra_search_path: mappedCoreTopologyField,
    max_rows: mappedCoreTopologyField,
    auto_expose_new_tables: mappedAutoExposeNewTables,
    tls: {
      enabled: unsupportedRuntimeField,
      cert_path: unsupportedOptionalRuntimeField,
      key_path: unsupportedOptionalRuntimeField,
    } satisfies Record<keyof ProjectConfig["api"]["tls"], Node>,
    external_url: unsupportedOptionalRuntimeField,
  } satisfies Record<keyof ProjectConfig["api"], Node>,
  auth: authParity,
  db: {
    port: mappedCoreTopologyField,
    shadow_port: commandOnlyDatabaseField,
    health_timeout: mappedDatabaseHealthTimeout,
    major_version: unsupportedRuntimeField,
    pooler: {
      enabled: mappedCoreTopologyField,
      port: mappedCoreTopologyField,
      pool_mode: mappedCoreTopologyField,
      default_pool_size: mappedCoreTopologyField,
      max_client_conn: mappedCoreTopologyField,
    } satisfies Record<keyof ProjectConfig["db"]["pooler"], Node>,
    migrations: {
      enabled: unsupportedRuntimeField,
      schema_paths: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["db"]["migrations"], Node>,
    seed: {
      enabled: mappedDatabaseSeedField,
      sql_paths: mappedDatabaseSeedField,
    } satisfies Record<keyof ProjectConfig["db"]["seed"], Node>,
    settings: dbSettingsParity,
    network_restrictions: {
      enabled: commandOnlyDatabaseField,
      allowed_cidrs: commandOnlyDatabaseField,
      allowed_cidrs_v6: commandOnlyDatabaseField,
    } satisfies Record<keyof ProjectConfig["db"]["network_restrictions"], Node>,
    ssl_enforcement: {
      enabled: unsupportedRuntimeField,
    } satisfies Record<keyof NonNullable<ProjectConfig["db"]["ssl_enforcement"]>, Node>,
    vault: unsupportedSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["db"], Node>,
  edge_runtime: {
    enabled: mappedCoreTopologyField,
    policy: mappedCoreTopologyField,
    inspector_port: mappedCoreTopologyField,
    deno_version: unsupportedRuntimeField,
    secrets: mappedFunctionsDevEdgeRuntime,
  } satisfies Record<keyof ProjectConfig["edge_runtime"], Node>,
  functions: {
    "*": functionConfigParity,
  },
  local_smtp: {
    enabled: mappedCoreTopologyField,
    port: mappedCoreTopologyField,
    smtp_port: mappedCoreTopologyField,
    pop3_port: mappedCoreTopologyField,
    admin_email: mappedCoreTopologyField,
    sender_name: mappedCoreTopologyField,
  } satisfies Record<keyof ProjectConfig["local_smtp"], Node>,
  realtime: {
    enabled: mappedCoreTopologyField,
    ip_version: mappedDataPlaneRuntimeField,
    max_header_length: mappedCoreTopologyField,
  } satisfies Record<keyof ProjectConfig["realtime"], Node>,
  storage: {
    enabled: mappedCoreTopologyField,
    file_size_limit: mappedCoreTopologyField,
    image_transformation: {
      enabled: mappedCoreTopologyField,
    } satisfies Record<keyof NonNullable<ProjectConfig["storage"]["image_transformation"]>, Node>,
    buckets: {
      "*": {
        public: unsupportedRuntimeField,
        file_size_limit: unsupportedRuntimeField,
        allowed_mime_types: unsupportedRuntimeField,
        objects_path: unsupportedRuntimeField,
      } satisfies Record<keyof NonNullable<ProjectConfig["storage"]["buckets"]>[string], Node>,
    },
    s3_protocol: {
      enabled: mappedCoreTopologyField,
    } satisfies Record<keyof ProjectConfig["storage"]["s3_protocol"], Node>,
    analytics: {
      enabled: unsupportedRuntimeField,
      max_namespaces: unsupportedRuntimeField,
      max_tables: unsupportedRuntimeField,
      max_catalogs: unsupportedRuntimeField,
      buckets: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["storage"]["analytics"], Node>,
    vector: {
      enabled: mappedDataPlaneRuntimeField,
      max_buckets: unsupportedRuntimeField,
      max_indexes: unsupportedRuntimeField,
      buckets: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["storage"]["vector"], Node>,
  } satisfies Record<keyof ProjectConfig["storage"], Node>,
  studio: {
    enabled: mappedCoreTopologyField,
    port: mappedCoreTopologyField,
    api_url: mappedCoreTopologyField,
    openai_api_key: mappedOptionalDataPlaneRuntimeField,
  } satisfies Record<keyof ProjectConfig["studio"], Node>,
  experimental: {
    orioledb_version: unsupportedFutureRuntimeField,
    s3_host: unsupportedFutureRuntimeField,
    s3_region: unsupportedFutureRuntimeField,
    s3_access_key: unsupportedFutureRuntimeField,
    s3_secret_key: unsupportedFutureRuntimeField,
    webhooks: {
      enabled: unsupportedFutureRuntimeField,
    } satisfies Record<keyof NonNullable<ProjectConfig["experimental"]["webhooks"]>, Node>,
    pgdelta: {
      enabled: commandOnlyDatabaseField,
      declarative_schema_path: commandOnlyDatabaseField,
      format_options: commandOnlyDatabaseField,
    } satisfies Record<keyof NonNullable<ProjectConfig["experimental"]["pgdelta"]>, Node>,
    inspect: {
      rules: commandOnlyDatabaseField,
    } satisfies Record<keyof NonNullable<ProjectConfig["experimental"]["inspect"]>, Node>,
  } satisfies Record<keyof ProjectConfig["experimental"], Node>,
  remotes: remoteOverlayField,
} satisfies Record<keyof ProjectConfig, Node>;

export interface LocalStackConfigParityEntry {
  readonly path: string;
  readonly decision: LocalStackConfigParityDecision;
}

function isDecision(node: Node): node is LocalStackConfigParityDecision {
  return "_tag" in node;
}

/** Flattens the nested, compile-checked ledger for diagnostics and tests. */
export function flattenLocalStackConfigParity(
  section: LocalStackConfigParitySection = localStackConfigParity,
  prefix = "",
): ReadonlyArray<LocalStackConfigParityEntry> {
  return Object.entries(section).flatMap(([field, node]) => {
    const path = prefix === "" ? field : `${prefix}.${field}`;
    return isDecision(node)
      ? [{ path, decision: node }]
      : flattenLocalStackConfigParity(node, path);
  });
}
