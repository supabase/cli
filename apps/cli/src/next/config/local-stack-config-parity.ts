import type { ProjectConfig } from "@supabase/config";

/**
 * The disposition of one project-config leaf in the next local-stack flow.
 *
 * `presence` tells the future launch resolver how to determine whether a field
 * affects the local runtime. Most schema defaults erase the distinction between
 * an omitted field and an explicitly configured default value. Secrets need an
 * additional check: generated `env(...)` placeholders that did not resolve and
 * secrets inside disabled subtrees do not affect the runtime.
 */
type LocalStackConfigParityPresence = "decoded-value" | "effective-secret" | "raw-document";

type LocalStackConfigParityDecision =
  | {
      readonly _tag: "mapped";
      readonly presence: LocalStackConfigParityPresence;
      readonly mappedBy: "start" | "functions-dev" | "stack-functions-runtime";
      readonly rationale: string;
    }
  | {
      readonly _tag: "not-applicable";
      readonly presence: LocalStackConfigParityPresence;
      readonly rationale: string;
    }
  | {
      readonly _tag: "unsupported-blocking";
      readonly presence: LocalStackConfigParityPresence;
      readonly rationale: string;
    }
  | {
      readonly _tag: "unsupported-warning";
      readonly presence: LocalStackConfigParityPresence;
      readonly rationale: string;
    };

export interface LocalStackConfigParitySection {
  readonly [field: string]: Node;
}

interface LocalStackConfigParityBranch {
  readonly decision: LocalStackConfigParityDecision;
  readonly children: LocalStackConfigParitySection;
}

type Node =
  | LocalStackConfigParityDecision
  | LocalStackConfigParityBranch
  | LocalStackConfigParitySection;

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
  presence: "effective-secret",
  rationale:
    "A concrete resolved secret in an enabled runtime subtree changes local credentials but the next stack launch Adapter does not translate it yet; unresolved generated env placeholders do not count.",
};

const mappedAutoExposeNewTables: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "start",
  rationale:
    "The start command resolves the tri-state value, emits its deprecation warning, and passes it to PostgreSQL initialization.",
};

const mappedFunctionManifest: LocalStackConfigParityDecision = {
  _tag: "mapped",
  presence: "raw-document",
  mappedBy: "stack-functions-runtime",
  rationale:
    "The current stack functions runtime resolves every configured function entry, including enablement, JWT verification, paths, and static files.",
};

const unsupportedPerFunctionEnv: LocalStackConfigParityDecision = {
  _tag: "unsupported-blocking",
  presence: "raw-document",
  rationale:
    "The current stack functions runtime merges every function environment into one global record, so per-function overrides are not preserved.",
};

const functionConfigParity = {
  enabled: mappedFunctionManifest,
  verify_jwt: mappedFunctionManifest,
  import_map: mappedFunctionManifest,
  entrypoint: mappedFunctionManifest,
  static_files: mappedFunctionManifest,
  env: unsupportedPerFunctionEnv,
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

const projectMetadataField: LocalStackConfigParityDecision = {
  _tag: "not-applicable",
  presence: "raw-document",
  rationale:
    "The project identifier distinguishes local project directories and is not local stack runtime configuration.",
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
  enabled: unsupportedRuntimeField,
  client_id: unsupportedRuntimeField,
  secret: unsupportedSecretRuntimeField,
  url: unsupportedRuntimeField,
  redirect_uri: unsupportedRuntimeField,
  skip_nonce_check: unsupportedRuntimeField,
  email_optional: unsupportedRuntimeField,
} satisfies Record<keyof ProjectConfig["auth"]["external"]["apple"], Node>;

type AuthExternalParity = {
  readonly [Provider in keyof ProjectConfig["auth"]["external"]]: Record<
    keyof ProjectConfig["auth"]["external"][Provider],
    Node
  >;
};

const authHookParity = {
  enabled: unsupportedRuntimeField,
  uri: unsupportedOptionalRuntimeField,
  secrets: unsupportedSecretRuntimeField,
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
} satisfies AuthExternalParity;

const authHooksParity = {
  mfa_verification_attempt: authHookParity,
  password_verification_attempt: authHookParity,
  custom_access_token: authHookParity,
  send_sms: authHookParity,
  send_email: authHookParity,
  before_user_created: authHookParity,
} satisfies Record<keyof ProjectConfig["auth"]["hook"], Node>;

const authSmsParity = {
  enable_signup: unsupportedRuntimeField,
  enable_confirmations: unsupportedRuntimeField,
  template: unsupportedRuntimeField,
  max_frequency: unsupportedRuntimeField,
  twilio: {
    enabled: unsupportedRuntimeField,
    account_sid: unsupportedRuntimeField,
    message_service_sid: unsupportedRuntimeField,
    auth_token: unsupportedSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["twilio"], Node>,
  twilio_verify: {
    enabled: unsupportedRuntimeField,
    account_sid: unsupportedOptionalRuntimeField,
    message_service_sid: unsupportedOptionalRuntimeField,
    auth_token: unsupportedSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["twilio_verify"], Node>,
  messagebird: {
    enabled: unsupportedRuntimeField,
    originator: unsupportedOptionalRuntimeField,
    access_key: unsupportedSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["messagebird"], Node>,
  textlocal: {
    enabled: unsupportedRuntimeField,
    sender: unsupportedOptionalRuntimeField,
    api_key: unsupportedSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["textlocal"], Node>,
  vonage: {
    enabled: unsupportedRuntimeField,
    from: unsupportedOptionalRuntimeField,
    api_key: unsupportedOptionalRuntimeField,
    api_secret: unsupportedSecretRuntimeField,
  } satisfies Record<keyof ProjectConfig["auth"]["sms"]["vonage"], Node>,
  test_otp: unsupportedOptionalRuntimeField,
} satisfies Record<keyof ProjectConfig["auth"]["sms"], Node>;

const authParity = {
  enabled: unsupportedRuntimeField,
  site_url: unsupportedRuntimeField,
  additional_redirect_urls: unsupportedRuntimeField,
  jwt_expiry: unsupportedRuntimeField,
  jwt_issuer: unsupportedOptionalRuntimeField,
  signing_keys_path: unsupportedOptionalRuntimeField,
  enable_refresh_token_rotation: unsupportedRuntimeField,
  refresh_token_reuse_interval: unsupportedRuntimeField,
  enable_manual_linking: unsupportedRuntimeField,
  enable_signup: unsupportedRuntimeField,
  enable_anonymous_sign_ins: unsupportedRuntimeField,
  minimum_password_length: unsupportedRuntimeField,
  password_requirements: unsupportedRuntimeField,
  publishable_key: unsupportedSecretRuntimeField,
  secret_key: unsupportedSecretRuntimeField,
  jwt_secret: unsupportedSecretRuntimeField,
  anon_key: unsupportedSecretRuntimeField,
  service_role_key: unsupportedSecretRuntimeField,
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
    enable_signup: unsupportedRuntimeField,
    double_confirm_changes: unsupportedRuntimeField,
    enable_confirmations: unsupportedRuntimeField,
    secure_password_change: unsupportedRuntimeField,
    max_frequency: unsupportedRuntimeField,
    otp_length: unsupportedRuntimeField,
    otp_expiry: unsupportedRuntimeField,
    smtp: {
      enabled: unsupportedRuntimeField,
      host: unsupportedOptionalRuntimeField,
      port: unsupportedOptionalRuntimeField,
      user: unsupportedOptionalRuntimeField,
      pass: unsupportedSecretRuntimeField,
      admin_email: unsupportedOptionalRuntimeField,
      sender_name: unsupportedOptionalRuntimeField,
    } satisfies Record<keyof NonNullable<ProjectConfig["auth"]["email"]["smtp"]>, Node>,
    template: {
      "*": {
        decision: unsupportedRuntimeField,
        children: {
          subject: unsupportedRuntimeField,
          content_path: unsupportedRuntimeField,
        } satisfies Record<keyof ProjectConfig["auth"]["email"]["template"][string], Node>,
      },
    },
    notification: {
      "*": {
        decision: unsupportedRuntimeField,
        children: {
          enabled: unsupportedRuntimeField,
          subject: unsupportedRuntimeField,
          content_path: unsupportedRuntimeField,
        } satisfies Record<keyof ProjectConfig["auth"]["email"]["notification"][string], Node>,
      },
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
  project_id: projectMetadataField,
  analytics: {
    enabled: unsupportedRuntimeField,
    port: unsupportedRuntimeField,
    backend: unsupportedRuntimeField,
    vector_port: unsupportedOptionalRuntimeField,
    gcp_project_id: unsupportedOptionalRuntimeField,
    gcp_project_number: unsupportedOptionalRuntimeField,
    gcp_jwt_path: unsupportedOptionalRuntimeField,
  } satisfies Record<keyof ProjectConfig["analytics"], Node>,
  api: {
    enabled: unsupportedRuntimeField,
    port: unsupportedRuntimeField,
    schemas: unsupportedRuntimeField,
    extra_search_path: unsupportedRuntimeField,
    max_rows: unsupportedRuntimeField,
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
    port: unsupportedRuntimeField,
    shadow_port: commandOnlyDatabaseField,
    health_timeout: unsupportedRuntimeField,
    major_version: unsupportedRuntimeField,
    pooler: {
      enabled: unsupportedRuntimeField,
      port: unsupportedRuntimeField,
      pool_mode: unsupportedRuntimeField,
      default_pool_size: unsupportedRuntimeField,
      max_client_conn: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["db"]["pooler"], Node>,
    migrations: {
      enabled: unsupportedRuntimeField,
      schema_paths: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["db"]["migrations"], Node>,
    seed: {
      enabled: unsupportedRuntimeField,
      sql_paths: unsupportedRuntimeField,
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
    enabled: mappedFunctionsDevEdgeRuntime,
    policy: mappedFunctionsDevEdgeRuntime,
    inspector_port: mappedFunctionsDevEdgeRuntime,
    deno_version: unsupportedRuntimeField,
    secrets: mappedFunctionsDevEdgeRuntime,
  } satisfies Record<keyof ProjectConfig["edge_runtime"], Node>,
  functions: {
    "*": {
      decision: mappedFunctionManifest,
      children: functionConfigParity,
    },
  },
  local_smtp: {
    enabled: unsupportedRuntimeField,
    port: unsupportedRuntimeField,
    smtp_port: unsupportedOptionalRuntimeField,
    pop3_port: unsupportedOptionalRuntimeField,
    admin_email: unsupportedOptionalRuntimeField,
    sender_name: unsupportedOptionalRuntimeField,
  } satisfies Record<keyof ProjectConfig["local_smtp"], Node>,
  realtime: {
    enabled: unsupportedRuntimeField,
    ip_version: unsupportedRuntimeField,
    max_header_length: unsupportedRuntimeField,
  } satisfies Record<keyof ProjectConfig["realtime"], Node>,
  storage: {
    enabled: unsupportedRuntimeField,
    file_size_limit: unsupportedRuntimeField,
    image_transformation: {
      enabled: unsupportedRuntimeField,
    } satisfies Record<keyof NonNullable<ProjectConfig["storage"]["image_transformation"]>, Node>,
    buckets: {
      "*": {
        decision: unsupportedRuntimeField,
        children: {
          public: unsupportedRuntimeField,
          file_size_limit: unsupportedRuntimeField,
          allowed_mime_types: unsupportedRuntimeField,
          objects_path: unsupportedRuntimeField,
        } satisfies Record<keyof NonNullable<ProjectConfig["storage"]["buckets"]>[string], Node>,
      },
    },
    s3_protocol: {
      enabled: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["storage"]["s3_protocol"], Node>,
    analytics: {
      enabled: unsupportedRuntimeField,
      max_namespaces: unsupportedRuntimeField,
      max_tables: unsupportedRuntimeField,
      max_catalogs: unsupportedRuntimeField,
      buckets: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["storage"]["analytics"], Node>,
    vector: {
      enabled: unsupportedRuntimeField,
      max_buckets: unsupportedRuntimeField,
      max_indexes: unsupportedRuntimeField,
      buckets: unsupportedRuntimeField,
    } satisfies Record<keyof ProjectConfig["storage"]["vector"], Node>,
  } satisfies Record<keyof ProjectConfig["storage"], Node>,
  studio: {
    enabled: unsupportedRuntimeField,
    port: unsupportedRuntimeField,
    api_url: unsupportedRuntimeField,
    openai_api_key: unsupportedSecretRuntimeField,
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

function isBranch(node: Node): node is LocalStackConfigParityBranch {
  return "decision" in node && "children" in node;
}

/** Flattens the nested, compile-checked ledger for diagnostics and tests. */
export function flattenLocalStackConfigParity(
  section: LocalStackConfigParitySection = localStackConfigParity,
  prefix = "",
): ReadonlyArray<LocalStackConfigParityEntry> {
  return Object.entries(section).flatMap(([field, node]) => {
    const path = prefix === "" ? field : `${prefix}.${field}`;
    if (isDecision(node)) {
      return [{ path, decision: node }];
    }
    if (isBranch(node)) {
      return [
        { path, decision: node.decision },
        ...flattenLocalStackConfigParity(node.children, path),
      ];
    }
    return flattenLocalStackConfigParity(node, path);
  });
}
