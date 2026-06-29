import * as Schema from "effect/Schema";

// non-recursive definitions
export const BranchResponse = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  name: Schema.String,
  project_ref: Schema.String,
  parent_project_ref: Schema.String,
  is_default: Schema.Boolean,
  git_branch: Schema.optionalKey(Schema.String),
  pr_number: Schema.optionalKey(Schema.Number.annotate({ format: "int32" }).check(Schema.isInt())),
  latest_check_run_id: Schema.optionalKey(
    Schema.Number.annotate({
      description: "This field is deprecated and will not be populated.",
    }).check(Schema.isFinite()),
  ),
  persistent: Schema.Boolean,
  status: Schema.Literals([
    "CREATING_PROJECT",
    "RUNNING_MIGRATIONS",
    "MIGRATIONS_PASSED",
    "MIGRATIONS_FAILED",
    "FUNCTIONS_DEPLOYED",
    "FUNCTIONS_FAILED",
  ]).annotate({
    description: "This field is deprecated. List action runs to get branch status instead.",
  }),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
  review_requested_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  with_data: Schema.Boolean,
  notify_url: Schema.optionalKey(Schema.String.annotate({ format: "uri" })),
  deletion_scheduled_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  preview_project_status: Schema.optionalKey(
    Schema.Literals([
      "INACTIVE",
      "ACTIVE_HEALTHY",
      "ACTIVE_UNHEALTHY",
      "COMING_UP",
      "UNKNOWN",
      "GOING_DOWN",
      "INIT_FAILED",
      "REMOVED",
      "RESTORING",
      "UPGRADING",
      "PAUSING",
      "RESTORE_FAILED",
      "RESTARTING",
      "PAUSE_FAILED",
      "RESIZING",
    ]),
  ),
});
export const V1ProjectWithDatabaseResponse = Schema.Struct({
  id: Schema.String.annotate({ description: "Deprecated: Use `ref` instead." }),
  ref: Schema.String.annotate({ description: "Project ref" })
    .check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  organization_id: Schema.String.annotate({
    description: "Deprecated: Use `organization_slug` instead.",
  }),
  organization_slug: Schema.String.annotate({ description: "Organization slug" }).check(
    Schema.isPattern(new RegExp("^[\\w-]+$")),
  ),
  name: Schema.String.annotate({ description: "Name of your project" }),
  region: Schema.String.annotate({ description: "Region of your project" }),
  created_at: Schema.String.annotate({ description: "Creation timestamp" }),
  status: Schema.Literals([
    "INACTIVE",
    "ACTIVE_HEALTHY",
    "ACTIVE_UNHEALTHY",
    "COMING_UP",
    "UNKNOWN",
    "GOING_DOWN",
    "INIT_FAILED",
    "REMOVED",
    "RESTORING",
    "UPGRADING",
    "PAUSING",
    "RESTORE_FAILED",
    "RESTARTING",
    "PAUSE_FAILED",
    "RESIZING",
  ]),
  database: Schema.Struct({
    host: Schema.String.annotate({ description: "Database host" }),
    version: Schema.String.annotate({ description: "Database version" }),
    postgres_engine: Schema.String.annotate({ description: "Database engine" }),
    release_channel: Schema.String.annotate({ description: "Release channel" }),
  }),
});
export const OrganizationResponseV1 = Schema.Struct({
  id: Schema.String.annotate({ description: "Deprecated: Use `slug` instead." }),
  slug: Schema.String.annotate({ description: "Organization slug" }).check(
    Schema.isPattern(new RegExp("^[\\w-]+$")),
  ),
  name: Schema.String,
});
export const ApiKeyResponse = Schema.Struct({
  api_key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  type: Schema.optionalKey(
    Schema.Union([
      Schema.Literals(["legacy", "publishable", "secret"]),
      Schema.Union([Schema.Null]),
    ]),
  ),
  prefix: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  name: Schema.String,
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hash: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  secret_jwt_template: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.Null]),
  ),
  inserted_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
  updated_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
});
export const SecretResponse = Schema.Struct({
  name: Schema.String,
  value: Schema.String,
  updated_at: Schema.optionalKey(Schema.String),
});
export const V1ServiceHealthResponse = Schema.Struct({
  name: Schema.Literals([
    "auth",
    "db",
    "db_postgres_user",
    "pooler",
    "realtime",
    "rest",
    "storage",
    "pg_bouncer",
  ]),
  healthy: Schema.Boolean.annotate({ description: "Deprecated. Use `status` instead." }),
  status: Schema.Literals(["COMING_UP", "ACTIVE_HEALTHY", "UNHEALTHY"]),
  info: Schema.optionalKey(
    Schema.Union(
      [
        Schema.Struct({
          name: Schema.Literal("GoTrue"),
          version: Schema.String,
          description: Schema.String,
        }),
        Schema.Struct({
          healthy: Schema.Boolean.annotate({ description: "Deprecated. Use `status` instead." }),
          db_connected: Schema.Boolean,
          replication_connected: Schema.Boolean,
          connected_cluster: Schema.Number.check(Schema.isInt()),
        }),
        Schema.Struct({ db_schema: Schema.String }),
      ],
      { mode: "oneOf" },
    ),
  ),
  error: Schema.optionalKey(Schema.String),
});
export const ThirdPartyAuth = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  type: Schema.String,
  oidc_issuer_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  jwks_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  custom_jwks: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  resolved_jwks: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  inserted_at: Schema.String,
  updated_at: Schema.String,
  resolved_at: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});
export const FunctionResponse = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["ACTIVE", "REMOVED", "THROTTLED"]),
  version: Schema.Number.check(Schema.isInt()),
  created_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  updated_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.Boolean),
  entrypoint_path: Schema.optionalKey(Schema.String),
  import_map_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  ezbr_sha256: Schema.optionalKey(Schema.String),
});
export const V1StorageBucketResponse = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  owner: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  public: Schema.Boolean,
});
export const SupavisorConfigResponse = Schema.Struct({
  identifier: Schema.String,
  database_type: Schema.Literals(["PRIMARY", "READ_REPLICA"]),
  is_using_scram_auth: Schema.Boolean,
  db_user: Schema.String,
  db_host: Schema.String,
  db_port: Schema.Number.check(Schema.isInt()),
  db_name: Schema.String,
  connection_string: Schema.String,
  connectionString: Schema.String.annotate({ description: "Use connection_string instead" }),
  default_pool_size: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  max_client_conn: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  pool_mode: Schema.Literals(["transaction", "session"]),
});
export const V1OrganizationMemberResponse = Schema.Struct({
  user_id: Schema.String,
  user_name: Schema.String,
  email: Schema.optionalKey(Schema.String),
  role_name: Schema.String,
  mfa_enabled: Schema.Boolean,
  avatar_url: Schema.Union([Schema.String, Schema.Null]),
});
// binary input helpers
export const BinaryInput = Schema.Union([
  Schema.Uint8Array,
  Schema.instanceOf(globalThis.ArrayBuffer, { expected: "ArrayBuffer" }),
  Schema.instanceOf(globalThis.Blob, { expected: "Blob" }),
]);
// operation schemas
export const V1AcceptInviteExternalJitAccessInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  email: Schema.String.annotate({ format: "email" }).check(Schema.isMinLength(1)),
  token: Schema.String.check(Schema.isMinLength(1)),
});
export const V1AcceptInviteExternalJitAccessOutput = Schema.Struct({
  user_id: Schema.optionalKey(
    Schema.String.annotate({ format: "uuid" }).check(
      Schema.isPattern(
        new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
      ),
    ),
  ),
  user_roles: Schema.Array(
    Schema.Struct({
      role: Schema.String.check(Schema.isMinLength(1)),
      expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      allowed_networks: Schema.optionalKey(
        Schema.Struct({
          allowed_cidrs: Schema.optionalKey(Schema.Array(Schema.Struct({ cidr: Schema.String }))),
          allowed_cidrs_v6: Schema.optionalKey(
            Schema.Array(Schema.Struct({ cidr: Schema.String })),
          ),
        }),
      ),
      branches_only: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export const V1ActivateCustomHostnameInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ActivateCustomHostnameOutput = Schema.Struct({
  status: Schema.optionalKey(
    Schema.Literals([
      "1_not_started",
      "2_initiated",
      "3_challenge_verified",
      "4_origin_setup_completed",
      "5_services_reconfigured",
    ]),
  ),
  custom_hostname: Schema.optionalKey(Schema.String),
  data: Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.Array(Schema.Json.annotate({ description: "Any JSON-serializable value" })),
    messages: Schema.Array(Schema.Json.annotate({ description: "Any JSON-serializable value" })),
    result: Schema.Struct({
      id: Schema.String,
      hostname: Schema.String,
      ssl: Schema.Struct({
        status: Schema.String,
        validation_records: Schema.optionalKey(
          Schema.Array(Schema.Struct({ txt_name: Schema.String, txt_value: Schema.String })),
        ),
        validation_errors: Schema.optionalKey(
          Schema.Array(Schema.Struct({ message: Schema.String })),
        ),
      }),
      ownership_verification: Schema.optionalKey(
        Schema.Struct({ type: Schema.String, name: Schema.String, value: Schema.String }),
      ),
      custom_origin_server: Schema.String,
      verification_errors: Schema.optionalKey(Schema.Array(Schema.String)),
      status: Schema.String,
    }),
  }),
});
export const V1ActivateVanitySubdomainConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  vanity_subdomain: Schema.String.check(Schema.isMaxLength(63)),
});
export const V1ActivateVanitySubdomainConfigOutput = Schema.Struct({
  custom_domain: Schema.String,
});
export const V1ApplyAMigrationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  "Idempotency-Key": Schema.optionalKey(Schema.String),
  query: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.optionalKey(Schema.String),
  rollback: Schema.optionalKey(Schema.String),
});
export const V1ApplyProjectAddonInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  addon_variant: Schema.Union(
    [
      Schema.Literals([
        "ci_micro",
        "ci_small",
        "ci_medium",
        "ci_large",
        "ci_xlarge",
        "ci_2xlarge",
        "ci_4xlarge",
        "ci_8xlarge",
        "ci_12xlarge",
        "ci_16xlarge",
        "ci_24xlarge",
        "ci_24xlarge_optimized_cpu",
        "ci_24xlarge_optimized_memory",
        "ci_24xlarge_high_memory",
        "ci_48xlarge",
        "ci_48xlarge_optimized_cpu",
        "ci_48xlarge_optimized_memory",
        "ci_48xlarge_high_memory",
      ]),
      Schema.Literal("cd_default"),
      Schema.Literals(["pitr_7", "pitr_14", "pitr_28"]),
      Schema.Literal("ipv4_default"),
    ],
    { mode: "oneOf" },
  ),
  addon_type: Schema.Literals([
    "custom_domain",
    "compute_instance",
    "pitr",
    "ipv4",
    "auth_mfa_phone",
    "auth_mfa_web_authn",
    "log_drain",
    "etl_pipeline",
  ]),
});
export const V1AuthorizeJitAccessInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  role: Schema.String.check(Schema.isMinLength(1)),
  rhost: Schema.String.check(Schema.isMinLength(1)),
});
export const V1AuthorizeJitAccessOutput = Schema.Struct({
  user_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  user_role: Schema.Struct({
    role: Schema.String.check(Schema.isMinLength(1)),
    expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
    allowed_networks: Schema.optionalKey(
      Schema.Struct({
        allowed_cidrs: Schema.optionalKey(Schema.Array(Schema.Struct({ cidr: Schema.String }))),
        allowed_cidrs_v6: Schema.optionalKey(Schema.Array(Schema.Struct({ cidr: Schema.String }))),
      }),
    ),
    branches_only: Schema.optionalKey(Schema.Boolean),
  }),
});
export const V1AuthorizeUserInput = Schema.Struct({
  client_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  response_type: Schema.Literals(["code", "token", "id_token token"]),
  redirect_uri: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  response_mode: Schema.optionalKey(Schema.String),
  code_challenge: Schema.optionalKey(Schema.String),
  code_challenge_method: Schema.optionalKey(Schema.Literals(["plain", "sha256", "S256"])),
  organization_slug: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(new RegExp("^[\\w-]+$"))),
  ),
  target_flow: Schema.optionalKey(Schema.String),
  resource: Schema.optionalKey(Schema.String.annotate({ format: "uri" })),
});
export const V1BulkCreateSecretsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  body: Schema.Array(
    Schema.Struct({
      name: Schema.String.annotate({
        description: "Secret name must not start with the SUPABASE_ prefix.",
      })
        .check(Schema.isMaxLength(256))
        .check(Schema.isPattern(new RegExp("^(?!SUPABASE_).*"))),
      value: Schema.String.check(Schema.isMaxLength(24576)),
    }),
  ),
});
export const V1BulkDeleteSecretsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  body: Schema.Array(Schema.String),
});
export const V1BulkUpdateFunctionsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  body: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      slug: Schema.String.check(Schema.isPattern(new RegExp("^[A-Za-z][A-Za-z0-9_-]*$"))),
      name: Schema.String,
      status: Schema.Literals(["ACTIVE", "REMOVED", "THROTTLED"]),
      version: Schema.Number.check(Schema.isInt()),
      created_at: Schema.optionalKey(
        Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      ),
      verify_jwt: Schema.optionalKey(Schema.Boolean),
      import_map: Schema.optionalKey(Schema.Boolean),
      entrypoint_path: Schema.optionalKey(Schema.String),
      import_map_path: Schema.optionalKey(Schema.String),
      ezbr_sha256: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const V1BulkUpdateFunctionsOutput = Schema.Struct({
  functions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      slug: Schema.String,
      name: Schema.String,
      status: Schema.Literals(["ACTIVE", "REMOVED", "THROTTLED"]),
      version: Schema.Number.check(Schema.isInt()),
      created_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      updated_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
      verify_jwt: Schema.optionalKey(Schema.Boolean),
      import_map: Schema.optionalKey(Schema.Boolean),
      entrypoint_path: Schema.optionalKey(Schema.String),
      import_map_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
      ezbr_sha256: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const V1CancelAProjectRestorationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1CheckVanitySubdomainAvailabilityInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  vanity_subdomain: Schema.String.check(Schema.isMaxLength(63)),
});
export const V1CheckVanitySubdomainAvailabilityOutput = Schema.Struct({
  available: Schema.Boolean,
});
export const V1ClaimProjectForOrganizationInput = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(new RegExp("^[\\w-]+$"))),
  token: Schema.String,
});
export const V1CountActionRunsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1CreateABranchInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  branch_name: Schema.String.check(Schema.isMinLength(1)),
  git_branch: Schema.optionalKey(Schema.String),
  is_default: Schema.optionalKey(Schema.Boolean),
  persistent: Schema.optionalKey(Schema.Boolean),
  region: Schema.optionalKey(Schema.String),
  desired_instance_size: Schema.optionalKey(
    Schema.Literals([
      "pico",
      "nano",
      "micro",
      "small",
      "medium",
      "large",
      "xlarge",
      "2xlarge",
      "4xlarge",
      "8xlarge",
      "12xlarge",
      "16xlarge",
      "24xlarge",
      "24xlarge_optimized_memory",
      "24xlarge_optimized_cpu",
      "24xlarge_high_memory",
      "48xlarge",
      "48xlarge_optimized_memory",
      "48xlarge_optimized_cpu",
      "48xlarge_high_memory",
    ]),
  ),
  release_channel: Schema.optionalKey(
    Schema.Literals(["internal", "alpha", "beta", "ga", "withdrawn", "preview"]).annotate({
      description: "Release channel. If not provided, GA will be used.",
    }),
  ),
  postgres_engine: Schema.optionalKey(
    Schema.Literals(["15", "17", "17-oriole"]).annotate({
      description: "Postgres engine version. If not provided, the latest version will be used.",
    }),
  ),
  secrets: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  with_data: Schema.optionalKey(Schema.Boolean),
  notify_url: Schema.optionalKey(
    Schema.String.annotate({
      description: "HTTP endpoint to receive branch status updates.",
      format: "uri",
    }),
  ),
});
export const V1CreateABranchOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  name: Schema.String,
  project_ref: Schema.String,
  parent_project_ref: Schema.String,
  is_default: Schema.Boolean,
  git_branch: Schema.optionalKey(Schema.String),
  pr_number: Schema.optionalKey(Schema.Number.annotate({ format: "int32" }).check(Schema.isInt())),
  latest_check_run_id: Schema.optionalKey(
    Schema.Number.annotate({
      description: "This field is deprecated and will not be populated.",
    }).check(Schema.isFinite()),
  ),
  persistent: Schema.Boolean,
  status: Schema.Literals([
    "CREATING_PROJECT",
    "RUNNING_MIGRATIONS",
    "MIGRATIONS_PASSED",
    "MIGRATIONS_FAILED",
    "FUNCTIONS_DEPLOYED",
    "FUNCTIONS_FAILED",
  ]).annotate({
    description: "This field is deprecated. List action runs to get branch status instead.",
  }),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
  review_requested_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  with_data: Schema.Boolean,
  notify_url: Schema.optionalKey(Schema.String.annotate({ format: "uri" })),
  deletion_scheduled_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  preview_project_status: Schema.optionalKey(
    Schema.Literals([
      "INACTIVE",
      "ACTIVE_HEALTHY",
      "ACTIVE_UNHEALTHY",
      "COMING_UP",
      "UNKNOWN",
      "GOING_DOWN",
      "INIT_FAILED",
      "REMOVED",
      "RESTORING",
      "UPGRADING",
      "PAUSING",
      "RESTORE_FAILED",
      "RESTARTING",
      "PAUSE_FAILED",
      "RESIZING",
    ]),
  ),
});
export const V1CreateAFunctionInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  slug: Schema.optionalKey(Schema.String.check(Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$")))),
  name: Schema.optionalKey(Schema.String),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.Boolean),
  entrypoint_path: Schema.optionalKey(Schema.String),
  import_map_path: Schema.optionalKey(Schema.String),
  ezbr_sha256: Schema.optionalKey(Schema.String),
  body: BinaryInput,
});
export const V1CreateAFunctionOutput = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["ACTIVE", "REMOVED", "THROTTLED"]),
  version: Schema.Number.check(Schema.isInt()),
  created_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  updated_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.Boolean),
  entrypoint_path: Schema.optionalKey(Schema.String),
  import_map_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  ezbr_sha256: Schema.optionalKey(Schema.String),
});
export const V1CreateAProjectInput = Schema.Struct({
  db_pass: Schema.String.annotate({ description: "Database password" }),
  name: Schema.String.annotate({ description: "Name of your project" }).check(
    Schema.isMaxLength(256),
  ),
  organization_id: Schema.optionalKey(
    Schema.String.annotate({ description: "Deprecated: Use `organization_slug` instead." }),
  ),
  organization_slug: Schema.String.annotate({ description: "Organization slug" }).check(
    Schema.isPattern(new RegExp("^[\\w-]+$")),
  ),
  plan: Schema.optionalKey(
    Schema.Literals(["free", "pro"]).annotate({
      description:
        "Subscription Plan is now set on organization level and is ignored in this request",
    }),
  ),
  region: Schema.optionalKey(
    Schema.Literals([
      "us-east-1",
      "us-east-2",
      "us-west-1",
      "us-west-2",
      "ap-east-1",
      "ap-southeast-1",
      "ap-northeast-1",
      "ap-northeast-2",
      "ap-southeast-2",
      "eu-west-1",
      "eu-west-2",
      "eu-west-3",
      "eu-north-1",
      "eu-central-1",
      "eu-central-2",
      "ca-central-1",
      "ap-south-1",
      "sa-east-1",
    ]).annotate({
      description: "Region you want your server to reside in. Use region_selection instead.",
    }),
  ),
  region_selection: Schema.optionalKey(
    Schema.Union(
      [
        Schema.Struct({
          type: Schema.Literal("specific"),
          code: Schema.Literals([
            "us-east-1",
            "us-east-2",
            "us-west-1",
            "us-west-2",
            "ap-east-1",
            "ap-southeast-1",
            "ap-northeast-1",
            "ap-northeast-2",
            "ap-southeast-2",
            "eu-west-1",
            "eu-west-2",
            "eu-west-3",
            "eu-north-1",
            "eu-central-1",
            "eu-central-2",
            "ca-central-1",
            "ap-south-1",
            "sa-east-1",
          ]).annotate({
            description:
              "Specific region code. The codes supported are not a stable API, and should be retrieved from the /available-regions endpoint.",
          }),
        }),
        Schema.Struct({
          type: Schema.Literal("smartGroup"),
          code: Schema.Literals(["americas", "emea", "apac"]).annotate({
            description:
              "The Smart Region Group's code. The codes supported are not a stable API, and should be retrieved from the /available-regions endpoint.",
          }),
        }),
      ],
      { mode: "oneOf" },
    ).annotate({
      description: "Region selection. Only one of region or region_selection can be specified.",
    }),
  ),
  kps_enabled: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "This field is deprecated and is ignored in this request",
    }),
  ),
  desired_instance_size: Schema.optionalKey(
    Schema.Literals([
      "nano",
      "micro",
      "small",
      "medium",
      "large",
      "xlarge",
      "2xlarge",
      "4xlarge",
      "8xlarge",
      "12xlarge",
      "16xlarge",
      "24xlarge",
      "24xlarge_optimized_memory",
      "24xlarge_optimized_cpu",
      "24xlarge_high_memory",
      "48xlarge",
      "48xlarge_optimized_memory",
      "48xlarge_optimized_cpu",
      "48xlarge_high_memory",
    ]).annotate({
      description:
        "Desired instance size. Omit this field to always default to the smallest possible size.",
    }),
  ),
  template_url: Schema.optionalKey(
    Schema.String.annotate({
      description: "Template URL used to create the project from the CLI.",
      format: "uri",
    }),
  ),
  high_availability: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "[Experimental] Whether to enable high availability for the project.",
    }),
  ),
});
export const V1CreateAProjectOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Deprecated: Use `ref` instead." }),
  ref: Schema.String.annotate({ description: "Project ref" })
    .check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  organization_id: Schema.String.annotate({
    description: "Deprecated: Use `organization_slug` instead.",
  }),
  organization_slug: Schema.String.annotate({ description: "Organization slug" }).check(
    Schema.isPattern(new RegExp("^[\\w-]+$")),
  ),
  name: Schema.String.annotate({ description: "Name of your project" }),
  region: Schema.String.annotate({ description: "Region of your project" }),
  created_at: Schema.String.annotate({ description: "Creation timestamp" }),
  status: Schema.Literals([
    "INACTIVE",
    "ACTIVE_HEALTHY",
    "ACTIVE_UNHEALTHY",
    "COMING_UP",
    "UNKNOWN",
    "GOING_DOWN",
    "INIT_FAILED",
    "REMOVED",
    "RESTORING",
    "UPGRADING",
    "PAUSING",
    "RESTORE_FAILED",
    "RESTARTING",
    "PAUSE_FAILED",
    "RESIZING",
  ]),
});
export const V1CreateASsoProviderInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  type: Schema.Literal("saml").annotate({ description: "What type of provider will be created" }),
  metadata_xml: Schema.optionalKey(Schema.String),
  metadata_url: Schema.optionalKey(Schema.String),
  domains: Schema.optionalKey(Schema.Array(Schema.String)),
  attribute_mapping: Schema.optionalKey(
    Schema.Struct({
      keys: Schema.Record(
        Schema.String,
        Schema.Struct({
          name: Schema.optionalKey(Schema.String),
          names: Schema.optionalKey(Schema.Array(Schema.String)),
          default: Schema.optionalKey(
            Schema.Union(
              [
                Schema.Struct({}),
                Schema.Number.check(Schema.isFinite()),
                Schema.String,
                Schema.Boolean,
              ],
              { mode: "oneOf" },
            ),
          ),
          array: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  ),
  name_id_format: Schema.optionalKey(
    Schema.Literals([
      "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
      "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
      "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    ]),
  ),
});
export const V1CreateASsoProviderOutput = Schema.Struct({
  id: Schema.String,
  saml: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      entity_id: Schema.String,
      metadata_url: Schema.optionalKey(Schema.String),
      metadata_xml: Schema.optionalKey(Schema.String),
      attribute_mapping: Schema.optionalKey(
        Schema.Struct({
          keys: Schema.optionalKey(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                name: Schema.optionalKey(Schema.String),
                names: Schema.optionalKey(Schema.Array(Schema.String)),
                default: Schema.optionalKey(
                  Schema.Union(
                    [
                      Schema.Struct({}),
                      Schema.Number.check(Schema.isFinite()),
                      Schema.String,
                      Schema.Boolean,
                    ],
                    { mode: "oneOf" },
                  ),
                ),
                array: Schema.optionalKey(Schema.Boolean),
              }),
            ),
          ),
        }),
      ),
      name_id_format: Schema.optionalKey(
        Schema.Literals([
          "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
          "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        ]),
      ),
    }),
  ),
  domains: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        domain: Schema.optionalKey(Schema.String),
        created_at: Schema.optionalKey(Schema.String),
        updated_at: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  created_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String),
});
export const V1CreateAnOrganizationInput = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(256)),
});
export const V1CreateAnOrganizationOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Deprecated: Use `slug` instead." }),
  slug: Schema.String.annotate({ description: "Organization slug" }).check(
    Schema.isPattern(new RegExp("^[\\w-]+$")),
  ),
  name: Schema.String,
});
export const V1CreateLegacySigningKeyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1CreateLegacySigningKeyOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  algorithm: Schema.Literals(["EdDSA", "ES256", "RS256", "HS256"]),
  status: Schema.Literals(["in_use", "previously_used", "revoked", "standby"]),
  public_jwk: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
});
export const V1CreateLoginRoleInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  read_only: Schema.Boolean,
});
export const V1CreateLoginRoleOutput = Schema.Struct({
  role: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(1)),
  ttl_seconds: Schema.Number.annotate({ format: "int64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(1)),
});
export const V1CreateProjectApiKeyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  reveal: Schema.optionalKey(Schema.Boolean),
  type: Schema.Literals(["publishable", "secret"]),
  name: Schema.String.check(Schema.isMinLength(4))
    .check(Schema.isMaxLength(64))
    .check(Schema.isPattern(new RegExp("^[a-z_][a-z0-9_]+$"))),
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  secret_jwt_template: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.Null]),
  ),
});
export const V1CreateProjectApiKeyOutput = Schema.Struct({
  api_key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  type: Schema.optionalKey(
    Schema.Union([
      Schema.Literals(["legacy", "publishable", "secret"]),
      Schema.Union([Schema.Null]),
    ]),
  ),
  prefix: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  name: Schema.String,
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hash: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  secret_jwt_template: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.Null]),
  ),
  inserted_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
  updated_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
});
export const V1CreateProjectClaimTokenInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1CreateProjectClaimTokenOutput = Schema.Struct({
  token: Schema.String,
  token_alias: Schema.String,
  expires_at: Schema.String,
  created_at: Schema.String,
  created_by: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1CreateProjectSigningKeyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  algorithm: Schema.Literals(["EdDSA", "ES256", "RS256", "HS256"]),
  status: Schema.optionalKey(Schema.Literals(["in_use", "standby"])),
  private_jwk: Schema.optionalKey(
    Schema.Union(
      [
        Schema.Struct({
          kid: Schema.optionalKey(
            Schema.String.annotate({ format: "uuid" }).check(
              Schema.isPattern(
                new RegExp(
                  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
                ),
              ),
            ),
          ),
          use: Schema.optionalKey(Schema.Literal("sig")),
          key_ops: Schema.optionalKey(
            Schema.Array(Schema.Literals(["sign", "verify"]))
              .check(Schema.isMinLength(2))
              .check(Schema.isMaxLength(2)),
          ),
          ext: Schema.optionalKey(Schema.Literal(true)),
          kty: Schema.Literal("RSA"),
          alg: Schema.optionalKey(Schema.Literal("RS256")),
          n: Schema.String,
          e: Schema.Literal("AQAB"),
          d: Schema.String,
          p: Schema.String,
          q: Schema.String,
          dp: Schema.String,
          dq: Schema.String,
          qi: Schema.String,
        }),
        Schema.Struct({
          kid: Schema.optionalKey(
            Schema.String.annotate({ format: "uuid" }).check(
              Schema.isPattern(
                new RegExp(
                  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
                ),
              ),
            ),
          ),
          use: Schema.optionalKey(Schema.Literal("sig")),
          key_ops: Schema.optionalKey(
            Schema.Array(Schema.Literals(["sign", "verify"]))
              .check(Schema.isMinLength(2))
              .check(Schema.isMaxLength(2)),
          ),
          ext: Schema.optionalKey(Schema.Literal(true)),
          kty: Schema.Literal("EC"),
          alg: Schema.optionalKey(Schema.Literal("ES256")),
          crv: Schema.Literal("P-256"),
          x: Schema.String,
          y: Schema.String,
          d: Schema.String,
        }),
        Schema.Struct({
          kid: Schema.optionalKey(
            Schema.String.annotate({ format: "uuid" }).check(
              Schema.isPattern(
                new RegExp(
                  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
                ),
              ),
            ),
          ),
          use: Schema.optionalKey(Schema.Literal("sig")),
          key_ops: Schema.optionalKey(
            Schema.Array(Schema.Literals(["sign", "verify"]))
              .check(Schema.isMinLength(2))
              .check(Schema.isMaxLength(2)),
          ),
          ext: Schema.optionalKey(Schema.Literal(true)),
          kty: Schema.Literal("OKP"),
          alg: Schema.optionalKey(Schema.Literal("EdDSA")),
          crv: Schema.Literal("Ed25519"),
          x: Schema.String,
          d: Schema.String,
        }),
        Schema.Struct({
          kid: Schema.optionalKey(
            Schema.String.annotate({ format: "uuid" }).check(
              Schema.isPattern(
                new RegExp(
                  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
                ),
              ),
            ),
          ),
          use: Schema.optionalKey(Schema.Literal("sig")),
          key_ops: Schema.optionalKey(
            Schema.Array(Schema.Literals(["sign", "verify"]))
              .check(Schema.isMinLength(2))
              .check(Schema.isMaxLength(2)),
          ),
          ext: Schema.optionalKey(Schema.Literal(true)),
          kty: Schema.Literal("oct"),
          alg: Schema.optionalKey(Schema.Literal("HS256")),
          k: Schema.String.check(Schema.isMinLength(16)),
        }),
      ],
      { mode: "oneOf" },
    ),
  ),
});
export const V1CreateProjectSigningKeyOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  algorithm: Schema.Literals(["EdDSA", "ES256", "RS256", "HS256"]),
  status: Schema.Literals(["in_use", "previously_used", "revoked", "standby"]),
  public_jwk: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
});
export const V1CreateProjectTpaIntegrationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  oidc_issuer_url: Schema.optionalKey(Schema.String),
  jwks_url: Schema.optionalKey(Schema.String),
  custom_jwks: Schema.optionalKey(Schema.Json),
});
export const V1CreateProjectTpaIntegrationOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  type: Schema.String,
  oidc_issuer_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  jwks_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  custom_jwks: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  resolved_jwks: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  inserted_at: Schema.String,
  updated_at: Schema.String,
  resolved_at: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});
export const V1CreateRestorePointInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  name: Schema.String.check(Schema.isMaxLength(20)),
});
export const V1CreateRestorePointOutput = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["AVAILABLE", "PENDING", "REMOVED", "FAILED"]),
  completed_on: Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
});
export const V1DeactivateVanitySubdomainConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1DeleteHostnameConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  remove_addon: Schema.optionalKey(Schema.Boolean),
});
export const V1DeleteABranchInput = Schema.Struct({
  branch_id_or_ref: Schema.Union(
    [
      Schema.String.annotate({ description: "Project ref" })
        .check(Schema.isMinLength(20))
        .check(Schema.isMaxLength(20))
        .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ],
    { mode: "oneOf" },
  ),
  force: Schema.optionalKey(Schema.Boolean),
});
export const V1DeleteABranchOutput = Schema.Struct({ message: Schema.Literal("ok") });
export const V1DeleteAFunctionInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  function_slug: Schema.String.check(Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$"))),
});
export const V1DeleteAProjectInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1DeleteAProjectOutput = Schema.Struct({
  id: Schema.Number.check(Schema.isInt()),
  ref: Schema.String,
  name: Schema.String,
});
export const V1DeleteASsoProviderInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  provider_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1DeleteASsoProviderOutput = Schema.Struct({
  id: Schema.String,
  saml: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      entity_id: Schema.String,
      metadata_url: Schema.optionalKey(Schema.String),
      metadata_xml: Schema.optionalKey(Schema.String),
      attribute_mapping: Schema.optionalKey(
        Schema.Struct({
          keys: Schema.optionalKey(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                name: Schema.optionalKey(Schema.String),
                names: Schema.optionalKey(Schema.Array(Schema.String)),
                default: Schema.optionalKey(
                  Schema.Union(
                    [
                      Schema.Struct({}),
                      Schema.Number.check(Schema.isFinite()),
                      Schema.String,
                      Schema.Boolean,
                    ],
                    { mode: "oneOf" },
                  ),
                ),
                array: Schema.optionalKey(Schema.Boolean),
              }),
            ),
          ),
        }),
      ),
      name_id_format: Schema.optionalKey(
        Schema.Literals([
          "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
          "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        ]),
      ),
    }),
  ),
  domains: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        domain: Schema.optionalKey(Schema.String),
        created_at: Schema.optionalKey(Schema.String),
        updated_at: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  created_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String),
});
export const V1DeleteInviteExternalJitAccessInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  invite_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1DeleteJitAccessInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  user_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1DeleteLoginRolesInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1DeleteLoginRolesOutput = Schema.Struct({ message: Schema.Literal("ok") });
export const V1DeleteNetworkBansInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  ipv4_addresses: Schema.Array(Schema.String).annotate({
    description: "List of IP addresses to unban.",
  }),
  requester_ip: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Include requester's public IP in the list of addresses to unban.",
    }),
  ),
  identifier: Schema.optionalKey(Schema.String),
});
export const V1DeleteProjectApiKeyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  reveal: Schema.optionalKey(Schema.Boolean),
  was_compromised: Schema.optionalKey(Schema.Boolean),
  reason: Schema.optionalKey(Schema.String),
});
export const V1DeleteProjectApiKeyOutput = Schema.Struct({
  api_key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  type: Schema.optionalKey(
    Schema.Union([
      Schema.Literals(["legacy", "publishable", "secret"]),
      Schema.Union([Schema.Null]),
    ]),
  ),
  prefix: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  name: Schema.String,
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hash: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  secret_jwt_template: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.Null]),
  ),
  inserted_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
  updated_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
});
export const V1DeleteProjectClaimTokenInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1DeleteProjectTpaIntegrationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  tpa_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1DeleteProjectTpaIntegrationOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  type: Schema.String,
  oidc_issuer_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  jwks_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  custom_jwks: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  resolved_jwks: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  inserted_at: Schema.String,
  updated_at: Schema.String,
  resolved_at: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});
export const V1DeployAFunctionInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  slug: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(new RegExp("^[A-Za-z][A-Za-z0-9_-]*$"))),
  ),
  bundleOnly: Schema.optionalKey(Schema.Boolean),
  body: Schema.Struct({
    file: Schema.optionalKey(Schema.Array(BinaryInput)),
    metadata: Schema.Struct({
      entrypoint_path: Schema.String,
      import_map_path: Schema.optionalKey(Schema.String),
      static_patterns: Schema.optionalKey(Schema.Array(Schema.String)),
      verify_jwt: Schema.optionalKey(Schema.Boolean),
      name: Schema.optionalKey(Schema.String),
    }),
  }),
});
export const V1DeployAFunctionOutput = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["ACTIVE", "REMOVED", "THROTTLED"]),
  version: Schema.Number.check(Schema.isInt()),
  created_at: Schema.optionalKey(Schema.Number.annotate({ format: "int64" }).check(Schema.isInt())),
  updated_at: Schema.optionalKey(Schema.Number.annotate({ format: "int64" }).check(Schema.isInt())),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.Boolean),
  entrypoint_path: Schema.optionalKey(Schema.String),
  import_map_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  ezbr_sha256: Schema.optionalKey(Schema.String),
});
export const V1DiffABranchInput = Schema.Struct({
  branch_id_or_ref: Schema.Union(
    [
      Schema.String.annotate({ description: "Project ref" })
        .check(Schema.isMinLength(20))
        .check(Schema.isMaxLength(20))
        .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ],
    { mode: "oneOf" },
  ),
  included_schemas: Schema.optionalKey(Schema.String),
  pgdelta: Schema.optionalKey(Schema.Boolean),
});
export const V1DiffABranchOutput = Schema.String;
export const V1DisablePreviewBranchingInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1DisableReadonlyModeTemporarilyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1EnableDatabaseWebhookInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ExchangeOauthTokenInput = Schema.Struct({
  body: Schema.Struct({
    grant_type: Schema.optionalKey(
      Schema.Literals([
        "authorization_code",
        "refresh_token",
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      ]),
    ),
    client_id: Schema.optionalKey(
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ),
    client_secret: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.String),
    code_verifier: Schema.optionalKey(Schema.String),
    redirect_uri: Schema.optionalKey(Schema.String),
    refresh_token: Schema.optionalKey(Schema.String),
    assertion: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "IDJAG assertion JWT for grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer. Beta - available on Team and Enterprise plans only.",
      }),
    ),
    resource: Schema.optionalKey(
      Schema.String.annotate({
        description: "Resource indicator for MCP (Model Context Protocol) clients",
        format: "uri",
      }),
    ),
    scope: Schema.optionalKey(Schema.String),
  }),
});
export const V1ExchangeOauthTokenOutput = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The `urn:ietf:params:oauth:grant-type:jwt-bearer` grant type issues access tokens only, no refresh token is returned and the token cannot be revoked via `/v1/oauth/revoke`.",
    }),
  ),
  expires_in: Schema.Number.check(Schema.isInt()),
  token_type: Schema.Literal("Bearer"),
});
export const V1GenerateTypescriptTypesInput = Schema.Struct({
  included_schemas: Schema.optionalKey(Schema.String),
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GenerateTypescriptTypesOutput = Schema.Struct({ types: Schema.String });
export const V1GetABranchInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  name: Schema.String,
});
export const V1GetABranchOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  name: Schema.String,
  project_ref: Schema.String,
  parent_project_ref: Schema.String,
  is_default: Schema.Boolean,
  git_branch: Schema.optionalKey(Schema.String),
  pr_number: Schema.optionalKey(Schema.Number.annotate({ format: "int32" }).check(Schema.isInt())),
  latest_check_run_id: Schema.optionalKey(
    Schema.Number.annotate({
      description: "This field is deprecated and will not be populated.",
    }).check(Schema.isFinite()),
  ),
  persistent: Schema.Boolean,
  status: Schema.Literals([
    "CREATING_PROJECT",
    "RUNNING_MIGRATIONS",
    "MIGRATIONS_PASSED",
    "MIGRATIONS_FAILED",
    "FUNCTIONS_DEPLOYED",
    "FUNCTIONS_FAILED",
  ]).annotate({
    description: "This field is deprecated. List action runs to get branch status instead.",
  }),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
  review_requested_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  with_data: Schema.Boolean,
  notify_url: Schema.optionalKey(Schema.String.annotate({ format: "uri" })),
  deletion_scheduled_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  preview_project_status: Schema.optionalKey(
    Schema.Literals([
      "INACTIVE",
      "ACTIVE_HEALTHY",
      "ACTIVE_UNHEALTHY",
      "COMING_UP",
      "UNKNOWN",
      "GOING_DOWN",
      "INIT_FAILED",
      "REMOVED",
      "RESTORING",
      "UPGRADING",
      "PAUSING",
      "RESTORE_FAILED",
      "RESTARTING",
      "PAUSE_FAILED",
      "RESIZING",
    ]),
  ),
});
export const V1GetABranchConfigInput = Schema.Struct({
  branch_id_or_ref: Schema.Union(
    [
      Schema.String.annotate({ description: "Project ref" })
        .check(Schema.isMinLength(20))
        .check(Schema.isMaxLength(20))
        .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ],
    { mode: "oneOf" },
  ),
});
export const V1GetABranchConfigOutput = Schema.Struct({
  ref: Schema.String,
  postgres_version: Schema.String,
  postgres_engine: Schema.String,
  release_channel: Schema.String,
  status: Schema.Literals([
    "INACTIVE",
    "ACTIVE_HEALTHY",
    "ACTIVE_UNHEALTHY",
    "COMING_UP",
    "UNKNOWN",
    "GOING_DOWN",
    "INIT_FAILED",
    "REMOVED",
    "RESTORING",
    "UPGRADING",
    "PAUSING",
    "RESTORE_FAILED",
    "RESTARTING",
    "PAUSE_FAILED",
    "RESIZING",
  ]),
  db_host: Schema.String,
  db_port: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
  db_user: Schema.optionalKey(Schema.String),
  db_pass: Schema.optionalKey(Schema.String),
  jwt_secret: Schema.optionalKey(Schema.String),
});
export const V1GetAFunctionInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  function_slug: Schema.String.check(Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$"))),
});
export const V1GetAFunctionOutput = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["ACTIVE", "REMOVED", "THROTTLED"]),
  version: Schema.Number.check(Schema.isInt()),
  created_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  updated_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.Boolean),
  entrypoint_path: Schema.optionalKey(Schema.String),
  import_map_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  ezbr_sha256: Schema.optionalKey(Schema.String),
});
export const V1GetAFunctionBodyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  function_slug: Schema.String.check(Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$"))),
});
export const V1GetAFunctionBodyOutput = Schema.Struct({});
export const V1GetAMigrationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  version: Schema.String.check(Schema.isPattern(new RegExp("^\\d+$"))),
});
export const V1GetAMigrationOutput = Schema.Struct({
  version: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.optionalKey(Schema.String),
  statements: Schema.optionalKey(Schema.Array(Schema.String)),
  rollback: Schema.optionalKey(Schema.Array(Schema.String)),
  created_by: Schema.optionalKey(Schema.String),
  idempotency_key: Schema.optionalKey(Schema.String),
});
export const V1GetASnippetInput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1GetASnippetOutput = Schema.Struct({
  id: Schema.String,
  inserted_at: Schema.String,
  updated_at: Schema.String,
  type: Schema.Literal("sql"),
  visibility: Schema.Literals(["user", "project", "org", "public"]),
  name: Schema.String,
  description: Schema.Union([Schema.String, Schema.Null]),
  project: Schema.Struct({ id: Schema.Number.check(Schema.isFinite()), name: Schema.String }),
  owner: Schema.Struct({ id: Schema.Number.check(Schema.isFinite()), username: Schema.String }),
  updated_by: Schema.Struct({
    id: Schema.Number.check(Schema.isFinite()),
    username: Schema.String,
  }),
  favorite: Schema.Boolean,
  content: Schema.Struct({
    favorite: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Deprecated: Rely on root-level favorite property instead.",
      }),
    ),
    schema_version: Schema.String,
    sql: Schema.String,
  }),
});
export const V1GetASsoProviderInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  provider_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1GetASsoProviderOutput = Schema.Struct({
  id: Schema.String,
  saml: Schema.optionalKey(
    Schema.Struct({
      id: Schema.optionalKey(Schema.String),
      entity_id: Schema.String,
      metadata_url: Schema.optionalKey(Schema.String),
      metadata_xml: Schema.optionalKey(Schema.String),
      attribute_mapping: Schema.optionalKey(
        Schema.Struct({
          keys: Schema.optionalKey(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                name: Schema.optionalKey(Schema.String),
                names: Schema.optionalKey(Schema.Array(Schema.String)),
                default: Schema.optionalKey(
                  Schema.Union(
                    [
                      Schema.Struct({}),
                      Schema.Number.check(Schema.isFinite()),
                      Schema.String,
                      Schema.Boolean,
                    ],
                    { mode: "oneOf" },
                  ),
                ),
                array: Schema.optionalKey(Schema.Boolean),
              }),
            ),
          ),
        }),
      ),
      name_id_format: Schema.optionalKey(
        Schema.Literals([
          "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
          "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        ]),
      ),
    }),
  ),
  domains: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        domain: Schema.optionalKey(Schema.String),
        created_at: Schema.optionalKey(Schema.String),
        updated_at: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  created_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String),
});
export const V1GetActionRunInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  run_id: Schema.String,
});
export const V1GetActionRunOutput = Schema.Struct({
  id: Schema.String,
  branch_id: Schema.String,
  run_steps: Schema.Array(
    Schema.Struct({
      name: Schema.Literals(["clone", "pull", "health", "configure", "migrate", "seed", "deploy"]),
      status: Schema.Literals([
        "CREATED",
        "DEAD",
        "EXITED",
        "PAUSED",
        "REMOVING",
        "RESTARTING",
        "RUNNING",
      ]),
      created_at: Schema.String,
      updated_at: Schema.String,
    }),
  ),
  git_config: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  workdir: Schema.Union([Schema.String, Schema.Null]),
  check_run_id: Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null]),
  created_at: Schema.String,
  updated_at: Schema.String,
});
export const V1GetActionRunLogsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  run_id: Schema.String,
});
export const V1GetActionRunLogsOutput = Schema.String;
export const V1GetAllProjectsForOrganizationInput = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(new RegExp("^[\\w-]+$"))),
  offset: Schema.optionalKey(
    Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(100)),
  ),
  search: Schema.optionalKey(Schema.String),
  sort: Schema.optionalKey(
    Schema.Literals(["name_asc", "name_desc", "created_asc", "created_desc"]),
  ),
  statuses: Schema.optionalKey(Schema.String),
});
export const V1GetAllProjectsForOrganizationOutput = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      ref: Schema.String,
      name: Schema.String,
      cloud_provider: Schema.String,
      region: Schema.String,
      is_branch: Schema.Boolean,
      status: Schema.Literals([
        "INACTIVE",
        "ACTIVE_HEALTHY",
        "ACTIVE_UNHEALTHY",
        "COMING_UP",
        "UNKNOWN",
        "GOING_DOWN",
        "INIT_FAILED",
        "REMOVED",
        "RESTORING",
        "UPGRADING",
        "PAUSING",
        "RESTORE_FAILED",
        "RESTARTING",
        "PAUSE_FAILED",
        "RESIZING",
      ]),
      inserted_at: Schema.String,
      databases: Schema.Array(
        Schema.Struct({
          infra_compute_size: Schema.optionalKey(
            Schema.Literals([
              "pico",
              "nano",
              "micro",
              "small",
              "medium",
              "large",
              "xlarge",
              "2xlarge",
              "4xlarge",
              "8xlarge",
              "12xlarge",
              "16xlarge",
              "24xlarge",
              "24xlarge_optimized_memory",
              "24xlarge_optimized_cpu",
              "24xlarge_high_memory",
              "48xlarge",
              "48xlarge_optimized_memory",
              "48xlarge_optimized_cpu",
              "48xlarge_high_memory",
            ]),
          ),
          region: Schema.String,
          status: Schema.Literals([
            "ACTIVE_HEALTHY",
            "ACTIVE_UNHEALTHY",
            "COMING_UP",
            "GOING_DOWN",
            "INIT_FAILED",
            "REMOVED",
            "RESTORING",
            "UNKNOWN",
            "INIT_READ_REPLICA",
            "INIT_READ_REPLICA_FAILED",
            "RESTARTING",
            "RESIZING",
          ]),
          cloud_provider: Schema.String,
          identifier: Schema.String,
          type: Schema.Literals(["PRIMARY", "READ_REPLICA"]),
          disk_volume_size_gb: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
          disk_type: Schema.optionalKey(Schema.Literals(["gp3", "io2"])),
          disk_throughput_mbps: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
          disk_last_modified_at: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
  pagination: Schema.Struct({
    count: Schema.Number.annotate({
      description: "Total number of projects. Use this to calculate the total number of pages.",
    }).check(Schema.isFinite()),
    limit: Schema.Number.annotate({ description: "Maximum number of projects per page" }).check(
      Schema.isFinite(),
    ),
    offset: Schema.Number.annotate({
      description: "Number of projects skipped in this response",
    }).check(Schema.isFinite()),
  }),
});
export const V1GetAnOrganizationInput = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(new RegExp("^[\\w-]+$"))),
});
export const V1GetAnOrganizationOutput = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  plan: Schema.optionalKey(Schema.Literals(["free", "pro", "team", "enterprise", "platform"])),
  opt_in_tags: Schema.Array(
    Schema.Literals([
      "AI_SQL_GENERATOR_OPT_IN",
      "AI_DATA_GENERATOR_OPT_IN",
      "AI_LOG_GENERATOR_OPT_IN",
    ]),
  ),
  allowed_release_channels: Schema.Array(
    Schema.Literals(["internal", "alpha", "beta", "ga", "withdrawn", "preview"]),
  ),
});
export const V1GetAuthServiceConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetAuthServiceConfigOutput = Schema.Struct({
  api_max_request_duration: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  db_max_pool_size: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  db_max_pool_size_unit: Schema.Union([
    Schema.Literals(["connections", "percent"]),
    Schema.Union([Schema.Null]),
  ]),
  disable_signup: Schema.Union([Schema.Boolean, Schema.Null]),
  external_anonymous_users_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_apple_additional_client_ids: Schema.Union([Schema.String, Schema.Null]),
  external_apple_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_apple_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_apple_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_apple_secret: Schema.Union([Schema.String, Schema.Null]),
  external_azure_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_azure_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_azure_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_azure_secret: Schema.Union([Schema.String, Schema.Null]),
  external_azure_url: Schema.Union([Schema.String, Schema.Null]),
  external_bitbucket_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_bitbucket_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_bitbucket_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_bitbucket_secret: Schema.Union([Schema.String, Schema.Null]),
  external_discord_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_discord_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_discord_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_discord_secret: Schema.Union([Schema.String, Schema.Null]),
  external_email_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_facebook_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_facebook_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_facebook_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_facebook_secret: Schema.Union([Schema.String, Schema.Null]),
  external_figma_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_figma_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_figma_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_figma_secret: Schema.Union([Schema.String, Schema.Null]),
  external_github_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_github_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_github_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_github_secret: Schema.Union([Schema.String, Schema.Null]),
  external_gitlab_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_gitlab_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_gitlab_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_gitlab_secret: Schema.Union([Schema.String, Schema.Null]),
  external_gitlab_url: Schema.Union([Schema.String, Schema.Null]),
  external_google_additional_client_ids: Schema.Union([Schema.String, Schema.Null]),
  external_google_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_google_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_google_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_google_secret: Schema.Union([Schema.String, Schema.Null]),
  external_google_skip_nonce_check: Schema.Union([Schema.Boolean, Schema.Null]),
  external_kakao_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_kakao_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_kakao_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_kakao_secret: Schema.Union([Schema.String, Schema.Null]),
  external_keycloak_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_keycloak_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_keycloak_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_keycloak_secret: Schema.Union([Schema.String, Schema.Null]),
  external_keycloak_url: Schema.Union([Schema.String, Schema.Null]),
  external_linkedin_oidc_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_linkedin_oidc_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_linkedin_oidc_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_linkedin_oidc_secret: Schema.Union([Schema.String, Schema.Null]),
  external_slack_oidc_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_slack_oidc_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_oidc_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_oidc_secret: Schema.Union([Schema.String, Schema.Null]),
  external_notion_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_notion_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_notion_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_notion_secret: Schema.Union([Schema.String, Schema.Null]),
  external_phone_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_slack_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_secret: Schema.Union([Schema.String, Schema.Null]),
  external_spotify_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_spotify_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_spotify_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_spotify_secret: Schema.Union([Schema.String, Schema.Null]),
  external_twitch_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_twitch_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_twitch_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_twitch_secret: Schema.Union([Schema.String, Schema.Null]),
  external_twitter_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_twitter_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_twitter_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_twitter_secret: Schema.Union([Schema.String, Schema.Null]),
  external_x_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_x_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_x_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_x_secret: Schema.Union([Schema.String, Schema.Null]),
  external_workos_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_workos_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_workos_secret: Schema.Union([Schema.String, Schema.Null]),
  external_workos_url: Schema.Union([Schema.String, Schema.Null]),
  external_web3_solana_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_web3_ethereum_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_zoom_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_zoom_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_zoom_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_zoom_secret: Schema.Union([Schema.String, Schema.Null]),
  hook_custom_access_token_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_custom_access_token_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_custom_access_token_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_mfa_verification_attempt_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_mfa_verification_attempt_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_mfa_verification_attempt_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_password_verification_attempt_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_password_verification_attempt_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_password_verification_attempt_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_send_sms_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_send_sms_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_send_sms_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_send_email_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_send_email_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_send_email_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_before_user_created_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_before_user_created_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_before_user_created_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_after_user_created_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_after_user_created_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_after_user_created_secrets: Schema.Union([Schema.String, Schema.Null]),
  jwt_exp: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  mailer_allow_unverified_email_sign_ins: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_autoconfirm: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_otp_exp: Schema.Number.check(Schema.isInt()),
  mailer_otp_length: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  mailer_secure_email_change_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_subjects_confirmation: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_email_change: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_invite: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_magic_link: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_reauthentication: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_recovery: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_password_changed_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_email_changed_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_phone_changed_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_mfa_factor_enrolled_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_mfa_factor_unenrolled_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_identity_linked_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_identity_unlinked_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_confirmation_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_email_change_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_invite_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_magic_link_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_reauthentication_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_recovery_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_password_changed_notification_content: Schema.Union([
    Schema.String,
    Schema.Null,
  ]),
  mailer_templates_email_changed_notification_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_phone_changed_notification_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_mfa_factor_enrolled_notification_content: Schema.Union([
    Schema.String,
    Schema.Null,
  ]),
  mailer_templates_mfa_factor_unenrolled_notification_content: Schema.Union([
    Schema.String,
    Schema.Null,
  ]),
  mailer_templates_identity_linked_notification_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_identity_unlinked_notification_content: Schema.Union([
    Schema.String,
    Schema.Null,
  ]),
  mailer_notifications_password_changed_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_email_changed_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_phone_changed_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_mfa_factor_enrolled_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_mfa_factor_unenrolled_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_identity_linked_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_identity_unlinked_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_max_enrolled_factors: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  mfa_totp_enroll_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_totp_verify_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_phone_enroll_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_phone_verify_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_web_authn_enroll_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_web_authn_verify_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  passkey_enabled: Schema.Boolean,
  webauthn_rp_display_name: Schema.Union([Schema.String, Schema.Null]),
  webauthn_rp_id: Schema.Union([Schema.String, Schema.Null]),
  webauthn_rp_origins: Schema.Union([Schema.String, Schema.Null]),
  mfa_phone_otp_length: Schema.Number.check(Schema.isInt()),
  mfa_phone_template: Schema.Union([Schema.String, Schema.Null]),
  mfa_phone_max_frequency: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  nimbus_oauth_client_id: Schema.Union([Schema.String, Schema.Null]),
  nimbus_oauth_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  nimbus_oauth_client_secret: Schema.Union([Schema.String, Schema.Null]),
  password_hibp_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  password_min_length: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  password_required_characters: Schema.Union([
    Schema.Literals([
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
      "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
      "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
      "",
    ]),
    Schema.Union([Schema.Null]),
  ]),
  rate_limit_anonymous_users: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_email_sent: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_sms_sent: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_token_refresh: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_verify: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_otp: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_web3: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  refresh_token_rotation_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  saml_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  saml_external_url: Schema.Union([Schema.String, Schema.Null]),
  saml_allow_encrypted_assertions: Schema.Union([Schema.Boolean, Schema.Null]),
  security_sb_forwarded_for_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  security_captcha_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  security_captcha_provider: Schema.Union([
    Schema.Literals(["turnstile", "hcaptcha"]),
    Schema.Union([Schema.Null]),
  ]),
  security_captcha_secret: Schema.Union([Schema.String, Schema.Null]),
  security_manual_linking_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  security_refresh_token_reuse_interval: Schema.Union([
    Schema.Number.check(Schema.isInt()),
    Schema.Null,
  ]),
  security_update_password_require_reauthentication: Schema.Union([Schema.Boolean, Schema.Null]),
  sessions_inactivity_timeout: Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null]),
  sessions_single_per_user: Schema.Union([Schema.Boolean, Schema.Null]),
  sessions_tags: Schema.Union([Schema.String, Schema.Null]),
  sessions_timebox: Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null]),
  site_url: Schema.Union([Schema.String, Schema.Null]),
  sms_autoconfirm: Schema.Union([Schema.Boolean, Schema.Null]),
  sms_max_frequency: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  sms_messagebird_access_key: Schema.Union([Schema.String, Schema.Null]),
  sms_messagebird_originator: Schema.Union([Schema.String, Schema.Null]),
  sms_otp_exp: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  sms_otp_length: Schema.Number.check(Schema.isInt()),
  sms_provider: Schema.Union([
    Schema.Literals(["messagebird", "textlocal", "twilio", "twilio_verify", "vonage"]),
    Schema.Union([Schema.Null]),
  ]),
  sms_template: Schema.Union([Schema.String, Schema.Null]),
  sms_test_otp: Schema.Union([Schema.String, Schema.Null]),
  sms_test_otp_valid_until: Schema.Union([
    Schema.String.annotate({ format: "date-time" }),
    Schema.Null,
  ]),
  sms_textlocal_api_key: Schema.Union([Schema.String, Schema.Null]),
  sms_textlocal_sender: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_account_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_auth_token: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_content_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_message_service_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_verify_account_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_verify_auth_token: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_verify_message_service_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_vonage_api_key: Schema.Union([Schema.String, Schema.Null]),
  sms_vonage_api_secret: Schema.Union([Schema.String, Schema.Null]),
  sms_vonage_from: Schema.Union([Schema.String, Schema.Null]),
  smtp_admin_email: Schema.Union([Schema.String.annotate({ format: "email" }), Schema.Null]),
  smtp_host: Schema.Union([Schema.String, Schema.Null]),
  smtp_max_frequency: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  smtp_pass: Schema.Union([Schema.String, Schema.Null]),
  smtp_port: Schema.Union([Schema.String, Schema.Null]),
  smtp_sender_name: Schema.Union([Schema.String, Schema.Null]),
  smtp_user: Schema.Union([Schema.String, Schema.Null]),
  uri_allow_list: Schema.Union([Schema.String, Schema.Null]),
  oauth_server_enabled: Schema.Boolean,
  oauth_server_allow_dynamic_registration: Schema.Boolean,
  oauth_server_authorization_path: Schema.Union([Schema.String, Schema.Null]),
  custom_oauth_enabled: Schema.Boolean,
  custom_oauth_max_providers: Schema.Number.check(Schema.isInt()),
});
export const V1GetAvailableRegionsInput = Schema.Struct({
  organization_slug: Schema.String,
  continent: Schema.optionalKey(Schema.Literals(["NA", "SA", "EU", "AF", "AS", "OC", "AN"])),
  desired_instance_size: Schema.optionalKey(
    Schema.Literals([
      "nano",
      "micro",
      "small",
      "medium",
      "large",
      "xlarge",
      "2xlarge",
      "4xlarge",
      "8xlarge",
      "12xlarge",
      "16xlarge",
      "24xlarge",
      "24xlarge_optimized_memory",
      "24xlarge_optimized_cpu",
      "24xlarge_high_memory",
      "48xlarge",
      "48xlarge_optimized_memory",
      "48xlarge_optimized_cpu",
      "48xlarge_high_memory",
    ]),
  ),
});
export const V1GetAvailableRegionsOutput = Schema.Struct({
  recommendations: Schema.Struct({
    smartGroup: Schema.Struct({
      name: Schema.String,
      code: Schema.Literals(["americas", "emea", "apac"]),
      type: Schema.Literal("smartGroup"),
    }),
    specific: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        code: Schema.Literals([
          "us-east-1",
          "us-east-2",
          "us-west-1",
          "us-west-2",
          "ap-southeast-1",
          "ap-northeast-1",
          "ap-northeast-2",
          "ap-east-1",
          "ap-southeast-2",
          "eu-west-1",
          "eu-west-2",
          "eu-west-3",
          "eu-north-1",
          "eu-central-1",
          "eu-central-2",
          "ca-central-1",
          "ap-south-1",
          "sa-east-1",
        ]),
        type: Schema.Literal("specific"),
        provider: Schema.Literals(["AWS", "FLY", "AWS_K8S", "AWS_NIMBUS"]),
        status: Schema.optionalKey(Schema.Literals(["capacity", "other"])),
      }),
    ),
  }),
  all: Schema.Struct({
    smartGroup: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        code: Schema.Literals(["americas", "emea", "apac"]),
        type: Schema.Literal("smartGroup"),
      }),
    ),
    specific: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        code: Schema.Literals([
          "us-east-1",
          "us-east-2",
          "us-west-1",
          "us-west-2",
          "ap-southeast-1",
          "ap-northeast-1",
          "ap-northeast-2",
          "ap-east-1",
          "ap-southeast-2",
          "eu-west-1",
          "eu-west-2",
          "eu-west-3",
          "eu-north-1",
          "eu-central-1",
          "eu-central-2",
          "ca-central-1",
          "ap-south-1",
          "sa-east-1",
        ]),
        type: Schema.Literal("specific"),
        provider: Schema.Literals(["AWS", "FLY", "AWS_K8S", "AWS_NIMBUS"]),
        status: Schema.optionalKey(Schema.Literals(["capacity", "other"])),
      }),
    ),
  }),
});
export const V1GetBackupScheduleInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetBackupScheduleOutput = Schema.Struct({
  schedule_for: Schema.String.annotate({
    description: "Time of day to schedule daily backups, in UTC. Format: HH:MM:SS.",
  }),
  updated_at: Schema.String.annotate({
    description: "Timestamp of when the backup schedule was last updated.",
    format: "date-time",
  }),
});
export const V1GetDatabaseDiskInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetDatabaseDiskOutput = Schema.Struct({
  attributes: Schema.Union(
    [
      Schema.Struct({
        iops: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        size_gb: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        throughput_mibps: Schema.optionalKey(
          Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        ),
        type: Schema.Literal("gp3"),
      }),
      Schema.Struct({
        iops: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        size_gb: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        type: Schema.Literal("io2"),
      }),
    ],
    { mode: "oneOf" },
  ),
  last_modified_at: Schema.optionalKey(Schema.String),
});
export const V1GetDatabaseMetadataInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetDatabaseMetadataOutput = Schema.Struct({
  databases: Schema.Array(
    Schema.StructWithRest(
      Schema.Struct({
        name: Schema.String,
        schemas: Schema.Array(
          Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [
            Schema.Record(Schema.String, Schema.Json),
          ]),
        ),
      }),
      [Schema.Record(Schema.String, Schema.Json)],
    ),
  ),
});
export const V1GetDatabaseOpenapiInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  schema: Schema.optionalKey(Schema.String),
});
export const V1GetDatabaseOpenapiOutput = Schema.Struct({});
export const V1GetDiskUtilizationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetDiskUtilizationOutput = Schema.Struct({
  timestamp: Schema.String,
  metrics: Schema.Struct({
    fs_size_bytes: Schema.Number.check(Schema.isFinite()),
    fs_avail_bytes: Schema.Number.check(Schema.isFinite()),
    fs_used_bytes: Schema.Number.check(Schema.isFinite()),
  }),
});
export const V1GetHostnameConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetHostnameConfigOutput = Schema.Struct({
  status: Schema.optionalKey(
    Schema.Literals([
      "1_not_started",
      "2_initiated",
      "3_challenge_verified",
      "4_origin_setup_completed",
      "5_services_reconfigured",
    ]),
  ),
  custom_hostname: Schema.optionalKey(Schema.String),
  data: Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.Array(Schema.Json.annotate({ description: "Any JSON-serializable value" })),
    messages: Schema.Array(Schema.Json.annotate({ description: "Any JSON-serializable value" })),
    result: Schema.Struct({
      id: Schema.String,
      hostname: Schema.String,
      ssl: Schema.Struct({
        status: Schema.String,
        validation_records: Schema.optionalKey(
          Schema.Array(Schema.Struct({ txt_name: Schema.String, txt_value: Schema.String })),
        ),
        validation_errors: Schema.optionalKey(
          Schema.Array(Schema.Struct({ message: Schema.String })),
        ),
      }),
      ownership_verification: Schema.optionalKey(
        Schema.Struct({ type: Schema.String, name: Schema.String, value: Schema.String }),
      ),
      custom_origin_server: Schema.String,
      verification_errors: Schema.optionalKey(Schema.Array(Schema.String)),
      status: Schema.String,
    }),
  }),
});
export const V1GetJitAccessInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetJitAccessOutput = Schema.Struct({
  user_id: Schema.optionalKey(
    Schema.String.annotate({ format: "uuid" }).check(
      Schema.isPattern(
        new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
      ),
    ),
  ),
  user_roles: Schema.Array(
    Schema.Struct({
      role: Schema.String.check(Schema.isMinLength(1)),
      expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      allowed_networks: Schema.optionalKey(
        Schema.Struct({
          allowed_cidrs: Schema.optionalKey(Schema.Array(Schema.Struct({ cidr: Schema.String }))),
          allowed_cidrs_v6: Schema.optionalKey(
            Schema.Array(Schema.Struct({ cidr: Schema.String })),
          ),
        }),
      ),
      branches_only: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export const V1GetJitAccessConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetJitAccessConfigOutput = Schema.Union(
  [
    Schema.Struct({
      state: Schema.Literals(["enabled", "disabled"]),
      appliedSuccessfully: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      state: Schema.Literal("unavailable"),
      unavailableReason: Schema.Literals(["postgres_upgrade_required", "temporarily_unavailable"]),
    }),
  ],
  { mode: "oneOf" },
);
export const V1GetLegacySigningKeyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetLegacySigningKeyOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  algorithm: Schema.Literals(["EdDSA", "ES256", "RS256", "HS256"]),
  status: Schema.Literals(["in_use", "previously_used", "revoked", "standby"]),
  public_jwk: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
});
export const V1GetNetworkRestrictionsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetNetworkRestrictionsOutput = Schema.Struct({
  entitlement: Schema.Literals(["disallowed", "allowed"]),
  config: Schema.Struct({
    dbAllowedCidrs: Schema.optionalKey(Schema.Array(Schema.String)),
    dbAllowedCidrsV6: Schema.optionalKey(Schema.Array(Schema.String)),
  }).annotate({
    description:
      "At any given point in time, this is the config that the user has requested be applied to their project. The `status` field indicates if it has been applied to the project, or is pending. When an updated config is received, the applied config is moved to `old_config`.",
  }),
  old_config: Schema.optionalKey(
    Schema.Struct({
      dbAllowedCidrs: Schema.optionalKey(Schema.Array(Schema.String)),
      dbAllowedCidrsV6: Schema.optionalKey(Schema.Array(Schema.String)),
    }).annotate({
      description:
        "Populated when a new config has been received, but not registered as successfully applied to a project.",
    }),
  ),
  status: Schema.Literals(["stored", "applied"]),
  updated_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  applied_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
});
export const V1GetOrganizationEntitlementsInput = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(new RegExp("^[\\w-]+$"))),
});
export const V1GetOrganizationEntitlementsOutput = Schema.Struct({
  entitlements: Schema.Array(
    Schema.Struct({
      feature: Schema.Struct({
        key: Schema.Literals([
          "instances.compute_update_available_sizes",
          "instances.read_replicas",
          "instances.disk_modifications",
          "instances.high_availability",
          "instances.orioledb",
          "replication.etl",
          "storage.max_file_size",
          "storage.max_file_size.configurable",
          "storage.image_transformations",
          "storage.vector_buckets",
          "storage.iceberg_catalog",
          "security.audit_logs_days",
          "security.questionnaire",
          "security.soc2_report",
          "security.iso27001_certificate",
          "security.private_link",
          "security.enforce_mfa",
          "log.retention_days",
          "custom_domain",
          "vanity_subdomain",
          "ipv4",
          "pitr.available_variants",
          "log_drains",
          "audit_log_drains",
          "branching_limit",
          "branching_persistent",
          "auth.mfa_phone",
          "auth.mfa_web_authn",
          "auth.mfa_enhanced_security",
          "auth.hooks",
          "auth.platform.sso",
          "auth.custom_jwt_template",
          "auth.saml_2",
          "auth.user_sessions",
          "auth.leaked_password_protection",
          "auth.advanced_auth_settings",
          "auth.performance_settings",
          "auth.password_hibp",
          "auth.custom_oauth.max_providers",
          "backup.retention_days",
          "backup.restore_to_new_project",
          "backup.schedule",
          "function.max_count",
          "function.size_limit_mb",
          "realtime.max_concurrent_users",
          "realtime.max_events_per_second",
          "realtime.max_joins_per_second",
          "realtime.max_channels_per_client",
          "realtime.max_bytes_per_second",
          "realtime.max_presence_events_per_second",
          "realtime.max_payload_size_in_kb",
          "project_scoped_roles",
          "security.member_roles",
          "project_pausing",
          "project_cloning",
          "project_restore_after_expiry",
          "assistant.advance_model",
          "integrations.github_connections",
          "dedicated_pooler",
          "observability.dashboard_advanced_metrics",
        ]),
        type: Schema.Literals(["boolean", "numeric", "set"]),
      }),
      hasAccess: Schema.Boolean,
      type: Schema.Literals(["boolean", "numeric", "set"]),
      config: Schema.Union(
        [
          Schema.Struct({ enabled: Schema.Boolean }),
          Schema.Struct({
            enabled: Schema.Boolean,
            value: Schema.Number.check(Schema.isFinite()),
            unlimited: Schema.Boolean,
            unit: Schema.String,
          }),
          Schema.Struct({ enabled: Schema.Boolean, set: Schema.Array(Schema.String) }),
        ],
        { mode: "oneOf" },
      ),
    }),
  ),
});
export const V1GetOrganizationProjectClaimInput = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(new RegExp("^[\\w-]+$"))),
  token: Schema.String,
});
export const V1GetOrganizationProjectClaimOutput = Schema.Struct({
  project: Schema.Struct({ ref: Schema.String, name: Schema.String }),
  preview: Schema.Struct({
    valid: Schema.Boolean,
    warnings: Schema.Array(Schema.Struct({ key: Schema.String, message: Schema.String })),
    errors: Schema.Array(Schema.Struct({ key: Schema.String, message: Schema.String })),
    info: Schema.Array(Schema.Struct({ key: Schema.String, message: Schema.String })),
    members_exceeding_free_project_limit: Schema.Array(
      Schema.Struct({ name: Schema.String, limit: Schema.Number.check(Schema.isFinite()) }),
    ),
    source_subscription_plan: Schema.Literals(["free", "pro", "team", "enterprise", "platform"]),
    target_subscription_plan: Schema.Union([
      Schema.Literals(["free", "pro", "team", "enterprise", "platform"]),
      Schema.Union([Schema.Null]),
    ]),
  }),
  expires_at: Schema.String,
  created_at: Schema.String,
  created_by: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1GetPerformanceAdvisorsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetPerformanceAdvisorsOutput = Schema.Struct({
  lints: Schema.Array(
    Schema.Struct({
      name: Schema.Literals([
        "unindexed_foreign_keys",
        "auth_users_exposed",
        "auth_rls_initplan",
        "no_primary_key",
        "unused_index",
        "multiple_permissive_policies",
        "policy_exists_rls_disabled",
        "rls_enabled_no_policy",
        "duplicate_index",
        "security_definer_view",
        "function_search_path_mutable",
        "rls_disabled_in_public",
        "extension_in_public",
        "rls_references_user_metadata",
        "materialized_view_in_api",
        "foreign_table_in_api",
        "unsupported_reg_types",
        "auth_otp_long_expiry",
        "auth_otp_short_length",
        "ssl_not_enforced",
        "network_restrictions_not_set",
        "password_requirements_min_length",
        "pitr_not_enabled",
        "auth_leaked_password_protection",
        "auth_insufficient_mfa_options",
        "auth_password_policy_missing",
        "leaked_service_key",
        "no_backup_admin",
        "vulnerable_postgres_version",
      ]),
      title: Schema.String,
      level: Schema.Literals(["ERROR", "WARN", "INFO"]),
      facing: Schema.Literal("EXTERNAL"),
      categories: Schema.Array(Schema.Literals(["PERFORMANCE", "SECURITY"])),
      description: Schema.String,
      detail: Schema.String,
      remediation: Schema.String,
      metadata: Schema.optionalKey(
        Schema.Struct({
          schema: Schema.optionalKey(Schema.String),
          name: Schema.optionalKey(Schema.String),
          entity: Schema.optionalKey(Schema.String),
          type: Schema.optionalKey(
            Schema.Literals(["table", "view", "auth", "function", "extension", "compliance"]),
          ),
          fkey_name: Schema.optionalKey(Schema.String),
          fkey_columns: Schema.optionalKey(Schema.Array(Schema.Number.check(Schema.isFinite()))),
        }),
      ),
      cache_key: Schema.String,
    }),
  ),
});
export const V1GetPgsodiumConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetPgsodiumConfigOutput = Schema.Struct({ root_key: Schema.String });
export const V1GetPoolerConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetPoolerConfigOutput = Schema.Array(SupavisorConfigResponse);
export const V1GetPostgresConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetPostgresConfigOutput = Schema.Struct({
  effective_cache_size: Schema.optionalKey(Schema.String),
  logical_decoding_work_mem: Schema.optionalKey(Schema.String),
  "cron.log_statement": Schema.optionalKey(Schema.Boolean),
  log_autovacuum_min_duration: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  log_checkpoints: Schema.optionalKey(Schema.Boolean),
  log_connections: Schema.optionalKey(Schema.Boolean),
  log_disconnections: Schema.optionalKey(Schema.Boolean),
  log_duration: Schema.optionalKey(Schema.Boolean),
  log_lock_waits: Schema.optionalKey(Schema.Boolean),
  log_recovery_conflict_waits: Schema.optionalKey(Schema.Boolean),
  log_replication_commands: Schema.optionalKey(Schema.Boolean),
  log_startup_progress_interval: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  log_temp_files: Schema.optionalKey(Schema.String),
  maintenance_work_mem: Schema.optionalKey(Schema.String),
  track_activity_query_size: Schema.optionalKey(Schema.String),
  max_connections: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(262143)),
  ),
  max_locks_per_transaction: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(10))
      .check(Schema.isLessThanOrEqualTo(2147483640)),
  ),
  max_parallel_maintenance_workers: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_parallel_workers: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_parallel_workers_per_gather: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_replication_slots: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  max_slot_wal_keep_size: Schema.optionalKey(Schema.String),
  max_standby_archive_delay: Schema.optionalKey(Schema.String),
  max_standby_streaming_delay: Schema.optionalKey(Schema.String),
  max_wal_size: Schema.optionalKey(Schema.String),
  max_wal_senders: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  max_worker_processes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(262143)),
  ),
  session_replication_role: Schema.optionalKey(Schema.Literals(["origin", "replica", "local"])),
  shared_buffers: Schema.optionalKey(Schema.String),
  statement_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  track_commit_timestamp: Schema.optionalKey(Schema.Boolean),
  wal_keep_size: Schema.optionalKey(Schema.String),
  wal_sender_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  work_mem: Schema.optionalKey(Schema.String),
  checkpoint_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: s" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  hot_standby_feedback: Schema.optionalKey(Schema.Boolean),
});
export const V1GetPostgresUpgradeEligibilityInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetPostgresUpgradeEligibilityOutput = Schema.Struct({
  eligible: Schema.Boolean,
  current_app_version: Schema.String,
  current_app_version_release_channel: Schema.Literals([
    "internal",
    "alpha",
    "beta",
    "ga",
    "withdrawn",
    "preview",
  ]),
  latest_app_version: Schema.String,
  target_upgrade_versions: Schema.Array(
    Schema.Struct({
      postgres_version: Schema.Literals(["13", "14", "15", "17", "17-oriole"]),
      release_channel: Schema.Literals(["internal", "alpha", "beta", "ga", "withdrawn", "preview"]),
      app_version: Schema.String,
    }),
  ),
  duration_estimate_hours: Schema.Number.check(Schema.isFinite()),
  legacy_auth_custom_roles: Schema.Array(Schema.String),
  objects_to_be_dropped: Schema.Array(Schema.String).annotate({
    description: "Use validation_errors instead.",
  }),
  unsupported_extensions: Schema.Array(Schema.String).annotate({
    description: "Use validation_errors instead.",
  }),
  user_defined_objects_in_internal_schemas: Schema.Array(Schema.String).annotate({
    description: "Use validation_errors instead.",
  }),
  validation_errors: Schema.Array(
    Schema.Union(
      [
        Schema.Struct({
          type: Schema.Literal("objects_depending_on_pg_cron"),
          dependents: Schema.Array(Schema.String),
        }),
        Schema.Struct({
          type: Schema.Literal("indexes_referencing_ll_to_earth"),
          schema_name: Schema.String,
          table_name: Schema.String,
          index_name: Schema.String,
        }),
        Schema.Struct({
          type: Schema.Literal("function_using_obsolete_lang"),
          schema_name: Schema.String,
          function_name: Schema.String,
          lang_name: Schema.String,
        }),
        Schema.Struct({
          type: Schema.Literal("unsupported_extension"),
          extension_name: Schema.String,
        }),
        Schema.Struct({
          type: Schema.Literal("unsupported_fdw_handler"),
          fdw_name: Schema.String,
          fdw_handler_name: Schema.String,
        }),
        Schema.Struct({
          type: Schema.Literal("unlogged_table_with_persistent_sequence"),
          schema_name: Schema.String,
          table_name: Schema.String,
          sequence_name: Schema.String,
        }),
        Schema.Struct({
          type: Schema.Literal("user_defined_objects_in_internal_schemas"),
          obj_type: Schema.Literals(["table", "function"]),
          schema_name: Schema.String,
          obj_name: Schema.String,
        }),
        Schema.Struct({
          type: Schema.Literal("active_replication_slot"),
          slot_name: Schema.String,
        }),
        Schema.Struct({ type: Schema.Literal("x86_architecture") }),
        Schema.Struct({ type: Schema.Literal("project_hibernating") }),
      ],
      { mode: "oneOf" },
    ),
  ),
  warnings: Schema.Array(
    Schema.Union(
      [
        Schema.Struct({ type: Schema.Literal("pg_graphql_introspection_change") }),
        Schema.Struct({ type: Schema.Literal("ltree_reindex_required") }),
        Schema.Struct({ type: Schema.Literal("operator_estimator_gate") }),
      ],
      { mode: "oneOf" },
    ),
  ),
});
export const V1GetPostgresUpgradeStatusInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  tracking_id: Schema.optionalKey(Schema.String),
});
export const V1GetPostgresUpgradeStatusOutput = Schema.Struct({
  databaseUpgradeStatus: Schema.Union([
    Schema.Struct({
      initiated_at: Schema.String,
      latest_status_at: Schema.String,
      target_version: Schema.Number.check(Schema.isFinite()),
      error: Schema.optionalKey(
        Schema.Literals([
          "1_upgraded_instance_launch_failed",
          "2_volume_detachchment_from_upgraded_instance_failed",
          "3_volume_attachment_to_original_instance_failed",
          "4_data_upgrade_initiation_failed",
          "5_data_upgrade_completion_failed",
          "6_volume_detachchment_from_original_instance_failed",
          "7_volume_attachment_to_upgraded_instance_failed",
          "8_upgrade_completion_failed",
          "9_post_physical_backup_failed",
        ]),
      ),
      progress: Schema.optionalKey(
        Schema.Literals([
          "0_requested",
          "1_started",
          "2_launched_upgraded_instance",
          "3_detached_volume_from_upgraded_instance",
          "4_attached_volume_to_original_instance",
          "5_initiated_data_upgrade",
          "6_completed_data_upgrade",
          "7_detached_volume_from_original_instance",
          "8_attached_volume_to_upgraded_instance",
          "9_completed_upgrade",
          "10_completed_post_physical_backup",
        ]),
      ),
      status: Schema.Number.check(Schema.isFinite()),
    }),
    Schema.Null,
  ]),
});
export const V1GetPostgrestServiceConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetPostgrestServiceConfigOutput = Schema.Struct({
  db_schema: Schema.String,
  max_rows: Schema.Number.check(Schema.isInt()),
  db_extra_search_path: Schema.String,
  db_pool: Schema.Union([
    Schema.Number.annotate({
      description: "If `null`, the value is automatically configured based on compute size.",
    }).check(Schema.isInt()),
    Schema.Null,
  ]),
  jwt_secret: Schema.optionalKey(Schema.String),
});
export const V1GetProfileInput = Schema.Struct({});
export const V1GetProfileOutput = Schema.Struct({
  gotrue_id: Schema.String,
  primary_email: Schema.String,
  username: Schema.String,
});
export const V1GetProjectInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetProjectOutput = Schema.Struct({
  id: Schema.String.annotate({ description: "Deprecated: Use `ref` instead." }),
  ref: Schema.String.annotate({ description: "Project ref" })
    .check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  organization_id: Schema.String.annotate({
    description: "Deprecated: Use `organization_slug` instead.",
  }),
  organization_slug: Schema.String.annotate({ description: "Organization slug" }).check(
    Schema.isPattern(new RegExp("^[\\w-]+$")),
  ),
  name: Schema.String.annotate({ description: "Name of your project" }),
  region: Schema.String.annotate({ description: "Region of your project" }),
  created_at: Schema.String.annotate({ description: "Creation timestamp" }),
  status: Schema.Literals([
    "INACTIVE",
    "ACTIVE_HEALTHY",
    "ACTIVE_UNHEALTHY",
    "COMING_UP",
    "UNKNOWN",
    "GOING_DOWN",
    "INIT_FAILED",
    "REMOVED",
    "RESTORING",
    "UPGRADING",
    "PAUSING",
    "RESTORE_FAILED",
    "RESTARTING",
    "PAUSE_FAILED",
    "RESIZING",
  ]),
  database: Schema.Struct({
    host: Schema.String.annotate({ description: "Database host" }),
    version: Schema.String.annotate({ description: "Database version" }),
    postgres_engine: Schema.String.annotate({ description: "Database engine" }),
    release_channel: Schema.String.annotate({ description: "Release channel" }),
  }),
});
export const V1GetProjectApiKeyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  reveal: Schema.optionalKey(Schema.Boolean),
});
export const V1GetProjectApiKeyOutput = Schema.Struct({
  api_key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  type: Schema.optionalKey(
    Schema.Union([
      Schema.Literals(["legacy", "publishable", "secret"]),
      Schema.Union([Schema.Null]),
    ]),
  ),
  prefix: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  name: Schema.String,
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hash: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  secret_jwt_template: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.Null]),
  ),
  inserted_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
  updated_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
});
export const V1GetProjectApiKeysInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  reveal: Schema.optionalKey(Schema.Boolean),
});
export const V1GetProjectApiKeysOutput = Schema.Array(ApiKeyResponse);
export const V1GetProjectClaimTokenInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetProjectClaimTokenOutput = Schema.Struct({
  token_alias: Schema.String,
  expires_at: Schema.String,
  created_at: Schema.String,
  created_by: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1GetProjectDiskAutoscaleConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetProjectDiskAutoscaleConfigOutput = Schema.Struct({
  growth_percent: Schema.Union([
    Schema.Number.annotate({ description: "Growth percentage for disk autoscaling" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThan(0)),
    Schema.Null,
  ]),
  min_increment_gb: Schema.Union([
    Schema.Number.annotate({ description: "Minimum increment size for disk autoscaling in GB" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThan(0)),
    Schema.Null,
  ]),
  max_size_gb: Schema.Union([
    Schema.Number.annotate({ description: "Maximum limit the disk size will grow to in GB" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThan(0)),
    Schema.Null,
  ]),
});
export const V1GetProjectFunctionCombinedStatsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  interval: Schema.Literals(["15min", "1hr", "3hr", "1day"]),
  function_id: Schema.String,
});
export const V1GetProjectFunctionCombinedStatsOutput = Schema.Struct({
  result: Schema.optionalKey(Schema.Array(Schema.Json)),
  error: Schema.optionalKey(
    Schema.Union(
      [
        Schema.String,
        Schema.Struct({
          code: Schema.Number.check(Schema.isFinite()),
          errors: Schema.Array(
            Schema.Struct({
              domain: Schema.String,
              location: Schema.String,
              locationType: Schema.String,
              message: Schema.String,
              reason: Schema.String,
            }),
          ),
          message: Schema.String,
          status: Schema.String,
        }),
      ],
      { mode: "oneOf" },
    ),
  ),
});
export const V1GetProjectLegacyApiKeysInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetProjectLegacyApiKeysOutput = Schema.Struct({ enabled: Schema.Boolean });
export const V1GetProjectLogsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  sql: Schema.optionalKey(Schema.String),
  iso_timestamp_start: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  iso_timestamp_end: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
});
export const V1GetProjectLogsOutput = Schema.Struct({
  result: Schema.optionalKey(Schema.Array(Schema.Json)),
  error: Schema.optionalKey(
    Schema.Union(
      [
        Schema.String,
        Schema.Struct({
          code: Schema.Number.check(Schema.isFinite()),
          errors: Schema.Array(
            Schema.Struct({
              domain: Schema.String,
              location: Schema.String,
              locationType: Schema.String,
              message: Schema.String,
              reason: Schema.String,
            }),
          ),
          message: Schema.String,
          status: Schema.String,
        }),
      ],
      { mode: "oneOf" },
    ),
  ),
});
export const V1GetProjectLogsAllInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  sql: Schema.optionalKey(Schema.String),
  iso_timestamp_start: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  iso_timestamp_end: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
});
export const V1GetProjectLogsAllOutput = Schema.Struct({
  result: Schema.optionalKey(Schema.Array(Schema.Json)),
  error: Schema.optionalKey(
    Schema.Union(
      [
        Schema.String,
        Schema.Struct({
          code: Schema.Number.check(Schema.isFinite()),
          errors: Schema.Array(
            Schema.Struct({
              domain: Schema.String,
              location: Schema.String,
              locationType: Schema.String,
              message: Schema.String,
              reason: Schema.String,
            }),
          ),
          message: Schema.String,
          status: Schema.String,
        }),
      ],
      { mode: "oneOf" },
    ),
  ),
});
export const V1GetProjectPgbouncerConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetProjectPgbouncerConfigOutput = Schema.Struct({
  default_pool_size: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  ignore_startup_parameters: Schema.optionalKey(Schema.String),
  max_client_conn: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  pool_mode: Schema.optionalKey(Schema.Literals(["transaction", "session", "statement"])),
  connection_string: Schema.optionalKey(Schema.String),
  server_idle_timeout: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  server_lifetime: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  query_wait_timeout: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  reserve_pool_size: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
});
export const V1GetProjectSigningKeyInput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetProjectSigningKeyOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  algorithm: Schema.Literals(["EdDSA", "ES256", "RS256", "HS256"]),
  status: Schema.Literals(["in_use", "previously_used", "revoked", "standby"]),
  public_jwk: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
});
export const V1GetProjectSigningKeysInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetProjectSigningKeysOutput = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      id: Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
      algorithm: Schema.Literals(["EdDSA", "ES256", "RS256", "HS256"]),
      status: Schema.Literals(["in_use", "previously_used", "revoked", "standby"]),
      public_jwk: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
      created_at: Schema.String.annotate({ format: "date-time" }),
      updated_at: Schema.String.annotate({ format: "date-time" }),
    }),
  ),
});
export const V1GetProjectTpaIntegrationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  tpa_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
});
export const V1GetProjectTpaIntegrationOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  type: Schema.String,
  oidc_issuer_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  jwks_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  custom_jwks: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  resolved_jwks: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  inserted_at: Schema.String,
  updated_at: Schema.String,
  resolved_at: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});
export const V1GetProjectUsageApiCountInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  interval: Schema.optionalKey(
    Schema.Literals(["15min", "30min", "1hr", "3hr", "1day", "3day", "7day"]),
  ),
});
export const V1GetProjectUsageApiCountOutput = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        timestamp: Schema.String.annotate({ format: "date-time" }),
        total_auth_requests: Schema.Number.check(Schema.isFinite()),
        total_realtime_requests: Schema.Number.check(Schema.isFinite()),
        total_rest_requests: Schema.Number.check(Schema.isFinite()),
        total_storage_requests: Schema.Number.check(Schema.isFinite()),
      }),
    ),
  ),
  error: Schema.optionalKey(
    Schema.Union(
      [
        Schema.String,
        Schema.Struct({
          code: Schema.Number.check(Schema.isFinite()),
          errors: Schema.Array(
            Schema.Struct({
              domain: Schema.String,
              location: Schema.String,
              locationType: Schema.String,
              message: Schema.String,
              reason: Schema.String,
            }),
          ),
          message: Schema.String,
          status: Schema.String,
        }),
      ],
      { mode: "oneOf" },
    ),
  ),
});
export const V1GetProjectUsageRequestCountInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetProjectUsageRequestCountOutput = Schema.Struct({
  result: Schema.optionalKey(
    Schema.Array(Schema.Struct({ count: Schema.Number.check(Schema.isFinite()) })),
  ),
  error: Schema.optionalKey(
    Schema.Union(
      [
        Schema.String,
        Schema.Struct({
          code: Schema.Number.check(Schema.isFinite()),
          errors: Schema.Array(
            Schema.Struct({
              domain: Schema.String,
              location: Schema.String,
              locationType: Schema.String,
              message: Schema.String,
              reason: Schema.String,
            }),
          ),
          message: Schema.String,
          status: Schema.String,
        }),
      ],
      { mode: "oneOf" },
    ),
  ),
});
export const V1GetReadonlyModeStatusInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetReadonlyModeStatusOutput = Schema.Struct({
  enabled: Schema.Boolean,
  override_enabled: Schema.Boolean,
  override_active_until: Schema.String,
});
export const V1GetRealtimeConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetRealtimeConfigOutput = Schema.Struct({
  private_only: Schema.Union([
    Schema.Boolean.annotate({ description: "Whether to only allow private channels" }),
    Schema.Null,
  ]),
  connection_pool: Schema.Union([
    Schema.Number.annotate({ description: "Sets connection pool size for Realtime Authorization" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(100)),
    Schema.Null,
  ]),
  max_concurrent_users: Schema.Union([
    Schema.Number.annotate({ description: "Sets maximum number of concurrent users rate limit" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(50000)),
    Schema.Null,
  ]),
  max_events_per_second: Schema.Union([
    Schema.Number.annotate({
      description: "Sets maximum number of events per second rate per channel limit",
    })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(50000)),
    Schema.Null,
  ]),
  max_bytes_per_second: Schema.Union([
    Schema.Number.annotate({
      description: "Sets maximum number of bytes per second rate per channel limit",
    })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(10000000)),
    Schema.Null,
  ]),
  max_channels_per_client: Schema.Union([
    Schema.Number.annotate({ description: "Sets maximum number of channels per client rate limit" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(10000)),
    Schema.Null,
  ]),
  max_joins_per_second: Schema.Union([
    Schema.Number.annotate({ description: "Sets maximum number of joins per second rate limit" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(5000)),
    Schema.Null,
  ]),
  max_presence_events_per_second: Schema.Union([
    Schema.Number.annotate({
      description: "Sets maximum number of presence events per second rate limit",
    })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(5000)),
    Schema.Null,
  ]),
  max_payload_size_in_kb: Schema.Union([
    Schema.Number.annotate({ description: "Sets maximum number of payload size in KB rate limit" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(10000)),
    Schema.Null,
  ]),
  suspend: Schema.Union([
    Schema.Boolean.annotate({
      description:
        "Disables the Realtime service for this project when true. Set to false to re-enable it.",
    }),
    Schema.Null,
  ]),
  presence_enabled: Schema.Boolean.annotate({ description: "Whether to enable presence" }),
});
export const V1GetRestorePointInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(20))),
});
export const V1GetRestorePointOutput = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["AVAILABLE", "PENDING", "REMOVED", "FAILED"]),
  completed_on: Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
});
export const V1GetSecurityAdvisorsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  lint_type: Schema.optionalKey(Schema.Literal("sql")),
});
export const V1GetSecurityAdvisorsOutput = Schema.Struct({
  lints: Schema.Array(
    Schema.Struct({
      name: Schema.Literals([
        "unindexed_foreign_keys",
        "auth_users_exposed",
        "auth_rls_initplan",
        "no_primary_key",
        "unused_index",
        "multiple_permissive_policies",
        "policy_exists_rls_disabled",
        "rls_enabled_no_policy",
        "duplicate_index",
        "security_definer_view",
        "function_search_path_mutable",
        "rls_disabled_in_public",
        "extension_in_public",
        "rls_references_user_metadata",
        "materialized_view_in_api",
        "foreign_table_in_api",
        "unsupported_reg_types",
        "auth_otp_long_expiry",
        "auth_otp_short_length",
        "ssl_not_enforced",
        "network_restrictions_not_set",
        "password_requirements_min_length",
        "pitr_not_enabled",
        "auth_leaked_password_protection",
        "auth_insufficient_mfa_options",
        "auth_password_policy_missing",
        "leaked_service_key",
        "no_backup_admin",
        "vulnerable_postgres_version",
      ]),
      title: Schema.String,
      level: Schema.Literals(["ERROR", "WARN", "INFO"]),
      facing: Schema.Literal("EXTERNAL"),
      categories: Schema.Array(Schema.Literals(["PERFORMANCE", "SECURITY"])),
      description: Schema.String,
      detail: Schema.String,
      remediation: Schema.String,
      metadata: Schema.optionalKey(
        Schema.Struct({
          schema: Schema.optionalKey(Schema.String),
          name: Schema.optionalKey(Schema.String),
          entity: Schema.optionalKey(Schema.String),
          type: Schema.optionalKey(
            Schema.Literals(["table", "view", "auth", "function", "extension", "compliance"]),
          ),
          fkey_name: Schema.optionalKey(Schema.String),
          fkey_columns: Schema.optionalKey(Schema.Array(Schema.Number.check(Schema.isFinite()))),
        }),
      ),
      cache_key: Schema.String,
    }),
  ),
});
export const V1GetServicesHealthInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  services: Schema.Array(
    Schema.Literals([
      "auth",
      "db",
      "db_postgres_user",
      "pooler",
      "realtime",
      "rest",
      "storage",
      "pg_bouncer",
    ]),
  ),
  timeout_ms: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(10000)),
  ),
});
export const V1GetServicesHealthOutput = Schema.Array(V1ServiceHealthResponse);
export const V1GetSslEnforcementConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetSslEnforcementConfigOutput = Schema.Struct({
  currentConfig: Schema.Struct({ database: Schema.Boolean }),
  appliedSuccessfully: Schema.Boolean,
});
export const V1GetStorageConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetStorageConfigOutput = Schema.Struct({
  fileSizeLimit: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  features: Schema.Struct({
    imageTransformation: Schema.Struct({ enabled: Schema.Boolean }),
    s3Protocol: Schema.Struct({ enabled: Schema.Boolean }),
    icebergCatalog: Schema.Struct({
      enabled: Schema.Boolean,
      maxNamespaces: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
      maxTables: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
      maxCatalogs: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
    }),
    vectorBuckets: Schema.Struct({
      enabled: Schema.Boolean,
      maxBuckets: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
      maxIndexes: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  }),
  capabilities: Schema.Struct({ list_v2: Schema.Boolean, iceberg_catalog: Schema.Boolean }),
  external: Schema.Struct({ upstreamTarget: Schema.Literals(["main", "canary"]) }),
  migrationVersion: Schema.String,
  databasePoolMode: Schema.String,
});
export const V1GetVanitySubdomainConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1GetVanitySubdomainConfigOutput = Schema.Struct({
  status: Schema.Literals(["not-used", "custom-domain-used", "active"]),
  custom_domain: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
});
export const V1InviteExternalJitAccessInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  email: Schema.String.annotate({ format: "email" }).check(Schema.isMinLength(1)),
  roles: Schema.Array(
    Schema.Struct({
      role: Schema.String.check(Schema.isMinLength(1)),
      expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      allowed_networks: Schema.optionalKey(
        Schema.Struct({
          allowed_cidrs: Schema.optionalKey(Schema.Array(Schema.Struct({ cidr: Schema.String }))),
          allowed_cidrs_v6: Schema.optionalKey(
            Schema.Array(Schema.Struct({ cidr: Schema.String })),
          ),
        }),
      ),
      branches_only: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export const V1InviteExternalJitAccessOutput = Schema.Struct({
  email: Schema.String.annotate({ format: "email" }),
  invite_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  user_roles: Schema.Array(
    Schema.Struct({
      role: Schema.String.check(Schema.isMinLength(1)),
      expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      allowed_networks: Schema.optionalKey(
        Schema.Struct({
          allowed_cidrs: Schema.optionalKey(Schema.Array(Schema.Struct({ cidr: Schema.String }))),
          allowed_cidrs_v6: Schema.optionalKey(
            Schema.Array(Schema.Struct({ cidr: Schema.String })),
          ),
        }),
      ),
      branches_only: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export const V1ListActionRunsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  offset: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)),
  ),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(10)),
  ),
});
export const V1ListActionRunsOutput = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    branch_id: Schema.String,
    run_steps: Schema.Array(
      Schema.Struct({
        name: Schema.Literals([
          "clone",
          "pull",
          "health",
          "configure",
          "migrate",
          "seed",
          "deploy",
        ]),
        status: Schema.Literals([
          "CREATED",
          "DEAD",
          "EXITED",
          "PAUSED",
          "REMOVING",
          "RESTARTING",
          "RUNNING",
        ]),
        created_at: Schema.String,
        updated_at: Schema.String,
      }),
    ),
    git_config: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
    workdir: Schema.Union([Schema.String, Schema.Null]),
    check_run_id: Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null]),
    created_at: Schema.String,
    updated_at: Schema.String,
  }),
);
export const V1ListAllBackupsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAllBackupsOutput = Schema.Struct({
  region: Schema.String,
  walg_enabled: Schema.Boolean,
  pitr_enabled: Schema.Boolean,
  backups: Schema.Array(
    Schema.Struct({
      id: Schema.Number.check(Schema.isInt()),
      is_physical_backup: Schema.Boolean,
      status: Schema.Literals([
        "COMPLETED",
        "FAILED",
        "PENDING",
        "REMOVED",
        "ARCHIVED",
        "CANCELLED",
      ]),
      inserted_at: Schema.String,
    }),
  ),
  physical_backup_data: Schema.Struct({
    earliest_physical_backup_date_unix: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
    latest_physical_backup_date_unix: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  }),
});
export const V1ListAllBranchesInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAllBranchesOutput = Schema.Array(BranchResponse);
export const V1ListAllBucketsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAllBucketsOutput = Schema.Array(V1StorageBucketResponse);
export const V1ListAllFunctionsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAllFunctionsOutput = Schema.Array(FunctionResponse);
export const V1ListAllNetworkBansInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAllNetworkBansOutput = Schema.Struct({
  banned_ipv4_addresses: Schema.Array(Schema.String),
});
export const V1ListAllNetworkBansEnrichedInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAllNetworkBansEnrichedOutput = Schema.Struct({
  banned_ipv4_addresses: Schema.Array(
    Schema.Struct({
      banned_address: Schema.String,
      identifier: Schema.String,
      type: Schema.String,
    }),
  ),
});
export const V1ListAllOrganizationsInput = Schema.Struct({});
export const V1ListAllOrganizationsOutput = Schema.Array(OrganizationResponseV1);
export const V1ListAllProjectsInput = Schema.Struct({});
export const V1ListAllProjectsOutput = Schema.Array(V1ProjectWithDatabaseResponse);
export const V1ListAllSecretsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAllSecretsOutput = Schema.Array(SecretResponse);
export const V1ListAllSnippetsInput = Schema.Struct({
  project_ref: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(20))
      .check(Schema.isMaxLength(20))
      .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  ),
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.String),
  sort_by: Schema.optionalKey(Schema.Literals(["name", "inserted_at"])),
  sort_order: Schema.optionalKey(Schema.Literals(["asc", "desc"])),
});
export const V1ListAllSnippetsOutput = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      inserted_at: Schema.String,
      updated_at: Schema.String,
      type: Schema.Literal("sql"),
      visibility: Schema.Literals(["user", "project", "org", "public"]),
      name: Schema.String,
      description: Schema.Union([Schema.String, Schema.Null]),
      project: Schema.Struct({ id: Schema.Number.check(Schema.isFinite()), name: Schema.String }),
      owner: Schema.Struct({ id: Schema.Number.check(Schema.isFinite()), username: Schema.String }),
      updated_by: Schema.Struct({
        id: Schema.Number.check(Schema.isFinite()),
        username: Schema.String,
      }),
      favorite: Schema.Boolean,
    }),
  ),
  cursor: Schema.optionalKey(Schema.String),
});
export const V1ListAllSsoProviderInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAllSsoProviderOutput = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      saml: Schema.optionalKey(
        Schema.Struct({
          id: Schema.optionalKey(Schema.String),
          entity_id: Schema.String,
          metadata_url: Schema.optionalKey(Schema.String),
          metadata_xml: Schema.optionalKey(Schema.String),
          attribute_mapping: Schema.optionalKey(
            Schema.Struct({
              keys: Schema.optionalKey(
                Schema.Record(
                  Schema.String,
                  Schema.Struct({
                    name: Schema.optionalKey(Schema.String),
                    names: Schema.optionalKey(Schema.Array(Schema.String)),
                    default: Schema.optionalKey(
                      Schema.Union(
                        [
                          Schema.Struct({}),
                          Schema.Number.check(Schema.isFinite()),
                          Schema.String,
                          Schema.Boolean,
                        ],
                        { mode: "oneOf" },
                      ),
                    ),
                    array: Schema.optionalKey(Schema.Boolean),
                  }),
                ),
              ),
            }),
          ),
          name_id_format: Schema.optionalKey(
            Schema.Literals([
              "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
              "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
              "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
              "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
            ]),
          ),
        }),
      ),
      domains: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            domain: Schema.optionalKey(Schema.String),
            created_at: Schema.optionalKey(Schema.String),
            updated_at: Schema.optionalKey(Schema.String),
          }),
        ),
      ),
      created_at: Schema.optionalKey(Schema.String),
      updated_at: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const V1ListAvailableRestoreVersionsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListAvailableRestoreVersionsOutput = Schema.Struct({
  available_versions: Schema.Array(
    Schema.Struct({
      version: Schema.String,
      release_channel: Schema.Literals(["internal", "alpha", "beta", "ga", "withdrawn", "preview"]),
      postgres_engine: Schema.Literals(["13", "14", "15", "17", "17-oriole"]),
    }),
  ),
});
export const V1ListJitAccessInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListJitAccessOutput = Schema.Struct({
  items: Schema.Array(
    Schema.Union(
      [
        Schema.Struct({
          user_id: Schema.String.annotate({ format: "uuid" }).check(
            Schema.isPattern(
              new RegExp(
                "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
              ),
            ),
          ),
          primary_email: Schema.Union([Schema.String, Schema.Null]),
          invite_id: Schema.Null,
          expires_at: Schema.Null,
          user_roles: Schema.Array(
            Schema.Struct({
              role: Schema.String.check(Schema.isMinLength(1)),
              expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
              allowed_networks: Schema.optionalKey(
                Schema.Struct({
                  allowed_cidrs: Schema.optionalKey(
                    Schema.Array(Schema.Struct({ cidr: Schema.String })),
                  ),
                  allowed_cidrs_v6: Schema.optionalKey(
                    Schema.Array(Schema.Struct({ cidr: Schema.String })),
                  ),
                }),
              ),
              branches_only: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        }),
        Schema.Struct({
          user_id: Schema.Null,
          primary_email: Schema.String,
          invite_id: Schema.String.annotate({ format: "uuid" }).check(
            Schema.isPattern(
              new RegExp(
                "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
              ),
            ),
          ),
          expires_at: Schema.String,
          user_roles: Schema.Array(
            Schema.Struct({
              role: Schema.String.check(Schema.isMinLength(1)),
              expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
              allowed_networks: Schema.optionalKey(
                Schema.Struct({
                  allowed_cidrs: Schema.optionalKey(
                    Schema.Array(Schema.Struct({ cidr: Schema.String })),
                  ),
                  allowed_cidrs_v6: Schema.optionalKey(
                    Schema.Array(Schema.Struct({ cidr: Schema.String })),
                  ),
                }),
              ),
              branches_only: Schema.optionalKey(Schema.Boolean),
            }),
          ),
        }),
      ],
      { mode: "oneOf" },
    ),
  ),
});
export const V1ListMigrationHistoryInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListMigrationHistoryOutput = Schema.Array(
  Schema.Struct({
    version: Schema.String.check(Schema.isMinLength(1)),
    name: Schema.optionalKey(Schema.String),
  }),
);
export const V1ListOrganizationMembersInput = Schema.Struct({
  slug: Schema.String.check(Schema.isPattern(new RegExp("^[\\w-]+$"))),
});
export const V1ListOrganizationMembersOutput = Schema.Array(V1OrganizationMemberResponse);
export const V1ListProjectAddonsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListProjectAddonsOutput = Schema.Struct({
  selected_addons: Schema.Array(
    Schema.Struct({
      type: Schema.Literals([
        "custom_domain",
        "compute_instance",
        "pitr",
        "ipv4",
        "auth_mfa_phone",
        "auth_mfa_web_authn",
        "log_drain",
        "etl_pipeline",
      ]),
      variant: Schema.Struct({
        id: Schema.Union(
          [
            Schema.Literals([
              "ci_micro",
              "ci_small",
              "ci_medium",
              "ci_large",
              "ci_xlarge",
              "ci_2xlarge",
              "ci_4xlarge",
              "ci_8xlarge",
              "ci_12xlarge",
              "ci_16xlarge",
              "ci_24xlarge",
              "ci_24xlarge_optimized_cpu",
              "ci_24xlarge_optimized_memory",
              "ci_24xlarge_high_memory",
              "ci_48xlarge",
              "ci_48xlarge_optimized_cpu",
              "ci_48xlarge_optimized_memory",
              "ci_48xlarge_high_memory",
            ]),
            Schema.Literal("cd_default"),
            Schema.Literals(["pitr_7", "pitr_14", "pitr_28"]),
            Schema.Literal("ipv4_default"),
            Schema.Literal("auth_mfa_phone_default"),
            Schema.Literal("auth_mfa_web_authn_default"),
            Schema.Literal("log_drain_default"),
            Schema.Literal("etl_pipeline_default"),
          ],
          { mode: "oneOf" },
        ),
        name: Schema.String,
        price: Schema.Struct({
          description: Schema.String,
          type: Schema.Literals(["fixed", "usage"]),
          interval: Schema.Literals(["monthly", "hourly"]),
          amount: Schema.Number.check(Schema.isFinite()),
        }),
        meta: Schema.optionalKey(
          Schema.Json.annotate({ description: "Any JSON-serializable value" }),
        ),
      }),
    }),
  ),
  available_addons: Schema.Array(
    Schema.Struct({
      type: Schema.Literals([
        "custom_domain",
        "compute_instance",
        "pitr",
        "ipv4",
        "auth_mfa_phone",
        "auth_mfa_web_authn",
        "log_drain",
        "etl_pipeline",
      ]),
      name: Schema.String,
      variants: Schema.Array(
        Schema.Struct({
          id: Schema.Union(
            [
              Schema.Literals([
                "ci_micro",
                "ci_small",
                "ci_medium",
                "ci_large",
                "ci_xlarge",
                "ci_2xlarge",
                "ci_4xlarge",
                "ci_8xlarge",
                "ci_12xlarge",
                "ci_16xlarge",
                "ci_24xlarge",
                "ci_24xlarge_optimized_cpu",
                "ci_24xlarge_optimized_memory",
                "ci_24xlarge_high_memory",
                "ci_48xlarge",
                "ci_48xlarge_optimized_cpu",
                "ci_48xlarge_optimized_memory",
                "ci_48xlarge_high_memory",
              ]),
              Schema.Literal("cd_default"),
              Schema.Literals(["pitr_7", "pitr_14", "pitr_28"]),
              Schema.Literal("ipv4_default"),
              Schema.Literal("auth_mfa_phone_default"),
              Schema.Literal("auth_mfa_web_authn_default"),
              Schema.Literal("log_drain_default"),
              Schema.Literal("etl_pipeline_default"),
            ],
            { mode: "oneOf" },
          ),
          name: Schema.String,
          price: Schema.Struct({
            description: Schema.String,
            type: Schema.Literals(["fixed", "usage"]),
            interval: Schema.Literals(["monthly", "hourly"]),
            amount: Schema.Number.check(Schema.isFinite()),
          }),
          meta: Schema.optionalKey(
            Schema.Json.annotate({ description: "Any JSON-serializable value" }),
          ),
        }),
      ),
    }),
  ),
});
export const V1ListProjectTpaIntegrationsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1ListProjectTpaIntegrationsOutput = Schema.Array(ThirdPartyAuth);
export const V1MergeABranchInput = Schema.Struct({
  branch_id_or_ref: Schema.Union(
    [
      Schema.String.annotate({ description: "Project ref" })
        .check(Schema.isMinLength(20))
        .check(Schema.isMaxLength(20))
        .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ],
    { mode: "oneOf" },
  ),
  migration_version: Schema.optionalKey(Schema.String),
});
export const V1MergeABranchOutput = Schema.Struct({
  workflow_run_id: Schema.String,
  message: Schema.Literal("ok"),
});
export const V1ModifyDatabaseDiskInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  attributes: Schema.Union(
    [
      Schema.Struct({
        iops: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        size_gb: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        throughput_mibps: Schema.optionalKey(
          Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        ),
        type: Schema.Literal("gp3"),
      }),
      Schema.Struct({
        iops: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        size_gb: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0)),
        type: Schema.Literal("io2"),
      }),
    ],
    { mode: "oneOf" },
  ),
});
export const V1OauthAuthorizeProjectClaimInput = Schema.Struct({
  project_ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  client_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  response_type: Schema.Literals(["code", "token", "id_token token"]),
  redirect_uri: Schema.String,
  state: Schema.optionalKey(Schema.String),
  response_mode: Schema.optionalKey(Schema.String),
  code_challenge: Schema.optionalKey(Schema.String),
  code_challenge_method: Schema.optionalKey(Schema.Literals(["plain", "sha256", "S256"])),
});
export const V1PatchAMigrationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  version: Schema.String.check(Schema.isPattern(new RegExp("^\\d+$"))),
  name: Schema.optionalKey(Schema.String),
  rollback: Schema.optionalKey(Schema.String),
});
export const V1PatchNetworkRestrictionsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  add: Schema.optionalKey(
    Schema.Struct({
      dbAllowedCidrs: Schema.optionalKey(Schema.Array(Schema.String)),
      dbAllowedCidrsV6: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  remove: Schema.optionalKey(
    Schema.Struct({
      dbAllowedCidrs: Schema.optionalKey(Schema.Array(Schema.String)),
      dbAllowedCidrsV6: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
export const V1PatchNetworkRestrictionsOutput = Schema.Struct({
  entitlement: Schema.Literals(["disallowed", "allowed"]),
  config: Schema.Struct({
    dbAllowedCidrs: Schema.optionalKey(
      Schema.Array(Schema.Struct({ address: Schema.String, type: Schema.Literals(["v4", "v6"]) })),
    ),
  }).annotate({
    description:
      "At any given point in time, this is the config that the user has requested be applied to their project. The `status` field indicates if it has been applied to the project, or is pending. When an updated config is received, the applied config is moved to `old_config`.",
  }),
  old_config: Schema.optionalKey(
    Schema.Struct({
      dbAllowedCidrs: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({ address: Schema.String, type: Schema.Literals(["v4", "v6"]) }),
        ),
      ),
    }).annotate({
      description:
        "Populated when a new config has been received, but not registered as successfully applied to a project.",
    }),
  ),
  updated_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  applied_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  status: Schema.Literals(["stored", "applied"]),
});
export const V1PauseAProjectInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1PushABranchInput = Schema.Struct({
  branch_id_or_ref: Schema.Union(
    [
      Schema.String.annotate({ description: "Project ref" })
        .check(Schema.isMinLength(20))
        .check(Schema.isMaxLength(20))
        .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ],
    { mode: "oneOf" },
  ),
  migration_version: Schema.optionalKey(Schema.String),
});
export const V1PushABranchOutput = Schema.Struct({
  workflow_run_id: Schema.String,
  message: Schema.Literal("ok"),
});
export const V1ReadOnlyQueryInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  query: Schema.String.check(Schema.isMinLength(1)),
  parameters: Schema.optionalKey(Schema.Array(Schema.Json)),
});
export const V1RemoveAReadReplicaInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  database_identifier: Schema.String,
});
export const V1RemoveProjectAddonInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  addon_variant: Schema.Union(
    [
      Schema.Literals([
        "ci_micro",
        "ci_small",
        "ci_medium",
        "ci_large",
        "ci_xlarge",
        "ci_2xlarge",
        "ci_4xlarge",
        "ci_8xlarge",
        "ci_12xlarge",
        "ci_16xlarge",
        "ci_24xlarge",
        "ci_24xlarge_optimized_cpu",
        "ci_24xlarge_optimized_memory",
        "ci_24xlarge_high_memory",
        "ci_48xlarge",
        "ci_48xlarge_optimized_cpu",
        "ci_48xlarge_optimized_memory",
        "ci_48xlarge_high_memory",
      ]),
      Schema.Literal("cd_default"),
      Schema.Literals(["pitr_7", "pitr_14", "pitr_28"]),
      Schema.Literal("ipv4_default"),
    ],
    { mode: "oneOf" },
  ),
});
export const V1RemoveProjectSigningKeyInput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1RemoveProjectSigningKeyOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  algorithm: Schema.Literals(["EdDSA", "ES256", "RS256", "HS256"]),
  status: Schema.Literals(["in_use", "previously_used", "revoked", "standby"]),
  public_jwk: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
});
export const V1ResetABranchInput = Schema.Struct({
  branch_id_or_ref: Schema.Union(
    [
      Schema.String.annotate({ description: "Project ref" })
        .check(Schema.isMinLength(20))
        .check(Schema.isMaxLength(20))
        .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ],
    { mode: "oneOf" },
  ),
  migration_version: Schema.optionalKey(Schema.String),
});
export const V1ResetABranchOutput = Schema.Struct({
  workflow_run_id: Schema.String,
  message: Schema.Literal("ok"),
});
export const V1RestartAProjectInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1RestoreABranchInput = Schema.Struct({
  branch_id_or_ref: Schema.Union(
    [
      Schema.String.annotate({ description: "Project ref" })
        .check(Schema.isMinLength(20))
        .check(Schema.isMaxLength(20))
        .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ],
    { mode: "oneOf" },
  ),
});
export const V1RestoreABranchOutput = Schema.Struct({
  message: Schema.Literal("Branch restoration initiated"),
});
export const V1RestoreAProjectInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1RestorePhysicalBackupInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  id: Schema.Number.check(Schema.isInt()),
});
export const V1RestorePitrBackupInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  recovery_time_target_unix: Schema.Number.annotate({ format: "int64" })
    .check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0)),
});
export const V1RevokeTokenInput = Schema.Struct({
  client_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  client_secret: Schema.String,
  refresh_token: Schema.String,
});
export const V1RollbackMigrationsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  gte: Schema.String.check(Schema.isPattern(new RegExp("^\\d+$"))),
});
export const V1RunAQueryInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  query: Schema.String.check(Schema.isMinLength(1)),
  parameters: Schema.optionalKey(Schema.Array(Schema.Json)),
  read_only: Schema.optionalKey(Schema.Boolean),
});
export const V1SetupAReadReplicaInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  read_replica_region: Schema.Literals([
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "ap-east-1",
    "ap-southeast-1",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-southeast-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-north-1",
    "eu-central-1",
    "eu-central-2",
    "ca-central-1",
    "ap-south-1",
    "sa-east-1",
  ]).annotate({ description: "Region you want your read replica to reside in" }),
});
export const V1ShutdownRealtimeInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1UndoInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  name: Schema.String.check(Schema.isMaxLength(20)),
});
export const V1UpdateABranchConfigInput = Schema.Struct({
  branch_id_or_ref: Schema.Union(
    [
      Schema.String.annotate({ description: "Project ref" })
        .check(Schema.isMinLength(20))
        .check(Schema.isMaxLength(20))
        .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
      Schema.String.annotate({ format: "uuid" }).check(
        Schema.isPattern(
          new RegExp(
            "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
          ),
        ),
      ),
    ],
    { mode: "oneOf" },
  ),
  branch_name: Schema.optionalKey(Schema.String),
  git_branch: Schema.optionalKey(Schema.String),
  reset_on_push: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "This field is deprecated and will be ignored. Use v1-reset-a-branch endpoint directly instead.",
    }),
  ),
  persistent: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(
    Schema.Literals([
      "CREATING_PROJECT",
      "RUNNING_MIGRATIONS",
      "MIGRATIONS_PASSED",
      "MIGRATIONS_FAILED",
      "FUNCTIONS_DEPLOYED",
      "FUNCTIONS_FAILED",
    ]),
  ),
  request_review: Schema.optionalKey(Schema.Boolean),
  notify_url: Schema.optionalKey(
    Schema.String.annotate({
      description: "HTTP endpoint to receive branch status updates.",
      format: "uri",
    }),
  ),
});
export const V1UpdateABranchConfigOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  name: Schema.String,
  project_ref: Schema.String,
  parent_project_ref: Schema.String,
  is_default: Schema.Boolean,
  git_branch: Schema.optionalKey(Schema.String),
  pr_number: Schema.optionalKey(Schema.Number.annotate({ format: "int32" }).check(Schema.isInt())),
  latest_check_run_id: Schema.optionalKey(
    Schema.Number.annotate({
      description: "This field is deprecated and will not be populated.",
    }).check(Schema.isFinite()),
  ),
  persistent: Schema.Boolean,
  status: Schema.Literals([
    "CREATING_PROJECT",
    "RUNNING_MIGRATIONS",
    "MIGRATIONS_PASSED",
    "MIGRATIONS_FAILED",
    "FUNCTIONS_DEPLOYED",
    "FUNCTIONS_FAILED",
  ]).annotate({
    description: "This field is deprecated. List action runs to get branch status instead.",
  }),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
  review_requested_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  with_data: Schema.Boolean,
  notify_url: Schema.optionalKey(Schema.String.annotate({ format: "uri" })),
  deletion_scheduled_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  preview_project_status: Schema.optionalKey(
    Schema.Literals([
      "INACTIVE",
      "ACTIVE_HEALTHY",
      "ACTIVE_UNHEALTHY",
      "COMING_UP",
      "UNKNOWN",
      "GOING_DOWN",
      "INIT_FAILED",
      "REMOVED",
      "RESTORING",
      "UPGRADING",
      "PAUSING",
      "RESTORE_FAILED",
      "RESTARTING",
      "PAUSE_FAILED",
      "RESIZING",
    ]),
  ),
});
export const V1UpdateAFunctionInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  function_slug: Schema.String.check(Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$"))),
  slug: Schema.optionalKey(Schema.String.check(Schema.isPattern(new RegExp("^[A-Za-z0-9_-]+$")))),
  name: Schema.optionalKey(Schema.String),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.Boolean),
  entrypoint_path: Schema.optionalKey(Schema.String),
  import_map_path: Schema.optionalKey(Schema.String),
  ezbr_sha256: Schema.optionalKey(Schema.String),
  body: BinaryInput,
});
export const V1UpdateAFunctionOutput = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  status: Schema.Literals(["ACTIVE", "REMOVED", "THROTTLED"]),
  version: Schema.Number.check(Schema.isInt()),
  created_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  updated_at: Schema.Number.annotate({ format: "int64" }).check(Schema.isInt()),
  verify_jwt: Schema.optionalKey(Schema.Boolean),
  import_map: Schema.optionalKey(Schema.Boolean),
  entrypoint_path: Schema.optionalKey(Schema.String),
  import_map_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  ezbr_sha256: Schema.optionalKey(Schema.String),
});
export const V1UpdateAProjectInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  name: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(256)),
});
export const V1UpdateAProjectOutput = Schema.Struct({
  id: Schema.Number.check(Schema.isInt()),
  ref: Schema.String,
  name: Schema.String,
});
export const V1UpdateASsoProviderInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  provider_id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  metadata_xml: Schema.optionalKey(Schema.String),
  metadata_url: Schema.optionalKey(Schema.String),
  domains: Schema.optionalKey(Schema.Array(Schema.String)),
  attribute_mapping: Schema.optionalKey(
    Schema.Struct({
      keys: Schema.Record(
        Schema.String,
        Schema.Struct({
          name: Schema.optionalKey(Schema.String),
          names: Schema.optionalKey(Schema.Array(Schema.String)),
          default: Schema.optionalKey(
            Schema.Union(
              [
                Schema.Struct({}),
                Schema.Number.check(Schema.isFinite()),
                Schema.String,
                Schema.Boolean,
              ],
              { mode: "oneOf" },
            ),
          ),
          array: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  ),
  name_id_format: Schema.optionalKey(
    Schema.Literals([
      "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
      "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
      "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    ]),
  ),
});
export const V1UpdateASsoProviderOutput = Schema.Struct({
  id: Schema.String,
  saml: Schema.optionalKey(
    Schema.Struct({
      id: Schema.String,
      entity_id: Schema.String,
      metadata_url: Schema.optionalKey(Schema.String),
      metadata_xml: Schema.optionalKey(Schema.String),
      attribute_mapping: Schema.optionalKey(
        Schema.Struct({
          keys: Schema.optionalKey(
            Schema.Record(
              Schema.String,
              Schema.Struct({
                name: Schema.optionalKey(Schema.String),
                names: Schema.optionalKey(Schema.Array(Schema.String)),
                default: Schema.optionalKey(
                  Schema.Union(
                    [
                      Schema.Struct({}),
                      Schema.Number.check(Schema.isFinite()),
                      Schema.String,
                      Schema.Boolean,
                    ],
                    { mode: "oneOf" },
                  ),
                ),
                array: Schema.optionalKey(Schema.Boolean),
              }),
            ),
          ),
        }),
      ),
      name_id_format: Schema.optionalKey(
        Schema.Literals([
          "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:transient",
          "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
          "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
        ]),
      ),
    }),
  ),
  domains: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        domain: Schema.optionalKey(Schema.String),
        created_at: Schema.optionalKey(Schema.String),
        updated_at: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  created_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String),
});
export const V1UpdateActionRunStatusInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  run_id: Schema.String,
  clone: Schema.optionalKey(
    Schema.Literals(["CREATED", "DEAD", "EXITED", "PAUSED", "REMOVING", "RESTARTING", "RUNNING"]),
  ),
  pull: Schema.optionalKey(
    Schema.Literals(["CREATED", "DEAD", "EXITED", "PAUSED", "REMOVING", "RESTARTING", "RUNNING"]),
  ),
  health: Schema.optionalKey(
    Schema.Literals(["CREATED", "DEAD", "EXITED", "PAUSED", "REMOVING", "RESTARTING", "RUNNING"]),
  ),
  configure: Schema.optionalKey(
    Schema.Literals(["CREATED", "DEAD", "EXITED", "PAUSED", "REMOVING", "RESTARTING", "RUNNING"]),
  ),
  migrate: Schema.optionalKey(
    Schema.Literals(["CREATED", "DEAD", "EXITED", "PAUSED", "REMOVING", "RESTARTING", "RUNNING"]),
  ),
  seed: Schema.optionalKey(
    Schema.Literals(["CREATED", "DEAD", "EXITED", "PAUSED", "REMOVING", "RESTARTING", "RUNNING"]),
  ),
  deploy: Schema.optionalKey(
    Schema.Literals(["CREATED", "DEAD", "EXITED", "PAUSED", "REMOVING", "RESTARTING", "RUNNING"]),
  ),
});
export const V1UpdateActionRunStatusOutput = Schema.Struct({ message: Schema.Literal("ok") });
export const V1UpdateAuthServiceConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  site_url: Schema.optionalKey(
    Schema.Union([Schema.String.check(Schema.isPattern(new RegExp("^[^,]+$"))), Schema.Null]),
  ),
  disable_signup: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  jwt_exp: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(604800)),
      Schema.Null,
    ]),
  ),
  smtp_admin_email: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "email" }), Schema.Null]),
  ),
  smtp_host: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  smtp_port: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  smtp_user: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  smtp_pass: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  smtp_max_frequency: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(32767)),
      Schema.Null,
    ]),
  ),
  smtp_sender_name: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_allow_unverified_email_sign_ins: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  mailer_autoconfirm: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  mailer_subjects_invite: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_subjects_confirmation: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_subjects_recovery: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_subjects_email_change: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_subjects_magic_link: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_subjects_reauthentication: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_subjects_password_changed_notification: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_subjects_email_changed_notification: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_subjects_phone_changed_notification: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_subjects_mfa_factor_enrolled_notification: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_subjects_mfa_factor_unenrolled_notification: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_subjects_identity_linked_notification: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_subjects_identity_unlinked_notification: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_invite_content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_templates_confirmation_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_recovery_content: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mailer_templates_email_change_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_magic_link_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_reauthentication_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_password_changed_notification_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_email_changed_notification_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_phone_changed_notification_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_mfa_factor_enrolled_notification_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_mfa_factor_unenrolled_notification_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_identity_linked_notification_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_templates_identity_unlinked_notification_content: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  mailer_notifications_password_changed_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  mailer_notifications_email_changed_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  mailer_notifications_phone_changed_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  mailer_notifications_mfa_factor_enrolled_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  mailer_notifications_mfa_factor_unenrolled_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  mailer_notifications_identity_linked_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  mailer_notifications_identity_unlinked_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  mfa_max_enrolled_factors: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  uri_allow_list: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_anonymous_users_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_email_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_phone_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  saml_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  saml_external_url: Schema.optionalKey(
    Schema.Union([Schema.String.check(Schema.isPattern(new RegExp("^[^,]+$"))), Schema.Null]),
  ),
  security_sb_forwarded_for_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  security_captcha_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  security_captcha_provider: Schema.optionalKey(
    Schema.Union([Schema.Literals(["turnstile", "hcaptcha"]), Schema.Union([Schema.Null])]),
  ),
  security_captcha_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sessions_timebox: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  sessions_inactivity_timeout: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isFinite()).check(Schema.isGreaterThanOrEqualTo(0)),
      Schema.Null,
    ]),
  ),
  sessions_single_per_user: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  sessions_tags: Schema.optionalKey(
    Schema.Union([
      Schema.String.check(Schema.isPattern(new RegExp("^\\s*([a-zA-Z0-9_-]+(\\s*,+\\s*)?)*\\s*$"))),
      Schema.Null,
    ]),
  ),
  rate_limit_anonymous_users: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  rate_limit_email_sent: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  rate_limit_sms_sent: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  rate_limit_verify: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  rate_limit_token_refresh: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  rate_limit_otp: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  rate_limit_web3: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(1))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  mailer_secure_email_change_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  refresh_token_rotation_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  password_hibp_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  password_min_length: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(6))
        .check(Schema.isLessThanOrEqualTo(32767)),
      Schema.Null,
    ]),
  ),
  password_required_characters: Schema.optionalKey(
    Schema.Union([
      Schema.Literals([
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
        "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
        "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
        "",
      ]),
      Schema.Union([Schema.Null]),
    ]),
  ),
  security_manual_linking_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  security_update_password_require_reauthentication: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  security_refresh_token_reuse_interval: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  mailer_otp_exp: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(2147483647)),
  ),
  mailer_otp_length: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(6))
        .check(Schema.isLessThanOrEqualTo(10)),
      Schema.Null,
    ]),
  ),
  sms_autoconfirm: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  sms_max_frequency: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(32767)),
      Schema.Null,
    ]),
  ),
  sms_otp_exp: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(2147483647)),
      Schema.Null,
    ]),
  ),
  sms_otp_length: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(32767)),
  ),
  sms_provider: Schema.optionalKey(
    Schema.Union([
      Schema.Literals(["messagebird", "textlocal", "twilio", "twilio_verify", "vonage"]),
      Schema.Union([Schema.Null]),
    ]),
  ),
  sms_messagebird_access_key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_messagebird_originator: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_test_otp: Schema.optionalKey(
    Schema.Union([
      Schema.String.check(Schema.isPattern(new RegExp("^([0-9]{1,15}=[0-9]+,?)*$"))),
      Schema.Null,
    ]),
  ),
  sms_test_otp_valid_until: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
  sms_textlocal_api_key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_textlocal_sender: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_twilio_account_sid: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_twilio_auth_token: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_twilio_content_sid: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_twilio_message_service_sid: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_twilio_verify_account_sid: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_twilio_verify_auth_token: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_twilio_verify_message_service_sid: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  sms_vonage_api_key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_vonage_api_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_vonage_from: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  sms_template: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_mfa_verification_attempt_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  hook_mfa_verification_attempt_uri: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_mfa_verification_attempt_secrets: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  hook_password_verification_attempt_enabled: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  hook_password_verification_attempt_uri: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  hook_password_verification_attempt_secrets: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  hook_custom_access_token_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  hook_custom_access_token_uri: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_custom_access_token_secrets: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_send_sms_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  hook_send_sms_uri: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_send_sms_secrets: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_send_email_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  hook_send_email_uri: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_send_email_secrets: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_before_user_created_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  hook_before_user_created_uri: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_before_user_created_secrets: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_after_user_created_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  hook_after_user_created_uri: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hook_after_user_created_secrets: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_apple_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_apple_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_apple_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_apple_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_apple_additional_client_ids: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  external_azure_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_azure_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_azure_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_azure_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_azure_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_bitbucket_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_bitbucket_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_bitbucket_email_optional: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  external_bitbucket_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_discord_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_discord_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_discord_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_discord_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_facebook_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_facebook_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_facebook_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_facebook_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_figma_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_figma_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_figma_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_figma_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_github_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_github_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_github_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_github_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_gitlab_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_gitlab_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_gitlab_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_gitlab_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_gitlab_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_google_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_google_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_google_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_google_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_google_additional_client_ids: Schema.optionalKey(
    Schema.Union([Schema.String, Schema.Null]),
  ),
  external_google_skip_nonce_check: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_kakao_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_kakao_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_kakao_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_kakao_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_keycloak_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_keycloak_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_keycloak_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_keycloak_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_keycloak_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_linkedin_oidc_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_linkedin_oidc_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_linkedin_oidc_email_optional: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  external_linkedin_oidc_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_slack_oidc_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_slack_oidc_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_slack_oidc_email_optional: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  external_slack_oidc_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_notion_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_notion_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_notion_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_notion_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_slack_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_slack_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_slack_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_slack_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_spotify_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_spotify_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_spotify_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_spotify_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_twitch_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_twitch_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_twitch_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_twitch_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_twitter_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_twitter_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_twitter_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_twitter_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_x_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_x_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_x_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_x_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_workos_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_workos_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_workos_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_workos_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_web3_solana_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_web3_ethereum_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_zoom_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_zoom_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  external_zoom_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  external_zoom_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  db_max_pool_size: Schema.optionalKey(
    Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  ),
  db_max_pool_size_unit: Schema.optionalKey(
    Schema.Union([Schema.Literals(["connections", "percent"]), Schema.Union([Schema.Null])]),
  ),
  api_max_request_duration: Schema.optionalKey(
    Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  ),
  mfa_totp_enroll_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  mfa_totp_verify_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  mfa_web_authn_enroll_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  mfa_web_authn_verify_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  passkey_enabled: Schema.optionalKey(Schema.Boolean),
  webauthn_rp_display_name: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  webauthn_rp_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  webauthn_rp_origins: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  mfa_phone_enroll_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  mfa_phone_verify_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  mfa_phone_max_frequency: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(32767)),
      Schema.Null,
    ]),
  ),
  mfa_phone_otp_length: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(32767)),
      Schema.Null,
    ]),
  ),
  mfa_phone_template: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  nimbus_oauth_client_id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  nimbus_oauth_client_secret: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  oauth_server_enabled: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  oauth_server_allow_dynamic_registration: Schema.optionalKey(
    Schema.Union([Schema.Boolean, Schema.Null]),
  ),
  oauth_server_authorization_path: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  custom_oauth_enabled: Schema.optionalKey(Schema.Boolean),
});
export const V1UpdateAuthServiceConfigOutput = Schema.Struct({
  api_max_request_duration: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  db_max_pool_size: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  db_max_pool_size_unit: Schema.Union([
    Schema.Literals(["connections", "percent"]),
    Schema.Union([Schema.Null]),
  ]),
  disable_signup: Schema.Union([Schema.Boolean, Schema.Null]),
  external_anonymous_users_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_apple_additional_client_ids: Schema.Union([Schema.String, Schema.Null]),
  external_apple_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_apple_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_apple_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_apple_secret: Schema.Union([Schema.String, Schema.Null]),
  external_azure_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_azure_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_azure_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_azure_secret: Schema.Union([Schema.String, Schema.Null]),
  external_azure_url: Schema.Union([Schema.String, Schema.Null]),
  external_bitbucket_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_bitbucket_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_bitbucket_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_bitbucket_secret: Schema.Union([Schema.String, Schema.Null]),
  external_discord_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_discord_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_discord_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_discord_secret: Schema.Union([Schema.String, Schema.Null]),
  external_email_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_facebook_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_facebook_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_facebook_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_facebook_secret: Schema.Union([Schema.String, Schema.Null]),
  external_figma_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_figma_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_figma_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_figma_secret: Schema.Union([Schema.String, Schema.Null]),
  external_github_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_github_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_github_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_github_secret: Schema.Union([Schema.String, Schema.Null]),
  external_gitlab_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_gitlab_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_gitlab_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_gitlab_secret: Schema.Union([Schema.String, Schema.Null]),
  external_gitlab_url: Schema.Union([Schema.String, Schema.Null]),
  external_google_additional_client_ids: Schema.Union([Schema.String, Schema.Null]),
  external_google_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_google_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_google_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_google_secret: Schema.Union([Schema.String, Schema.Null]),
  external_google_skip_nonce_check: Schema.Union([Schema.Boolean, Schema.Null]),
  external_kakao_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_kakao_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_kakao_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_kakao_secret: Schema.Union([Schema.String, Schema.Null]),
  external_keycloak_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_keycloak_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_keycloak_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_keycloak_secret: Schema.Union([Schema.String, Schema.Null]),
  external_keycloak_url: Schema.Union([Schema.String, Schema.Null]),
  external_linkedin_oidc_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_linkedin_oidc_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_linkedin_oidc_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_linkedin_oidc_secret: Schema.Union([Schema.String, Schema.Null]),
  external_slack_oidc_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_slack_oidc_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_oidc_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_oidc_secret: Schema.Union([Schema.String, Schema.Null]),
  external_notion_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_notion_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_notion_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_notion_secret: Schema.Union([Schema.String, Schema.Null]),
  external_phone_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_slack_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_slack_secret: Schema.Union([Schema.String, Schema.Null]),
  external_spotify_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_spotify_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_spotify_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_spotify_secret: Schema.Union([Schema.String, Schema.Null]),
  external_twitch_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_twitch_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_twitch_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_twitch_secret: Schema.Union([Schema.String, Schema.Null]),
  external_twitter_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_twitter_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_twitter_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_twitter_secret: Schema.Union([Schema.String, Schema.Null]),
  external_x_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_x_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_x_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_x_secret: Schema.Union([Schema.String, Schema.Null]),
  external_workos_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_workos_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_workos_secret: Schema.Union([Schema.String, Schema.Null]),
  external_workos_url: Schema.Union([Schema.String, Schema.Null]),
  external_web3_solana_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_web3_ethereum_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_zoom_client_id: Schema.Union([Schema.String, Schema.Null]),
  external_zoom_email_optional: Schema.Union([Schema.Boolean, Schema.Null]),
  external_zoom_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  external_zoom_secret: Schema.Union([Schema.String, Schema.Null]),
  hook_custom_access_token_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_custom_access_token_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_custom_access_token_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_mfa_verification_attempt_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_mfa_verification_attempt_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_mfa_verification_attempt_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_password_verification_attempt_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_password_verification_attempt_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_password_verification_attempt_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_send_sms_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_send_sms_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_send_sms_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_send_email_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_send_email_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_send_email_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_before_user_created_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_before_user_created_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_before_user_created_secrets: Schema.Union([Schema.String, Schema.Null]),
  hook_after_user_created_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  hook_after_user_created_uri: Schema.Union([Schema.String, Schema.Null]),
  hook_after_user_created_secrets: Schema.Union([Schema.String, Schema.Null]),
  jwt_exp: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  mailer_allow_unverified_email_sign_ins: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_autoconfirm: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_otp_exp: Schema.Number.check(Schema.isInt()),
  mailer_otp_length: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  mailer_secure_email_change_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_subjects_confirmation: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_email_change: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_invite: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_magic_link: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_reauthentication: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_recovery: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_password_changed_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_email_changed_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_phone_changed_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_mfa_factor_enrolled_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_mfa_factor_unenrolled_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_identity_linked_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_subjects_identity_unlinked_notification: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_confirmation_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_email_change_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_invite_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_magic_link_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_reauthentication_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_recovery_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_password_changed_notification_content: Schema.Union([
    Schema.String,
    Schema.Null,
  ]),
  mailer_templates_email_changed_notification_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_phone_changed_notification_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_mfa_factor_enrolled_notification_content: Schema.Union([
    Schema.String,
    Schema.Null,
  ]),
  mailer_templates_mfa_factor_unenrolled_notification_content: Schema.Union([
    Schema.String,
    Schema.Null,
  ]),
  mailer_templates_identity_linked_notification_content: Schema.Union([Schema.String, Schema.Null]),
  mailer_templates_identity_unlinked_notification_content: Schema.Union([
    Schema.String,
    Schema.Null,
  ]),
  mailer_notifications_password_changed_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_email_changed_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_phone_changed_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_mfa_factor_enrolled_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_mfa_factor_unenrolled_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_identity_linked_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mailer_notifications_identity_unlinked_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_max_enrolled_factors: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  mfa_totp_enroll_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_totp_verify_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_phone_enroll_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_phone_verify_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_web_authn_enroll_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  mfa_web_authn_verify_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  passkey_enabled: Schema.Boolean,
  webauthn_rp_display_name: Schema.Union([Schema.String, Schema.Null]),
  webauthn_rp_id: Schema.Union([Schema.String, Schema.Null]),
  webauthn_rp_origins: Schema.Union([Schema.String, Schema.Null]),
  mfa_phone_otp_length: Schema.Number.check(Schema.isInt()),
  mfa_phone_template: Schema.Union([Schema.String, Schema.Null]),
  mfa_phone_max_frequency: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  nimbus_oauth_client_id: Schema.Union([Schema.String, Schema.Null]),
  nimbus_oauth_email_optional: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Null])),
  nimbus_oauth_client_secret: Schema.Union([Schema.String, Schema.Null]),
  password_hibp_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  password_min_length: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  password_required_characters: Schema.Union([
    Schema.Literals([
      "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
      "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
      "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\\\:\"|<>?,./`~",
      "",
    ]),
    Schema.Union([Schema.Null]),
  ]),
  rate_limit_anonymous_users: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_email_sent: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_sms_sent: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_token_refresh: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_verify: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_otp: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  rate_limit_web3: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  refresh_token_rotation_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  saml_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  saml_external_url: Schema.Union([Schema.String, Schema.Null]),
  saml_allow_encrypted_assertions: Schema.Union([Schema.Boolean, Schema.Null]),
  security_sb_forwarded_for_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  security_captcha_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  security_captcha_provider: Schema.Union([
    Schema.Literals(["turnstile", "hcaptcha"]),
    Schema.Union([Schema.Null]),
  ]),
  security_captcha_secret: Schema.Union([Schema.String, Schema.Null]),
  security_manual_linking_enabled: Schema.Union([Schema.Boolean, Schema.Null]),
  security_refresh_token_reuse_interval: Schema.Union([
    Schema.Number.check(Schema.isInt()),
    Schema.Null,
  ]),
  security_update_password_require_reauthentication: Schema.Union([Schema.Boolean, Schema.Null]),
  sessions_inactivity_timeout: Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null]),
  sessions_single_per_user: Schema.Union([Schema.Boolean, Schema.Null]),
  sessions_tags: Schema.Union([Schema.String, Schema.Null]),
  sessions_timebox: Schema.Union([Schema.Number.check(Schema.isFinite()), Schema.Null]),
  site_url: Schema.Union([Schema.String, Schema.Null]),
  sms_autoconfirm: Schema.Union([Schema.Boolean, Schema.Null]),
  sms_max_frequency: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  sms_messagebird_access_key: Schema.Union([Schema.String, Schema.Null]),
  sms_messagebird_originator: Schema.Union([Schema.String, Schema.Null]),
  sms_otp_exp: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  sms_otp_length: Schema.Number.check(Schema.isInt()),
  sms_provider: Schema.Union([
    Schema.Literals(["messagebird", "textlocal", "twilio", "twilio_verify", "vonage"]),
    Schema.Union([Schema.Null]),
  ]),
  sms_template: Schema.Union([Schema.String, Schema.Null]),
  sms_test_otp: Schema.Union([Schema.String, Schema.Null]),
  sms_test_otp_valid_until: Schema.Union([
    Schema.String.annotate({ format: "date-time" }),
    Schema.Null,
  ]),
  sms_textlocal_api_key: Schema.Union([Schema.String, Schema.Null]),
  sms_textlocal_sender: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_account_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_auth_token: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_content_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_message_service_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_verify_account_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_verify_auth_token: Schema.Union([Schema.String, Schema.Null]),
  sms_twilio_verify_message_service_sid: Schema.Union([Schema.String, Schema.Null]),
  sms_vonage_api_key: Schema.Union([Schema.String, Schema.Null]),
  sms_vonage_api_secret: Schema.Union([Schema.String, Schema.Null]),
  sms_vonage_from: Schema.Union([Schema.String, Schema.Null]),
  smtp_admin_email: Schema.Union([Schema.String.annotate({ format: "email" }), Schema.Null]),
  smtp_host: Schema.Union([Schema.String, Schema.Null]),
  smtp_max_frequency: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  smtp_pass: Schema.Union([Schema.String, Schema.Null]),
  smtp_port: Schema.Union([Schema.String, Schema.Null]),
  smtp_sender_name: Schema.Union([Schema.String, Schema.Null]),
  smtp_user: Schema.Union([Schema.String, Schema.Null]),
  uri_allow_list: Schema.Union([Schema.String, Schema.Null]),
  oauth_server_enabled: Schema.Boolean,
  oauth_server_allow_dynamic_registration: Schema.Boolean,
  oauth_server_authorization_path: Schema.Union([Schema.String, Schema.Null]),
  custom_oauth_enabled: Schema.Boolean,
  custom_oauth_max_providers: Schema.Number.check(Schema.isInt()),
});
export const V1UpdateBackupScheduleInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  schedule_for: Schema.String.annotate({
    description: "Time of day to schedule daily backups, in UTC. Format: HH:MM:SS.",
  }),
});
export const V1UpdateBackupScheduleOutput = Schema.Struct({
  schedule_for: Schema.String.annotate({
    description: "Time of day to schedule daily backups, in UTC. Format: HH:MM:SS.",
  }),
  updated_at: Schema.String.annotate({
    description: "Timestamp of when the backup schedule was last updated.",
    format: "date-time",
  }),
});
export const V1UpdateDatabasePasswordInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  password: Schema.String.check(Schema.isMinLength(4)),
});
export const V1UpdateDatabasePasswordOutput = Schema.Struct({ message: Schema.String });
export const V1UpdateHostnameConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  custom_hostname: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(253)),
});
export const V1UpdateHostnameConfigOutput = Schema.Struct({
  status: Schema.optionalKey(
    Schema.Literals([
      "1_not_started",
      "2_initiated",
      "3_challenge_verified",
      "4_origin_setup_completed",
      "5_services_reconfigured",
    ]),
  ),
  custom_hostname: Schema.optionalKey(Schema.String),
  data: Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.Array(Schema.Json.annotate({ description: "Any JSON-serializable value" })),
    messages: Schema.Array(Schema.Json.annotate({ description: "Any JSON-serializable value" })),
    result: Schema.Struct({
      id: Schema.String,
      hostname: Schema.String,
      ssl: Schema.Struct({
        status: Schema.String,
        validation_records: Schema.optionalKey(
          Schema.Array(Schema.Struct({ txt_name: Schema.String, txt_value: Schema.String })),
        ),
        validation_errors: Schema.optionalKey(
          Schema.Array(Schema.Struct({ message: Schema.String })),
        ),
      }),
      ownership_verification: Schema.optionalKey(
        Schema.Struct({ type: Schema.String, name: Schema.String, value: Schema.String }),
      ),
      custom_origin_server: Schema.String,
      verification_errors: Schema.optionalKey(Schema.Array(Schema.String)),
      status: Schema.String,
    }),
  }),
});
export const V1UpdateJitAccessInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  user_id: Schema.String.annotate({ format: "uuid" })
    .check(Schema.isMinLength(1))
    .check(
      Schema.isPattern(
        new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
      ),
    ),
  roles: Schema.Array(
    Schema.Struct({
      role: Schema.String.check(Schema.isMinLength(1)),
      expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      allowed_networks: Schema.optionalKey(
        Schema.Struct({
          allowed_cidrs: Schema.optionalKey(Schema.Array(Schema.Struct({ cidr: Schema.String }))),
          allowed_cidrs_v6: Schema.optionalKey(
            Schema.Array(Schema.Struct({ cidr: Schema.String })),
          ),
        }),
      ),
      branches_only: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export const V1UpdateJitAccessOutput = Schema.Struct({
  user_id: Schema.optionalKey(
    Schema.String.annotate({ format: "uuid" }).check(
      Schema.isPattern(
        new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
      ),
    ),
  ),
  user_roles: Schema.Array(
    Schema.Struct({
      role: Schema.String.check(Schema.isMinLength(1)),
      expires_at: Schema.optionalKey(Schema.Number.check(Schema.isFinite())),
      allowed_networks: Schema.optionalKey(
        Schema.Struct({
          allowed_cidrs: Schema.optionalKey(Schema.Array(Schema.Struct({ cidr: Schema.String }))),
          allowed_cidrs_v6: Schema.optionalKey(
            Schema.Array(Schema.Struct({ cidr: Schema.String })),
          ),
        }),
      ),
      branches_only: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
export const V1UpdateJitAccessConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  state: Schema.Literals(["enabled", "disabled"]),
});
export const V1UpdateJitAccessConfigOutput = Schema.Union(
  [
    Schema.Struct({
      state: Schema.Literals(["enabled", "disabled"]),
      appliedSuccessfully: Schema.optionalKey(Schema.Boolean),
    }),
    Schema.Struct({
      state: Schema.Literal("unavailable"),
      unavailableReason: Schema.Literals(["postgres_upgrade_required", "temporarily_unavailable"]),
    }),
  ],
  { mode: "oneOf" },
);
export const V1UpdateNetworkRestrictionsInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  dbAllowedCidrs: Schema.optionalKey(Schema.Array(Schema.String)),
  dbAllowedCidrsV6: Schema.optionalKey(Schema.Array(Schema.String)),
});
export const V1UpdateNetworkRestrictionsOutput = Schema.Struct({
  entitlement: Schema.Literals(["disallowed", "allowed"]),
  config: Schema.Struct({
    dbAllowedCidrs: Schema.optionalKey(Schema.Array(Schema.String)),
    dbAllowedCidrsV6: Schema.optionalKey(Schema.Array(Schema.String)),
  }).annotate({
    description:
      "At any given point in time, this is the config that the user has requested be applied to their project. The `status` field indicates if it has been applied to the project, or is pending. When an updated config is received, the applied config is moved to `old_config`.",
  }),
  old_config: Schema.optionalKey(
    Schema.Struct({
      dbAllowedCidrs: Schema.optionalKey(Schema.Array(Schema.String)),
      dbAllowedCidrsV6: Schema.optionalKey(Schema.Array(Schema.String)),
    }).annotate({
      description:
        "Populated when a new config has been received, but not registered as successfully applied to a project.",
    }),
  ),
  status: Schema.Literals(["stored", "applied"]),
  updated_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
  applied_at: Schema.optionalKey(Schema.String.annotate({ format: "date-time" })),
});
export const V1UpdatePgsodiumConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  root_key: Schema.String,
});
export const V1UpdatePgsodiumConfigOutput = Schema.Struct({ root_key: Schema.String });
export const V1UpdatePoolerConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  default_pool_size: Schema.optionalKey(
    Schema.Union([
      Schema.Number.check(Schema.isInt())
        .check(Schema.isGreaterThanOrEqualTo(0))
        .check(Schema.isLessThanOrEqualTo(3000)),
      Schema.Null,
    ]),
  ),
  pool_mode: Schema.optionalKey(
    Schema.Literals(["transaction", "session"]).annotate({
      description: "Dedicated pooler mode for the project",
    }),
  ),
});
export const V1UpdatePoolerConfigOutput = Schema.Struct({
  default_pool_size: Schema.Union([Schema.Number.check(Schema.isInt()), Schema.Null]),
  pool_mode: Schema.String,
});
export const V1UpdatePostgresConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  effective_cache_size: Schema.optionalKey(Schema.String),
  logical_decoding_work_mem: Schema.optionalKey(Schema.String),
  "cron.log_statement": Schema.optionalKey(Schema.Boolean),
  log_autovacuum_min_duration: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  log_checkpoints: Schema.optionalKey(Schema.Boolean),
  log_connections: Schema.optionalKey(Schema.Boolean),
  log_disconnections: Schema.optionalKey(Schema.Boolean),
  log_duration: Schema.optionalKey(Schema.Boolean),
  log_lock_waits: Schema.optionalKey(Schema.Boolean),
  log_recovery_conflict_waits: Schema.optionalKey(Schema.Boolean),
  log_replication_commands: Schema.optionalKey(Schema.Boolean),
  log_startup_progress_interval: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  log_temp_files: Schema.optionalKey(Schema.String),
  maintenance_work_mem: Schema.optionalKey(Schema.String),
  track_activity_query_size: Schema.optionalKey(Schema.String),
  max_connections: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(262143)),
  ),
  max_locks_per_transaction: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(10))
      .check(Schema.isLessThanOrEqualTo(2147483640)),
  ),
  max_parallel_maintenance_workers: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_parallel_workers: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_parallel_workers_per_gather: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_replication_slots: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  max_slot_wal_keep_size: Schema.optionalKey(Schema.String),
  max_standby_archive_delay: Schema.optionalKey(Schema.String),
  max_standby_streaming_delay: Schema.optionalKey(Schema.String),
  max_wal_size: Schema.optionalKey(Schema.String),
  max_wal_senders: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  max_worker_processes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(262143)),
  ),
  session_replication_role: Schema.optionalKey(Schema.Literals(["origin", "replica", "local"])),
  shared_buffers: Schema.optionalKey(Schema.String),
  statement_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  track_commit_timestamp: Schema.optionalKey(Schema.Boolean),
  wal_keep_size: Schema.optionalKey(Schema.String),
  wal_sender_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  work_mem: Schema.optionalKey(Schema.String),
  checkpoint_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: s" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  hot_standby_feedback: Schema.optionalKey(Schema.Boolean),
  restart_database: Schema.optionalKey(Schema.Boolean),
});
export const V1UpdatePostgresConfigOutput = Schema.Struct({
  effective_cache_size: Schema.optionalKey(Schema.String),
  logical_decoding_work_mem: Schema.optionalKey(Schema.String),
  "cron.log_statement": Schema.optionalKey(Schema.Boolean),
  log_autovacuum_min_duration: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  log_checkpoints: Schema.optionalKey(Schema.Boolean),
  log_connections: Schema.optionalKey(Schema.Boolean),
  log_disconnections: Schema.optionalKey(Schema.Boolean),
  log_duration: Schema.optionalKey(Schema.Boolean),
  log_lock_waits: Schema.optionalKey(Schema.Boolean),
  log_recovery_conflict_waits: Schema.optionalKey(Schema.Boolean),
  log_replication_commands: Schema.optionalKey(Schema.Boolean),
  log_startup_progress_interval: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  log_temp_files: Schema.optionalKey(Schema.String),
  maintenance_work_mem: Schema.optionalKey(Schema.String),
  track_activity_query_size: Schema.optionalKey(Schema.String),
  max_connections: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(262143)),
  ),
  max_locks_per_transaction: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(10))
      .check(Schema.isLessThanOrEqualTo(2147483640)),
  ),
  max_parallel_maintenance_workers: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_parallel_workers: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_parallel_workers_per_gather: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1024)),
  ),
  max_replication_slots: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  max_slot_wal_keep_size: Schema.optionalKey(Schema.String),
  max_standby_archive_delay: Schema.optionalKey(Schema.String),
  max_standby_streaming_delay: Schema.optionalKey(Schema.String),
  max_wal_size: Schema.optionalKey(Schema.String),
  max_wal_senders: Schema.optionalKey(Schema.Number.check(Schema.isInt())),
  max_worker_processes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(262143)),
  ),
  session_replication_role: Schema.optionalKey(Schema.Literals(["origin", "replica", "local"])),
  shared_buffers: Schema.optionalKey(Schema.String),
  statement_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  track_commit_timestamp: Schema.optionalKey(Schema.Boolean),
  wal_keep_size: Schema.optionalKey(Schema.String),
  wal_sender_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: ms" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  work_mem: Schema.optionalKey(Schema.String),
  checkpoint_timeout: Schema.optionalKey(
    Schema.String.annotate({ description: "Default unit: s" }).check(
      Schema.isPattern(new RegExp("^(-?[0-9]+(?:\\.[0-9]+)?)(us|ms|s|min|h|d)?$")),
    ),
  ),
  hot_standby_feedback: Schema.optionalKey(Schema.Boolean),
});
export const V1UpdatePostgrestServiceConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  db_extra_search_path: Schema.optionalKey(Schema.String),
  db_schema: Schema.optionalKey(Schema.String),
  max_rows: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1000000)),
  ),
  db_pool: Schema.optionalKey(
    Schema.Number.check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(1000)),
  ),
});
export const V1UpdatePostgrestServiceConfigOutput = Schema.Struct({
  db_schema: Schema.String,
  max_rows: Schema.Number.check(Schema.isInt()),
  db_extra_search_path: Schema.String,
  db_pool: Schema.Union([
    Schema.Number.annotate({
      description: "If `null`, the value is automatically configured based on compute size.",
    }).check(Schema.isInt()),
    Schema.Null,
  ]),
});
export const V1UpdateProjectApiKeyInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  reveal: Schema.optionalKey(Schema.Boolean),
  name: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(4))
      .check(Schema.isMaxLength(64))
      .check(Schema.isPattern(new RegExp("^[a-z_][a-z0-9_]+$"))),
  ),
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  secret_jwt_template: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.Null]),
  ),
});
export const V1UpdateProjectApiKeyOutput = Schema.Struct({
  api_key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  type: Schema.optionalKey(
    Schema.Union([
      Schema.Literals(["legacy", "publishable", "secret"]),
      Schema.Union([Schema.Null]),
    ]),
  ),
  prefix: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  name: Schema.String,
  description: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  hash: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
  secret_jwt_template: Schema.optionalKey(
    Schema.Union([Schema.Record(Schema.String, Schema.Json), Schema.Null]),
  ),
  inserted_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
  updated_at: Schema.optionalKey(
    Schema.Union([Schema.String.annotate({ format: "date-time" }), Schema.Null]),
  ),
});
export const V1UpdateProjectLegacyApiKeysInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  enabled: Schema.Boolean,
});
export const V1UpdateProjectLegacyApiKeysOutput = Schema.Struct({ enabled: Schema.Boolean });
export const V1UpdateProjectSigningKeyInput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  status: Schema.Literals(["in_use", "previously_used", "revoked", "standby"]),
});
export const V1UpdateProjectSigningKeyOutput = Schema.Struct({
  id: Schema.String.annotate({ format: "uuid" }).check(
    Schema.isPattern(
      new RegExp("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"),
    ),
  ),
  algorithm: Schema.Literals(["EdDSA", "ES256", "RS256", "HS256"]),
  status: Schema.Literals(["in_use", "previously_used", "revoked", "standby"]),
  public_jwk: Schema.optionalKey(Schema.Union([Schema.Json, Schema.Null])),
  created_at: Schema.String.annotate({ format: "date-time" }),
  updated_at: Schema.String.annotate({ format: "date-time" }),
});
export const V1UpdateRealtimeConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  private_only: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Whether to only allow private channels" }),
  ),
  connection_pool: Schema.optionalKey(
    Schema.Number.annotate({ description: "Sets connection pool size for Realtime Authorization" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(100)),
  ),
  max_concurrent_users: Schema.optionalKey(
    Schema.Number.annotate({ description: "Sets maximum number of concurrent users rate limit" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(50000)),
  ),
  max_events_per_second: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Sets maximum number of events per second rate per channel limit",
    })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(50000)),
  ),
  max_bytes_per_second: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Sets maximum number of bytes per second rate per channel limit",
    })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(10000000)),
  ),
  max_channels_per_client: Schema.optionalKey(
    Schema.Number.annotate({ description: "Sets maximum number of channels per client rate limit" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(10000)),
  ),
  max_joins_per_second: Schema.optionalKey(
    Schema.Number.annotate({ description: "Sets maximum number of joins per second rate limit" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(5000)),
  ),
  max_presence_events_per_second: Schema.optionalKey(
    Schema.Number.annotate({
      description: "Sets maximum number of presence events per second rate limit",
    })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(5000)),
  ),
  max_payload_size_in_kb: Schema.optionalKey(
    Schema.Number.annotate({ description: "Sets maximum number of payload size in KB rate limit" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(10000)),
  ),
  suspend: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Disables the Realtime service for this project when true. Set to false to re-enable it.",
    }),
  ),
  presence_enabled: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Whether to enable presence" }),
  ),
});
export const V1UpdateSslEnforcementConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  requestedConfig: Schema.Struct({ database: Schema.Boolean }),
});
export const V1UpdateSslEnforcementConfigOutput = Schema.Struct({
  currentConfig: Schema.Struct({ database: Schema.Boolean }),
  appliedSuccessfully: Schema.Boolean,
});
export const V1UpdateStorageConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  fileSizeLimit: Schema.optionalKey(
    Schema.Number.annotate({ format: "int64" })
      .check(Schema.isInt())
      .check(Schema.isGreaterThanOrEqualTo(0))
      .check(Schema.isLessThanOrEqualTo(536870912000)),
  ),
  features: Schema.optionalKey(
    Schema.Struct({
      imageTransformation: Schema.optionalKey(Schema.Struct({ enabled: Schema.Boolean })),
      s3Protocol: Schema.optionalKey(Schema.Struct({ enabled: Schema.Boolean })),
      icebergCatalog: Schema.optionalKey(
        Schema.Struct({
          enabled: Schema.Boolean,
          maxNamespaces: Schema.Number.check(Schema.isInt()).check(
            Schema.isGreaterThanOrEqualTo(0),
          ),
          maxTables: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
          maxCatalogs: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      ),
      vectorBuckets: Schema.optionalKey(
        Schema.Struct({
          enabled: Schema.Boolean,
          maxBuckets: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
          maxIndexes: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      ),
    }),
  ),
  external: Schema.optionalKey(
    Schema.Struct({ upstreamTarget: Schema.Literals(["main", "canary"]) }),
  ),
});
export const V1UpgradePostgresVersionInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  target_version: Schema.String,
  release_channel: Schema.optionalKey(
    Schema.Literals(["internal", "alpha", "beta", "ga", "withdrawn", "preview"]),
  ),
});
export const V1UpgradePostgresVersionOutput = Schema.Struct({ tracking_id: Schema.String });
export const V1UpsertAMigrationInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
  "Idempotency-Key": Schema.optionalKey(Schema.String),
  query: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.optionalKey(Schema.String),
  rollback: Schema.optionalKey(Schema.String),
});
export const V1VerifyDnsConfigInput = Schema.Struct({
  ref: Schema.String.check(Schema.isMinLength(20))
    .check(Schema.isMaxLength(20))
    .check(Schema.isPattern(new RegExp("^[a-z]+$"))),
});
export const V1VerifyDnsConfigOutput = Schema.Struct({
  status: Schema.optionalKey(
    Schema.Literals([
      "1_not_started",
      "2_initiated",
      "3_challenge_verified",
      "4_origin_setup_completed",
      "5_services_reconfigured",
    ]),
  ),
  custom_hostname: Schema.optionalKey(Schema.String),
  data: Schema.Struct({
    success: Schema.Boolean,
    errors: Schema.Array(Schema.Json.annotate({ description: "Any JSON-serializable value" })),
    messages: Schema.Array(Schema.Json.annotate({ description: "Any JSON-serializable value" })),
    result: Schema.Struct({
      id: Schema.String,
      hostname: Schema.String,
      ssl: Schema.Struct({
        status: Schema.String,
        validation_records: Schema.optionalKey(
          Schema.Array(Schema.Struct({ txt_name: Schema.String, txt_value: Schema.String })),
        ),
        validation_errors: Schema.optionalKey(
          Schema.Array(Schema.Struct({ message: Schema.String })),
        ),
      }),
      ownership_verification: Schema.optionalKey(
        Schema.Struct({ type: Schema.String, name: Schema.String, value: Schema.String }),
      ),
      custom_origin_server: Schema.String,
      verification_errors: Schema.optionalKey(Schema.Array(Schema.String)),
      status: Schema.String,
    }),
  }),
});
export const V1ApplyAMigrationOutput = Schema.Void;
export const V1ApplyProjectAddonOutput = Schema.Void;
export const V1AuthorizeUserOutput = Schema.Void;
export const V1BulkCreateSecretsOutput = Schema.Void;
export const V1BulkDeleteSecretsOutput = Schema.Void;
export const V1CancelAProjectRestorationOutput = Schema.Void;
export const V1ClaimProjectForOrganizationOutput = Schema.Void;
export const V1CountActionRunsOutput = Schema.Void;
export const V1DeactivateVanitySubdomainConfigOutput = Schema.Void;
export const V1DeleteHostnameConfigOutput = Schema.Void;
export const V1DeleteAFunctionOutput = Schema.Void;
export const V1DeleteInviteExternalJitAccessOutput = Schema.Void;
export const V1DeleteJitAccessOutput = Schema.Void;
export const V1DeleteNetworkBansOutput = Schema.Void;
export const V1DeleteProjectClaimTokenOutput = Schema.Void;
export const V1DisablePreviewBranchingOutput = Schema.Void;
export const V1DisableReadonlyModeTemporarilyOutput = Schema.Void;
export const V1EnableDatabaseWebhookOutput = Schema.Void;
export const V1ModifyDatabaseDiskOutput = Schema.Void;
export const V1OauthAuthorizeProjectClaimOutput = Schema.Void;
export const V1PatchAMigrationOutput = Schema.Void;
export const V1PauseAProjectOutput = Schema.Void;
export const V1ReadOnlyQueryOutput = Schema.Void;
export const V1RemoveAReadReplicaOutput = Schema.Void;
export const V1RemoveProjectAddonOutput = Schema.Void;
export const V1RestartAProjectOutput = Schema.Void;
export const V1RestoreAProjectOutput = Schema.Void;
export const V1RestorePhysicalBackupOutput = Schema.Void;
export const V1RestorePitrBackupOutput = Schema.Void;
export const V1RevokeTokenOutput = Schema.Void;
export const V1RollbackMigrationsOutput = Schema.Void;
export const V1RunAQueryOutput = Schema.Void;
export const V1SetupAReadReplicaOutput = Schema.Void;
export const V1ShutdownRealtimeOutput = Schema.Void;
export const V1UndoOutput = Schema.Void;
export const V1UpdateRealtimeConfigOutput = Schema.Void;
export const V1UpdateStorageConfigOutput = Schema.Void;
export const V1UpsertAMigrationOutput = Schema.Void;

export const openApiOperationIdMap = {
  "v1-accept-invite-external-jit-access": "v1AcceptInviteExternalJitAccess",
  "v1-activate-custom-hostname": "v1ActivateCustomHostname",
  "v1-activate-vanity-subdomain-config": "v1ActivateVanitySubdomainConfig",
  "v1-apply-a-migration": "v1ApplyAMigration",
  "v1-apply-project-addon": "v1ApplyProjectAddon",
  "v1-authorize-jit-access": "v1AuthorizeJitAccess",
  "v1-authorize-user": "v1AuthorizeUser",
  "v1-bulk-create-secrets": "v1BulkCreateSecrets",
  "v1-bulk-delete-secrets": "v1BulkDeleteSecrets",
  "v1-bulk-update-functions": "v1BulkUpdateFunctions",
  "v1-cancel-a-project-restoration": "v1CancelAProjectRestoration",
  "v1-check-vanity-subdomain-availability": "v1CheckVanitySubdomainAvailability",
  "v1-claim-project-for-organization": "v1ClaimProjectForOrganization",
  "v1-count-action-runs": "v1CountActionRuns",
  "v1-create-a-branch": "v1CreateABranch",
  "v1-create-a-function": "v1CreateAFunction",
  "v1-create-a-project": "v1CreateAProject",
  "v1-create-a-sso-provider": "v1CreateASsoProvider",
  "v1-create-an-organization": "v1CreateAnOrganization",
  "v1-create-legacy-signing-key": "v1CreateLegacySigningKey",
  "v1-create-login-role": "v1CreateLoginRole",
  "v1-create-project-api-key": "v1CreateProjectApiKey",
  "v1-create-project-claim-token": "v1CreateProjectClaimToken",
  "v1-create-project-signing-key": "v1CreateProjectSigningKey",
  "v1-create-project-tpa-integration": "v1CreateProjectTpaIntegration",
  "v1-create-restore-point": "v1CreateRestorePoint",
  "v1-deactivate-vanity-subdomain-config": "v1DeactivateVanitySubdomainConfig",
  "v1-Delete hostname config": "v1DeleteHostnameConfig",
  "v1-delete-a-branch": "v1DeleteABranch",
  "v1-delete-a-function": "v1DeleteAFunction",
  "v1-delete-a-project": "v1DeleteAProject",
  "v1-delete-a-sso-provider": "v1DeleteASsoProvider",
  "v1-delete-invite-external-jit-access": "v1DeleteInviteExternalJitAccess",
  "v1-delete-jit-access": "v1DeleteJitAccess",
  "v1-delete-login-roles": "v1DeleteLoginRoles",
  "v1-delete-network-bans": "v1DeleteNetworkBans",
  "v1-delete-project-api-key": "v1DeleteProjectApiKey",
  "v1-delete-project-claim-token": "v1DeleteProjectClaimToken",
  "v1-delete-project-tpa-integration": "v1DeleteProjectTpaIntegration",
  "v1-deploy-a-function": "v1DeployAFunction",
  "v1-diff-a-branch": "v1DiffABranch",
  "v1-disable-preview-branching": "v1DisablePreviewBranching",
  "v1-disable-readonly-mode-temporarily": "v1DisableReadonlyModeTemporarily",
  "v1-enable-database-webhook": "v1EnableDatabaseWebhook",
  "v1-exchange-oauth-token": "v1ExchangeOauthToken",
  "v1-generate-typescript-types": "v1GenerateTypescriptTypes",
  "v1-get-a-branch": "v1GetABranch",
  "v1-get-a-branch-config": "v1GetABranchConfig",
  "v1-get-a-function": "v1GetAFunction",
  "v1-get-a-function-body": "v1GetAFunctionBody",
  "v1-get-a-migration": "v1GetAMigration",
  "v1-get-a-snippet": "v1GetASnippet",
  "v1-get-a-sso-provider": "v1GetASsoProvider",
  "v1-get-action-run": "v1GetActionRun",
  "v1-get-action-run-logs": "v1GetActionRunLogs",
  "v1-get-all-projects-for-organization": "v1GetAllProjectsForOrganization",
  "v1-get-an-organization": "v1GetAnOrganization",
  "v1-get-auth-service-config": "v1GetAuthServiceConfig",
  "v1-get-available-regions": "v1GetAvailableRegions",
  "v1-get-backup-schedule": "v1GetBackupSchedule",
  "v1-get-database-disk": "v1GetDatabaseDisk",
  "v1-get-database-metadata": "v1GetDatabaseMetadata",
  "v1-get-database-openapi": "v1GetDatabaseOpenapi",
  "v1-get-disk-utilization": "v1GetDiskUtilization",
  "v1-get-hostname-config": "v1GetHostnameConfig",
  "v1-get-jit-access": "v1GetJitAccess",
  "v1-get-jit-access-config": "v1GetJitAccessConfig",
  "v1-get-legacy-signing-key": "v1GetLegacySigningKey",
  "v1-get-network-restrictions": "v1GetNetworkRestrictions",
  "v1-get-organization-entitlements": "v1GetOrganizationEntitlements",
  "v1-get-organization-project-claim": "v1GetOrganizationProjectClaim",
  "v1-get-performance-advisors": "v1GetPerformanceAdvisors",
  "v1-get-pgsodium-config": "v1GetPgsodiumConfig",
  "v1-get-pooler-config": "v1GetPoolerConfig",
  "v1-get-postgres-config": "v1GetPostgresConfig",
  "v1-get-postgres-upgrade-eligibility": "v1GetPostgresUpgradeEligibility",
  "v1-get-postgres-upgrade-status": "v1GetPostgresUpgradeStatus",
  "v1-get-postgrest-service-config": "v1GetPostgrestServiceConfig",
  "v1-get-profile": "v1GetProfile",
  "v1-get-project": "v1GetProject",
  "v1-get-project-api-key": "v1GetProjectApiKey",
  "v1-get-project-api-keys": "v1GetProjectApiKeys",
  "v1-get-project-claim-token": "v1GetProjectClaimToken",
  "v1-get-project-disk-autoscale-config": "v1GetProjectDiskAutoscaleConfig",
  "v1-get-project-function-combined-stats": "v1GetProjectFunctionCombinedStats",
  "v1-get-project-legacy-api-keys": "v1GetProjectLegacyApiKeys",
  "v1-get-project-logs": "v1GetProjectLogs",
  "v1-get-project-logs-all": "v1GetProjectLogsAll",
  "v1-get-project-pgbouncer-config": "v1GetProjectPgbouncerConfig",
  "v1-get-project-signing-key": "v1GetProjectSigningKey",
  "v1-get-project-signing-keys": "v1GetProjectSigningKeys",
  "v1-get-project-tpa-integration": "v1GetProjectTpaIntegration",
  "v1-get-project-usage-api-count": "v1GetProjectUsageApiCount",
  "v1-get-project-usage-request-count": "v1GetProjectUsageRequestCount",
  "v1-get-readonly-mode-status": "v1GetReadonlyModeStatus",
  "v1-get-realtime-config": "v1GetRealtimeConfig",
  "v1-get-restore-point": "v1GetRestorePoint",
  "v1-get-security-advisors": "v1GetSecurityAdvisors",
  "v1-get-services-health": "v1GetServicesHealth",
  "v1-get-ssl-enforcement-config": "v1GetSslEnforcementConfig",
  "v1-get-storage-config": "v1GetStorageConfig",
  "v1-get-vanity-subdomain-config": "v1GetVanitySubdomainConfig",
  "v1-invite-external-jit-access": "v1InviteExternalJitAccess",
  "v1-list-action-runs": "v1ListActionRuns",
  "v1-list-all-backups": "v1ListAllBackups",
  "v1-list-all-branches": "v1ListAllBranches",
  "v1-list-all-buckets": "v1ListAllBuckets",
  "v1-list-all-functions": "v1ListAllFunctions",
  "v1-list-all-network-bans": "v1ListAllNetworkBans",
  "v1-list-all-network-bans-enriched": "v1ListAllNetworkBansEnriched",
  "v1-list-all-organizations": "v1ListAllOrganizations",
  "v1-list-all-projects": "v1ListAllProjects",
  "v1-list-all-secrets": "v1ListAllSecrets",
  "v1-list-all-snippets": "v1ListAllSnippets",
  "v1-list-all-sso-provider": "v1ListAllSsoProvider",
  "v1-list-available-restore-versions": "v1ListAvailableRestoreVersions",
  "v1-list-jit-access": "v1ListJitAccess",
  "v1-list-migration-history": "v1ListMigrationHistory",
  "v1-list-organization-members": "v1ListOrganizationMembers",
  "v1-list-project-addons": "v1ListProjectAddons",
  "v1-list-project-tpa-integrations": "v1ListProjectTpaIntegrations",
  "v1-merge-a-branch": "v1MergeABranch",
  "v1-modify-database-disk": "v1ModifyDatabaseDisk",
  "v1-oauth-authorize-project-claim": "v1OauthAuthorizeProjectClaim",
  "v1-patch-a-migration": "v1PatchAMigration",
  "v1-patch-network-restrictions": "v1PatchNetworkRestrictions",
  "v1-pause-a-project": "v1PauseAProject",
  "v1-push-a-branch": "v1PushABranch",
  "v1-read-only-query": "v1ReadOnlyQuery",
  "v1-remove-a-read-replica": "v1RemoveAReadReplica",
  "v1-remove-project-addon": "v1RemoveProjectAddon",
  "v1-remove-project-signing-key": "v1RemoveProjectSigningKey",
  "v1-reset-a-branch": "v1ResetABranch",
  "v1-restart-a-project": "v1RestartAProject",
  "v1-restore-a-branch": "v1RestoreABranch",
  "v1-restore-a-project": "v1RestoreAProject",
  "v1-restore-physical-backup": "v1RestorePhysicalBackup",
  "v1-restore-pitr-backup": "v1RestorePitrBackup",
  "v1-revoke-token": "v1RevokeToken",
  "v1-rollback-migrations": "v1RollbackMigrations",
  "v1-run-a-query": "v1RunAQuery",
  "v1-setup-a-read-replica": "v1SetupAReadReplica",
  "v1-shutdown-realtime": "v1ShutdownRealtime",
  "v1-undo": "v1Undo",
  "v1-update-a-branch-config": "v1UpdateABranchConfig",
  "v1-update-a-function": "v1UpdateAFunction",
  "v1-update-a-project": "v1UpdateAProject",
  "v1-update-a-sso-provider": "v1UpdateASsoProvider",
  "v1-update-action-run-status": "v1UpdateActionRunStatus",
  "v1-update-auth-service-config": "v1UpdateAuthServiceConfig",
  "v1-update-backup-schedule": "v1UpdateBackupSchedule",
  "v1-update-database-password": "v1UpdateDatabasePassword",
  "v1-update-hostname-config": "v1UpdateHostnameConfig",
  "v1-update-jit-access": "v1UpdateJitAccess",
  "v1-update-jit-access-config": "v1UpdateJitAccessConfig",
  "v1-update-network-restrictions": "v1UpdateNetworkRestrictions",
  "v1-update-pgsodium-config": "v1UpdatePgsodiumConfig",
  "v1-update-pooler-config": "v1UpdatePoolerConfig",
  "v1-update-postgres-config": "v1UpdatePostgresConfig",
  "v1-update-postgrest-service-config": "v1UpdatePostgrestServiceConfig",
  "v1-update-project-api-key": "v1UpdateProjectApiKey",
  "v1-update-project-legacy-api-keys": "v1UpdateProjectLegacyApiKeys",
  "v1-update-project-signing-key": "v1UpdateProjectSigningKey",
  "v1-update-realtime-config": "v1UpdateRealtimeConfig",
  "v1-update-ssl-enforcement-config": "v1UpdateSslEnforcementConfig",
  "v1-update-storage-config": "v1UpdateStorageConfig",
  "v1-upgrade-postgres-version": "v1UpgradePostgresVersion",
  "v1-upsert-a-migration": "v1UpsertAMigration",
  "v1-verify-dns-config": "v1VerifyDnsConfig",
} as const;

export const operationDefinitions = {
  v1AcceptInviteExternalJitAccess: {
    id: "v1AcceptInviteExternalJitAccess",
    description: "Accepts the invitation to JIT database access",
    method: "POST",
    path: "/v1/projects/{ref}/database/jit/invite/accept",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["email", "token"] },
    response: { kind: "json" },
    inputSchema: V1AcceptInviteExternalJitAccessInput,
    outputSchema: V1AcceptInviteExternalJitAccessOutput,
  },
  v1ActivateCustomHostname: {
    id: "v1ActivateCustomHostname",
    description: "[Beta] Activates a custom hostname for a project.",
    method: "POST",
    path: "/v1/projects/{ref}/custom-hostname/activate",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ActivateCustomHostnameInput,
    outputSchema: V1ActivateCustomHostnameOutput,
  },
  v1ActivateVanitySubdomainConfig: {
    id: "v1ActivateVanitySubdomainConfig",
    description: "[Beta] Activates a vanity subdomain for a project.",
    method: "POST",
    path: "/v1/projects/{ref}/vanity-subdomain/activate",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["vanity_subdomain"] },
    response: { kind: "json" },
    inputSchema: V1ActivateVanitySubdomainConfigInput,
    outputSchema: V1ActivateVanitySubdomainConfigOutput,
  },
  v1ApplyAMigration: {
    id: "v1ApplyAMigration",
    description: "Only available to selected partner OAuth apps",
    method: "POST",
    path: "/v1/projects/{ref}/database/migrations",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: ["Idempotency-Key"],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["query", "name", "rollback"],
    },
    response: { kind: "void" },
    inputSchema: V1ApplyAMigrationInput,
    outputSchema: V1ApplyAMigrationOutput,
  },
  v1ApplyProjectAddon: {
    id: "v1ApplyProjectAddon",
    description:
      "Selects an addon variant, for example scaling the project’s compute instance up or down, and applies it to the project.",
    method: "PATCH",
    path: "/v1/projects/{ref}/billing/addons",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["addon_variant", "addon_type"],
    },
    response: { kind: "void" },
    inputSchema: V1ApplyProjectAddonInput,
    outputSchema: V1ApplyProjectAddonOutput,
  },
  v1AuthorizeJitAccess: {
    id: "v1AuthorizeJitAccess",
    description: "Authorizes the request to assume a role in the project database",
    method: "POST",
    path: "/v1/projects/{ref}/database/jit",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["role", "rhost"] },
    response: { kind: "json" },
    inputSchema: V1AuthorizeJitAccessInput,
    outputSchema: V1AuthorizeJitAccessOutput,
  },
  v1AuthorizeUser: {
    id: "v1AuthorizeUser",
    description: "[Beta] Authorize user through oauth",
    method: "GET",
    path: "/v1/oauth/authorize",
    pathParams: [],
    queryParams: [
      "client_id",
      "response_type",
      "redirect_uri",
      "scope",
      "state",
      "response_mode",
      "code_challenge",
      "code_challenge_method",
      "organization_slug",
      "target_flow",
      "resource",
    ],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1AuthorizeUserInput,
    outputSchema: V1AuthorizeUserOutput,
  },
  v1BulkCreateSecrets: {
    id: "v1BulkCreateSecrets",
    description: "Creates multiple secrets and adds them to the specified project.",
    method: "POST",
    path: "/v1/projects/{ref}/secrets",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "body", contentType: "application/json", field: "body" },
    response: { kind: "void" },
    inputSchema: V1BulkCreateSecretsInput,
    outputSchema: V1BulkCreateSecretsOutput,
  },
  v1BulkDeleteSecrets: {
    id: "v1BulkDeleteSecrets",
    description: "Deletes all secrets with the given names from the specified project",
    method: "DELETE",
    path: "/v1/projects/{ref}/secrets",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "body", contentType: "application/json", field: "body" },
    response: { kind: "void" },
    inputSchema: V1BulkDeleteSecretsInput,
    outputSchema: V1BulkDeleteSecretsOutput,
  },
  v1BulkUpdateFunctions: {
    id: "v1BulkUpdateFunctions",
    description:
      "Bulk update functions. It will create a new function or replace existing. The operation is idempotent. NOTE: You will need to manually bump the version.",
    method: "PUT",
    path: "/v1/projects/{ref}/functions",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "body", contentType: "application/json", field: "body" },
    response: { kind: "json" },
    inputSchema: V1BulkUpdateFunctionsInput,
    outputSchema: V1BulkUpdateFunctionsOutput,
  },
  v1CancelAProjectRestoration: {
    id: "v1CancelAProjectRestoration",
    description: "Cancels the given project restoration",
    method: "POST",
    path: "/v1/projects/{ref}/restore/cancel",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1CancelAProjectRestorationInput,
    outputSchema: V1CancelAProjectRestorationOutput,
  },
  v1CheckVanitySubdomainAvailability: {
    id: "v1CheckVanitySubdomainAvailability",
    description: "[Beta] Checks vanity subdomain availability",
    method: "POST",
    path: "/v1/projects/{ref}/vanity-subdomain/check-availability",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["vanity_subdomain"] },
    response: { kind: "json" },
    inputSchema: V1CheckVanitySubdomainAvailabilityInput,
    outputSchema: V1CheckVanitySubdomainAvailabilityOutput,
  },
  v1ClaimProjectForOrganization: {
    id: "v1ClaimProjectForOrganization",
    description: "Claims project for the specified organization",
    method: "POST",
    path: "/v1/organizations/{slug}/project-claim/{token}",
    pathParams: ["slug", "token"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1ClaimProjectForOrganizationInput,
    outputSchema: V1ClaimProjectForOrganizationOutput,
  },
  v1CountActionRuns: {
    id: "v1CountActionRuns",
    description: "Returns the total number of action runs of the specified project.",
    method: "HEAD",
    path: "/v1/projects/{ref}/actions",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1CountActionRunsInput,
    outputSchema: V1CountActionRunsOutput,
  },
  v1CreateABranch: {
    id: "v1CreateABranch",
    description: "Creates a database branch from the specified project.",
    method: "POST",
    path: "/v1/projects/{ref}/branches",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: [
        "branch_name",
        "git_branch",
        "is_default",
        "persistent",
        "region",
        "desired_instance_size",
        "release_channel",
        "postgres_engine",
        "secrets",
        "with_data",
        "notify_url",
      ],
    },
    response: { kind: "json" },
    inputSchema: V1CreateABranchInput,
    outputSchema: V1CreateABranchOutput,
  },
  v1CreateAFunction: {
    id: "v1CreateAFunction",
    description:
      "This endpoint is deprecated - use the deploy endpoint. Creates a function and adds it to the specified project.",
    method: "POST",
    path: "/v1/projects/{ref}/functions",
    pathParams: ["ref"],
    queryParams: [
      "slug",
      "name",
      "verify_jwt",
      "import_map",
      "entrypoint_path",
      "import_map_path",
      "ezbr_sha256",
    ],
    headerParams: [],
    requestBody: { kind: "body", contentType: "application/vnd.denoland.eszip", field: "body" },
    response: { kind: "json" },
    inputSchema: V1CreateAFunctionInput,
    outputSchema: V1CreateAFunctionOutput,
  },
  v1CreateAProject: {
    id: "v1CreateAProject",
    description: "Create a project",
    method: "POST",
    path: "/v1/projects",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: [
        "db_pass",
        "name",
        "organization_id",
        "organization_slug",
        "plan",
        "region",
        "region_selection",
        "kps_enabled",
        "desired_instance_size",
        "template_url",
        "high_availability",
      ],
    },
    response: { kind: "json" },
    inputSchema: V1CreateAProjectInput,
    outputSchema: V1CreateAProjectOutput,
  },
  v1CreateASsoProvider: {
    id: "v1CreateASsoProvider",
    description: "Creates a new SSO provider",
    method: "POST",
    path: "/v1/projects/{ref}/config/auth/sso/providers",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: [
        "type",
        "metadata_xml",
        "metadata_url",
        "domains",
        "attribute_mapping",
        "name_id_format",
      ],
    },
    response: { kind: "json" },
    inputSchema: V1CreateASsoProviderInput,
    outputSchema: V1CreateASsoProviderOutput,
  },
  v1CreateAnOrganization: {
    id: "v1CreateAnOrganization",
    description: "Create an organization",
    method: "POST",
    path: "/v1/organizations",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["name"] },
    response: { kind: "json" },
    inputSchema: V1CreateAnOrganizationInput,
    outputSchema: V1CreateAnOrganizationOutput,
  },
  v1CreateLegacySigningKey: {
    id: "v1CreateLegacySigningKey",
    description:
      "Set up the project's existing JWT secret as an in_use JWT signing key. This endpoint will be removed in the future always check for HTTP 404 Not Found.",
    method: "POST",
    path: "/v1/projects/{ref}/config/auth/signing-keys/legacy",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1CreateLegacySigningKeyInput,
    outputSchema: V1CreateLegacySigningKeyOutput,
  },
  v1CreateLoginRole: {
    id: "v1CreateLoginRole",
    description: "[Beta] Create a login role for CLI with temporary password",
    method: "POST",
    path: "/v1/projects/{ref}/cli/login-role",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["read_only"] },
    response: { kind: "json" },
    inputSchema: V1CreateLoginRoleInput,
    outputSchema: V1CreateLoginRoleOutput,
  },
  v1CreateProjectApiKey: {
    id: "v1CreateProjectApiKey",
    description: "Creates a new API key for the project",
    method: "POST",
    path: "/v1/projects/{ref}/api-keys",
    pathParams: ["ref"],
    queryParams: ["reveal"],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["type", "name", "description", "secret_jwt_template"],
    },
    response: { kind: "json" },
    inputSchema: V1CreateProjectApiKeyInput,
    outputSchema: V1CreateProjectApiKeyOutput,
  },
  v1CreateProjectClaimToken: {
    id: "v1CreateProjectClaimToken",
    description: "Creates project claim token",
    method: "POST",
    path: "/v1/projects/{ref}/claim-token",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1CreateProjectClaimTokenInput,
    outputSchema: V1CreateProjectClaimTokenOutput,
  },
  v1CreateProjectSigningKey: {
    id: "v1CreateProjectSigningKey",
    description: "Create a new signing key for the project in standby status",
    method: "POST",
    path: "/v1/projects/{ref}/config/auth/signing-keys",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["algorithm", "status", "private_jwk"],
    },
    response: { kind: "json" },
    inputSchema: V1CreateProjectSigningKeyInput,
    outputSchema: V1CreateProjectSigningKeyOutput,
  },
  v1CreateProjectTpaIntegration: {
    id: "v1CreateProjectTpaIntegration",
    description: "Creates a new third-party auth integration",
    method: "POST",
    path: "/v1/projects/{ref}/config/auth/third-party-auth",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["oidc_issuer_url", "jwks_url", "custom_jwks"],
    },
    response: { kind: "json" },
    inputSchema: V1CreateProjectTpaIntegrationInput,
    outputSchema: V1CreateProjectTpaIntegrationOutput,
  },
  v1CreateRestorePoint: {
    id: "v1CreateRestorePoint",
    description: "Initiates a creation of a restore point for a database",
    method: "POST",
    path: "/v1/projects/{ref}/database/backups/restore-point",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["name"] },
    response: { kind: "json" },
    inputSchema: V1CreateRestorePointInput,
    outputSchema: V1CreateRestorePointOutput,
  },
  v1DeactivateVanitySubdomainConfig: {
    id: "v1DeactivateVanitySubdomainConfig",
    description: "[Beta] Deletes a project's vanity subdomain configuration",
    method: "DELETE",
    path: "/v1/projects/{ref}/vanity-subdomain",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1DeactivateVanitySubdomainConfigInput,
    outputSchema: V1DeactivateVanitySubdomainConfigOutput,
  },
  v1DeleteHostnameConfig: {
    id: "v1DeleteHostnameConfig",
    description: "[Beta] Deletes a project's custom hostname configuration",
    method: "DELETE",
    path: "/v1/projects/{ref}/custom-hostname",
    pathParams: ["ref"],
    queryParams: ["remove_addon"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1DeleteHostnameConfigInput,
    outputSchema: V1DeleteHostnameConfigOutput,
  },
  v1DeleteABranch: {
    id: "v1DeleteABranch",
    description:
      "Deletes the specified database branch. By default, deletes immediately. Use force=false to schedule deletion with 1-hour grace period (only when soft deletion is enabled).",
    method: "DELETE",
    path: "/v1/branches/{branch_id_or_ref}",
    pathParams: ["branch_id_or_ref"],
    queryParams: ["force"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1DeleteABranchInput,
    outputSchema: V1DeleteABranchOutput,
  },
  v1DeleteAFunction: {
    id: "v1DeleteAFunction",
    description: "Deletes a function with the specified slug from the specified project.",
    method: "DELETE",
    path: "/v1/projects/{ref}/functions/{function_slug}",
    pathParams: ["ref", "function_slug"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1DeleteAFunctionInput,
    outputSchema: V1DeleteAFunctionOutput,
  },
  v1DeleteAProject: {
    id: "v1DeleteAProject",
    description: "Deletes the given project",
    method: "DELETE",
    path: "/v1/projects/{ref}",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1DeleteAProjectInput,
    outputSchema: V1DeleteAProjectOutput,
  },
  v1DeleteASsoProvider: {
    id: "v1DeleteASsoProvider",
    description: "Removes a SSO provider by its UUID",
    method: "DELETE",
    path: "/v1/projects/{ref}/config/auth/sso/providers/{provider_id}",
    pathParams: ["ref", "provider_id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1DeleteASsoProviderInput,
    outputSchema: V1DeleteASsoProviderOutput,
  },
  v1DeleteInviteExternalJitAccess: {
    id: "v1DeleteInviteExternalJitAccess",
    description: "Revokes and deletes the invitation",
    method: "DELETE",
    path: "/v1/projects/{ref}/database/jit/invite/{invite_id}",
    pathParams: ["ref", "invite_id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1DeleteInviteExternalJitAccessInput,
    outputSchema: V1DeleteInviteExternalJitAccessOutput,
  },
  v1DeleteJitAccess: {
    id: "v1DeleteJitAccess",
    description: "Remove JIT mappings of a user, revoking all JIT database access",
    method: "DELETE",
    path: "/v1/projects/{ref}/database/jit/{user_id}",
    pathParams: ["ref", "user_id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1DeleteJitAccessInput,
    outputSchema: V1DeleteJitAccessOutput,
  },
  v1DeleteLoginRoles: {
    id: "v1DeleteLoginRoles",
    description: "[Beta] Delete existing login roles used by CLI",
    method: "DELETE",
    path: "/v1/projects/{ref}/cli/login-role",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1DeleteLoginRolesInput,
    outputSchema: V1DeleteLoginRolesOutput,
  },
  v1DeleteNetworkBans: {
    id: "v1DeleteNetworkBans",
    description: "[Beta] Remove network bans.",
    method: "DELETE",
    path: "/v1/projects/{ref}/network-bans",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["ipv4_addresses", "requester_ip", "identifier"],
    },
    response: { kind: "void" },
    inputSchema: V1DeleteNetworkBansInput,
    outputSchema: V1DeleteNetworkBansOutput,
  },
  v1DeleteProjectApiKey: {
    id: "v1DeleteProjectApiKey",
    description: "Deletes an API key for the project",
    method: "DELETE",
    path: "/v1/projects/{ref}/api-keys/{id}",
    pathParams: ["ref", "id"],
    queryParams: ["reveal", "was_compromised", "reason"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1DeleteProjectApiKeyInput,
    outputSchema: V1DeleteProjectApiKeyOutput,
  },
  v1DeleteProjectClaimToken: {
    id: "v1DeleteProjectClaimToken",
    description: "Revokes project claim token",
    method: "DELETE",
    path: "/v1/projects/{ref}/claim-token",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1DeleteProjectClaimTokenInput,
    outputSchema: V1DeleteProjectClaimTokenOutput,
  },
  v1DeleteProjectTpaIntegration: {
    id: "v1DeleteProjectTpaIntegration",
    description: "Removes a third-party auth integration",
    method: "DELETE",
    path: "/v1/projects/{ref}/config/auth/third-party-auth/{tpa_id}",
    pathParams: ["ref", "tpa_id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1DeleteProjectTpaIntegrationInput,
    outputSchema: V1DeleteProjectTpaIntegrationOutput,
  },
  v1DeployAFunction: {
    id: "v1DeployAFunction",
    description: "A new endpoint to deploy functions. It will create if function does not exist.",
    method: "POST",
    path: "/v1/projects/{ref}/functions/deploy",
    pathParams: ["ref"],
    queryParams: ["slug", "bundleOnly"],
    headerParams: [],
    requestBody: { kind: "body", contentType: "multipart/form-data", field: "body" },
    response: { kind: "json" },
    inputSchema: V1DeployAFunctionInput,
    outputSchema: V1DeployAFunctionOutput,
  },
  v1DiffABranch: {
    id: "v1DiffABranch",
    description: "Diffs the specified database branch",
    method: "GET",
    path: "/v1/branches/{branch_id_or_ref}/diff",
    pathParams: ["branch_id_or_ref"],
    queryParams: ["included_schemas", "pgdelta"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "text" },
    inputSchema: V1DiffABranchInput,
    outputSchema: V1DiffABranchOutput,
  },
  v1DisablePreviewBranching: {
    id: "v1DisablePreviewBranching",
    description: "Disables preview branching for the specified project",
    method: "DELETE",
    path: "/v1/projects/{ref}/branches",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1DisablePreviewBranchingInput,
    outputSchema: V1DisablePreviewBranchingOutput,
  },
  v1DisableReadonlyModeTemporarily: {
    id: "v1DisableReadonlyModeTemporarily",
    description: "Disables project's readonly mode for the next 15 minutes",
    method: "POST",
    path: "/v1/projects/{ref}/readonly/temporary-disable",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1DisableReadonlyModeTemporarilyInput,
    outputSchema: V1DisableReadonlyModeTemporarilyOutput,
  },
  v1EnableDatabaseWebhook: {
    id: "v1EnableDatabaseWebhook",
    description: "[Beta] Enables Database Webhooks on the project",
    method: "POST",
    path: "/v1/projects/{ref}/database/webhooks/enable",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1EnableDatabaseWebhookInput,
    outputSchema: V1EnableDatabaseWebhookOutput,
  },
  v1ExchangeOauthToken: {
    id: "v1ExchangeOauthToken",
    description:
      "Supports `authorization_code`, `refresh_token`, and `urn:ietf:params:oauth:grant-type:jwt-bearer` grant types. The `jwt-bearer` grant type (IDJAG — identity-directed JWT assertion) is in beta and available on Team and Enterprise plans only.",
    method: "POST",
    path: "/v1/oauth/token",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "body", contentType: "application/x-www-form-urlencoded", field: "body" },
    response: { kind: "json" },
    inputSchema: V1ExchangeOauthTokenInput,
    outputSchema: V1ExchangeOauthTokenOutput,
  },
  v1GenerateTypescriptTypes: {
    id: "v1GenerateTypescriptTypes",
    description: "Returns the TypeScript types of your schema for use with supabase-js.",
    method: "GET",
    path: "/v1/projects/{ref}/types/typescript",
    pathParams: ["ref"],
    queryParams: ["included_schemas"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GenerateTypescriptTypesInput,
    outputSchema: V1GenerateTypescriptTypesOutput,
  },
  v1GetABranch: {
    id: "v1GetABranch",
    description: "Fetches the specified database branch by its name.",
    method: "GET",
    path: "/v1/projects/{ref}/branches/{name}",
    pathParams: ["ref", "name"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetABranchInput,
    outputSchema: V1GetABranchOutput,
  },
  v1GetABranchConfig: {
    id: "v1GetABranchConfig",
    description: "Fetches configurations of the specified database branch",
    method: "GET",
    path: "/v1/branches/{branch_id_or_ref}",
    pathParams: ["branch_id_or_ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetABranchConfigInput,
    outputSchema: V1GetABranchConfigOutput,
  },
  v1GetAFunction: {
    id: "v1GetAFunction",
    description: "Retrieves a function with the specified slug and project.",
    method: "GET",
    path: "/v1/projects/{ref}/functions/{function_slug}",
    pathParams: ["ref", "function_slug"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetAFunctionInput,
    outputSchema: V1GetAFunctionOutput,
  },
  v1GetAFunctionBody: {
    id: "v1GetAFunctionBody",
    description: "Retrieves a function body for the specified slug and project.",
    method: "GET",
    path: "/v1/projects/{ref}/functions/{function_slug}/body",
    pathParams: ["ref", "function_slug"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetAFunctionBodyInput,
    outputSchema: V1GetAFunctionBodyOutput,
  },
  v1GetAMigration: {
    id: "v1GetAMigration",
    description: "Only available to selected partner OAuth apps",
    method: "GET",
    path: "/v1/projects/{ref}/database/migrations/{version}",
    pathParams: ["ref", "version"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetAMigrationInput,
    outputSchema: V1GetAMigrationOutput,
  },
  v1GetASnippet: {
    id: "v1GetASnippet",
    description: "Gets a specific SQL snippet",
    method: "GET",
    path: "/v1/snippets/{id}",
    pathParams: ["id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetASnippetInput,
    outputSchema: V1GetASnippetOutput,
  },
  v1GetASsoProvider: {
    id: "v1GetASsoProvider",
    description: "Gets a SSO provider by its UUID",
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/sso/providers/{provider_id}",
    pathParams: ["ref", "provider_id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetASsoProviderInput,
    outputSchema: V1GetASsoProviderOutput,
  },
  v1GetActionRun: {
    id: "v1GetActionRun",
    description: "Returns the current status of the specified action run.",
    method: "GET",
    path: "/v1/projects/{ref}/actions/{run_id}",
    pathParams: ["ref", "run_id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetActionRunInput,
    outputSchema: V1GetActionRunOutput,
  },
  v1GetActionRunLogs: {
    id: "v1GetActionRunLogs",
    description: "Returns the logs from the specified action run.",
    method: "GET",
    path: "/v1/projects/{ref}/actions/{run_id}/logs",
    pathParams: ["ref", "run_id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "text" },
    inputSchema: V1GetActionRunLogsInput,
    outputSchema: V1GetActionRunLogsOutput,
  },
  v1GetAllProjectsForOrganization: {
    id: "v1GetAllProjectsForOrganization",
    description:
      "Returns a paginated list of projects for the specified organization.\n\nThis endpoint uses offset-based pagination. Use the `offset` parameter to skip a number of projects and the `limit` parameter to control the number of projects returned per page.",
    method: "GET",
    path: "/v1/organizations/{slug}/projects",
    pathParams: ["slug"],
    queryParams: ["offset", "limit", "search", "sort", "statuses"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetAllProjectsForOrganizationInput,
    outputSchema: V1GetAllProjectsForOrganizationOutput,
  },
  v1GetAnOrganization: {
    id: "v1GetAnOrganization",
    description: "Gets information about the organization",
    method: "GET",
    path: "/v1/organizations/{slug}",
    pathParams: ["slug"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetAnOrganizationInput,
    outputSchema: V1GetAnOrganizationOutput,
  },
  v1GetAuthServiceConfig: {
    id: "v1GetAuthServiceConfig",
    description: "Gets project's auth config",
    method: "GET",
    path: "/v1/projects/{ref}/config/auth",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetAuthServiceConfigInput,
    outputSchema: V1GetAuthServiceConfigOutput,
  },
  v1GetAvailableRegions: {
    id: "v1GetAvailableRegions",
    description: "[Beta] Gets the list of available regions that can be used for a new project",
    method: "GET",
    path: "/v1/projects/available-regions",
    pathParams: [],
    queryParams: ["organization_slug", "continent", "desired_instance_size"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetAvailableRegionsInput,
    outputSchema: V1GetAvailableRegionsOutput,
  },
  v1GetBackupSchedule: {
    id: "v1GetBackupSchedule",
    description: "Gets the backup schedule for a project",
    method: "GET",
    path: "/v1/projects/{ref}/database/backups/schedule",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetBackupScheduleInput,
    outputSchema: V1GetBackupScheduleOutput,
  },
  v1GetDatabaseDisk: {
    id: "v1GetDatabaseDisk",
    description: "Get database disk attributes",
    method: "GET",
    path: "/v1/projects/{ref}/config/disk",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetDatabaseDiskInput,
    outputSchema: V1GetDatabaseDiskOutput,
  },
  v1GetDatabaseMetadata: {
    id: "v1GetDatabaseMetadata",
    description:
      "This is an **experimental** endpoint. It is subject to change or removal in future versions. Use it with caution, as it may not remain supported or stable.",
    method: "GET",
    path: "/v1/projects/{ref}/database/context",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetDatabaseMetadataInput,
    outputSchema: V1GetDatabaseMetadataOutput,
  },
  v1GetDatabaseOpenapi: {
    id: "v1GetDatabaseOpenapi",
    description:
      "Returns the PostgREST OpenAPI specification for the project. This is the replacement for querying `/rest/v1/` directly with the anon key.",
    method: "GET",
    path: "/v1/projects/{ref}/database/openapi",
    pathParams: ["ref"],
    queryParams: ["schema"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetDatabaseOpenapiInput,
    outputSchema: V1GetDatabaseOpenapiOutput,
  },
  v1GetDiskUtilization: {
    id: "v1GetDiskUtilization",
    description: "Get disk utilization",
    method: "GET",
    path: "/v1/projects/{ref}/config/disk/util",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetDiskUtilizationInput,
    outputSchema: V1GetDiskUtilizationOutput,
  },
  v1GetHostnameConfig: {
    id: "v1GetHostnameConfig",
    description: "[Beta] Gets project's custom hostname config",
    method: "GET",
    path: "/v1/projects/{ref}/custom-hostname",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetHostnameConfigInput,
    outputSchema: V1GetHostnameConfigOutput,
  },
  v1GetJitAccess: {
    id: "v1GetJitAccess",
    description: "Mappings of roles a user can assume in the project database",
    method: "GET",
    path: "/v1/projects/{ref}/database/jit",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetJitAccessInput,
    outputSchema: V1GetJitAccessOutput,
  },
  v1GetJitAccessConfig: {
    id: "v1GetJitAccessConfig",
    description: "[Beta] Get project's temporary access configuration.",
    method: "GET",
    path: "/v1/projects/{ref}/jit-access",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetJitAccessConfigInput,
    outputSchema: V1GetJitAccessConfigOutput,
  },
  v1GetLegacySigningKey: {
    id: "v1GetLegacySigningKey",
    description:
      "Get the signing key information for the JWT secret imported as signing key for this project. This endpoint will be removed in the future, check for HTTP 404 Not Found.",
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/signing-keys/legacy",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetLegacySigningKeyInput,
    outputSchema: V1GetLegacySigningKeyOutput,
  },
  v1GetNetworkRestrictions: {
    id: "v1GetNetworkRestrictions",
    description: "[Beta] Gets project's network restrictions",
    method: "GET",
    path: "/v1/projects/{ref}/network-restrictions",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetNetworkRestrictionsInput,
    outputSchema: V1GetNetworkRestrictionsOutput,
  },
  v1GetOrganizationEntitlements: {
    id: "v1GetOrganizationEntitlements",
    description:
      "Returns the entitlements available to the organization based on their plan and any overrides.",
    method: "GET",
    path: "/v1/organizations/{slug}/entitlements",
    pathParams: ["slug"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetOrganizationEntitlementsInput,
    outputSchema: V1GetOrganizationEntitlementsOutput,
  },
  v1GetOrganizationProjectClaim: {
    id: "v1GetOrganizationProjectClaim",
    description: "Gets project details for the specified organization and claim token",
    method: "GET",
    path: "/v1/organizations/{slug}/project-claim/{token}",
    pathParams: ["slug", "token"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetOrganizationProjectClaimInput,
    outputSchema: V1GetOrganizationProjectClaimOutput,
  },
  v1GetPerformanceAdvisors: {
    id: "v1GetPerformanceAdvisors",
    description:
      "This is an **experimental** endpoint. It is subject to change or removal in future versions. Use it with caution, as it may not remain supported or stable.",
    method: "GET",
    path: "/v1/projects/{ref}/advisors/performance",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetPerformanceAdvisorsInput,
    outputSchema: V1GetPerformanceAdvisorsOutput,
  },
  v1GetPgsodiumConfig: {
    id: "v1GetPgsodiumConfig",
    description: "[Beta] Gets project's pgsodium config",
    method: "GET",
    path: "/v1/projects/{ref}/pgsodium",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetPgsodiumConfigInput,
    outputSchema: V1GetPgsodiumConfigOutput,
  },
  v1GetPoolerConfig: {
    id: "v1GetPoolerConfig",
    description: "Gets project's supavisor config",
    method: "GET",
    path: "/v1/projects/{ref}/config/database/pooler",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetPoolerConfigInput,
    outputSchema: V1GetPoolerConfigOutput,
  },
  v1GetPostgresConfig: {
    id: "v1GetPostgresConfig",
    description: "Gets project's Postgres config",
    method: "GET",
    path: "/v1/projects/{ref}/config/database/postgres",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetPostgresConfigInput,
    outputSchema: V1GetPostgresConfigOutput,
  },
  v1GetPostgresUpgradeEligibility: {
    id: "v1GetPostgresUpgradeEligibility",
    description: "[Beta] Returns the project's eligibility for upgrades",
    method: "GET",
    path: "/v1/projects/{ref}/upgrade/eligibility",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetPostgresUpgradeEligibilityInput,
    outputSchema: V1GetPostgresUpgradeEligibilityOutput,
  },
  v1GetPostgresUpgradeStatus: {
    id: "v1GetPostgresUpgradeStatus",
    description: "[Beta] Gets the latest status of the project's upgrade",
    method: "GET",
    path: "/v1/projects/{ref}/upgrade/status",
    pathParams: ["ref"],
    queryParams: ["tracking_id"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetPostgresUpgradeStatusInput,
    outputSchema: V1GetPostgresUpgradeStatusOutput,
  },
  v1GetPostgrestServiceConfig: {
    id: "v1GetPostgrestServiceConfig",
    description: "Gets project's postgrest config",
    method: "GET",
    path: "/v1/projects/{ref}/postgrest",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetPostgrestServiceConfigInput,
    outputSchema: V1GetPostgrestServiceConfigOutput,
  },
  v1GetProfile: {
    id: "v1GetProfile",
    description: "Gets the user's profile",
    method: "GET",
    path: "/v1/profile",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProfileInput,
    outputSchema: V1GetProfileOutput,
  },
  v1GetProject: {
    id: "v1GetProject",
    description: "Gets a specific project that belongs to the authenticated user",
    method: "GET",
    path: "/v1/projects/{ref}",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectInput,
    outputSchema: V1GetProjectOutput,
  },
  v1GetProjectApiKey: {
    id: "v1GetProjectApiKey",
    description: "Get API key",
    method: "GET",
    path: "/v1/projects/{ref}/api-keys/{id}",
    pathParams: ["ref", "id"],
    queryParams: ["reveal"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectApiKeyInput,
    outputSchema: V1GetProjectApiKeyOutput,
  },
  v1GetProjectApiKeys: {
    id: "v1GetProjectApiKeys",
    description: "Get project api keys",
    method: "GET",
    path: "/v1/projects/{ref}/api-keys",
    pathParams: ["ref"],
    queryParams: ["reveal"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectApiKeysInput,
    outputSchema: V1GetProjectApiKeysOutput,
  },
  v1GetProjectClaimToken: {
    id: "v1GetProjectClaimToken",
    description: "Gets project claim token",
    method: "GET",
    path: "/v1/projects/{ref}/claim-token",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectClaimTokenInput,
    outputSchema: V1GetProjectClaimTokenOutput,
  },
  v1GetProjectDiskAutoscaleConfig: {
    id: "v1GetProjectDiskAutoscaleConfig",
    description: "Gets project disk autoscale config",
    method: "GET",
    path: "/v1/projects/{ref}/config/disk/autoscale",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectDiskAutoscaleConfigInput,
    outputSchema: V1GetProjectDiskAutoscaleConfigOutput,
  },
  v1GetProjectFunctionCombinedStats: {
    id: "v1GetProjectFunctionCombinedStats",
    description: "Gets a project's function combined statistics",
    method: "GET",
    path: "/v1/projects/{ref}/analytics/endpoints/functions.combined-stats",
    pathParams: ["ref"],
    queryParams: ["interval", "function_id"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectFunctionCombinedStatsInput,
    outputSchema: V1GetProjectFunctionCombinedStatsOutput,
  },
  v1GetProjectLegacyApiKeys: {
    id: "v1GetProjectLegacyApiKeys",
    description:
      "Check whether JWT based legacy (anon, service_role) API keys are enabled. This API endpoint will be removed in the future, check for HTTP 404 Not Found.",
    method: "GET",
    path: "/v1/projects/{ref}/api-keys/legacy",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectLegacyApiKeysInput,
    outputSchema: V1GetProjectLegacyApiKeysOutput,
  },
  v1GetProjectLogs: {
    id: "v1GetProjectLogs",
    description:
      "Executes an SQL or LQL query on the project's unified logs stream.\n\nEither the `iso_timestamp_start` and `iso_timestamp_end` parameters must be provided.\nIf both are not provided, only the last 1 minute of logs will be queried.\nThe timestamp range must be no more than 24 hours and is rounded to the nearest minute. If the range is more than 24 hours, a validation error will be thrown.\n\nFilter by the `source` column to specify specific log sources, such as edge_logs, postgres_logs, etc.\n\nNote: SQL must be written in **ClickHouse SQL dialect**.",
    method: "GET",
    path: "/v1/projects/{ref}/analytics/endpoints/logs",
    pathParams: ["ref"],
    queryParams: ["sql", "iso_timestamp_start", "iso_timestamp_end"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectLogsInput,
    outputSchema: V1GetProjectLogsOutput,
  },
  v1GetProjectLogsAll: {
    id: "v1GetProjectLogsAll",
    description:
      "Executes a SQL query on the project's logs.\n\nEither the `iso_timestamp_start` and `iso_timestamp_end` parameters must be provided.\nIf both are not provided, only the last 1 minute of logs will be queried.\nThe timestamp range must be no more than 24 hours and is rounded to the nearest minute. If the range is more than 24 hours, a validation error will be thrown.\n\nNote: Unless the `sql` parameter is provided, only edge_logs will be queried. See the [log query docs](/docs/guides/telemetry/logs?queryGroups=product&product=postgres&queryGroups=source&source=edge_logs#querying-with-the-logs-explorer:~:text=logs%20from%20the-,Sources,-drop%2Ddown%3A) for all available sources.",
    method: "GET",
    path: "/v1/projects/{ref}/analytics/endpoints/logs.all",
    pathParams: ["ref"],
    queryParams: ["sql", "iso_timestamp_start", "iso_timestamp_end"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectLogsAllInput,
    outputSchema: V1GetProjectLogsAllOutput,
  },
  v1GetProjectPgbouncerConfig: {
    id: "v1GetProjectPgbouncerConfig",
    description: "Get project's pgbouncer config",
    method: "GET",
    path: "/v1/projects/{ref}/config/database/pgbouncer",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectPgbouncerConfigInput,
    outputSchema: V1GetProjectPgbouncerConfigOutput,
  },
  v1GetProjectSigningKey: {
    id: "v1GetProjectSigningKey",
    description: "Get information about a signing key",
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/signing-keys/{id}",
    pathParams: ["id", "ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectSigningKeyInput,
    outputSchema: V1GetProjectSigningKeyOutput,
  },
  v1GetProjectSigningKeys: {
    id: "v1GetProjectSigningKeys",
    description: "List all signing keys for the project",
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/signing-keys",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectSigningKeysInput,
    outputSchema: V1GetProjectSigningKeysOutput,
  },
  v1GetProjectTpaIntegration: {
    id: "v1GetProjectTpaIntegration",
    description: "Get a third-party integration",
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/third-party-auth/{tpa_id}",
    pathParams: ["ref", "tpa_id"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectTpaIntegrationInput,
    outputSchema: V1GetProjectTpaIntegrationOutput,
  },
  v1GetProjectUsageApiCount: {
    id: "v1GetProjectUsageApiCount",
    description: "Gets project's usage api counts",
    method: "GET",
    path: "/v1/projects/{ref}/analytics/endpoints/usage.api-counts",
    pathParams: ["ref"],
    queryParams: ["interval"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectUsageApiCountInput,
    outputSchema: V1GetProjectUsageApiCountOutput,
  },
  v1GetProjectUsageRequestCount: {
    id: "v1GetProjectUsageRequestCount",
    description: "Gets project's usage api requests count",
    method: "GET",
    path: "/v1/projects/{ref}/analytics/endpoints/usage.api-requests-count",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetProjectUsageRequestCountInput,
    outputSchema: V1GetProjectUsageRequestCountOutput,
  },
  v1GetReadonlyModeStatus: {
    id: "v1GetReadonlyModeStatus",
    description: "Returns project's readonly mode status",
    method: "GET",
    path: "/v1/projects/{ref}/readonly",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetReadonlyModeStatusInput,
    outputSchema: V1GetReadonlyModeStatusOutput,
  },
  v1GetRealtimeConfig: {
    id: "v1GetRealtimeConfig",
    description: "Gets realtime configuration",
    method: "GET",
    path: "/v1/projects/{ref}/config/realtime",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetRealtimeConfigInput,
    outputSchema: V1GetRealtimeConfigOutput,
  },
  v1GetRestorePoint: {
    id: "v1GetRestorePoint",
    description: "Get restore points for project",
    method: "GET",
    path: "/v1/projects/{ref}/database/backups/restore-point",
    pathParams: ["ref"],
    queryParams: ["name"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetRestorePointInput,
    outputSchema: V1GetRestorePointOutput,
  },
  v1GetSecurityAdvisors: {
    id: "v1GetSecurityAdvisors",
    description:
      "This is an **experimental** endpoint. It is subject to change or removal in future versions. Use it with caution, as it may not remain supported or stable.",
    method: "GET",
    path: "/v1/projects/{ref}/advisors/security",
    pathParams: ["ref"],
    queryParams: ["lint_type"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetSecurityAdvisorsInput,
    outputSchema: V1GetSecurityAdvisorsOutput,
  },
  v1GetServicesHealth: {
    id: "v1GetServicesHealth",
    description: "Gets project's service health status",
    method: "GET",
    path: "/v1/projects/{ref}/health",
    pathParams: ["ref"],
    queryParams: ["services", "timeout_ms"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetServicesHealthInput,
    outputSchema: V1GetServicesHealthOutput,
  },
  v1GetSslEnforcementConfig: {
    id: "v1GetSslEnforcementConfig",
    description: "[Beta] Get project's SSL enforcement configuration.",
    method: "GET",
    path: "/v1/projects/{ref}/ssl-enforcement",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetSslEnforcementConfigInput,
    outputSchema: V1GetSslEnforcementConfigOutput,
  },
  v1GetStorageConfig: {
    id: "v1GetStorageConfig",
    description: "Gets project's storage config",
    method: "GET",
    path: "/v1/projects/{ref}/config/storage",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetStorageConfigInput,
    outputSchema: V1GetStorageConfigOutput,
  },
  v1GetVanitySubdomainConfig: {
    id: "v1GetVanitySubdomainConfig",
    description: "[Beta] Gets current vanity subdomain config",
    method: "GET",
    path: "/v1/projects/{ref}/vanity-subdomain",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1GetVanitySubdomainConfigInput,
    outputSchema: V1GetVanitySubdomainConfigOutput,
  },
  v1InviteExternalJitAccess: {
    id: "v1InviteExternalJitAccess",
    description:
      "Invites the external user and sets initial roles that can be assumed and for how long",
    method: "POST",
    path: "/v1/projects/{ref}/database/jit/invite",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["email", "roles"] },
    response: { kind: "json" },
    inputSchema: V1InviteExternalJitAccessInput,
    outputSchema: V1InviteExternalJitAccessOutput,
  },
  v1ListActionRuns: {
    id: "v1ListActionRuns",
    description: "Returns a paginated list of action runs of the specified project.",
    method: "GET",
    path: "/v1/projects/{ref}/actions",
    pathParams: ["ref"],
    queryParams: ["offset", "limit"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListActionRunsInput,
    outputSchema: V1ListActionRunsOutput,
  },
  v1ListAllBackups: {
    id: "v1ListAllBackups",
    description: "Lists all backups",
    method: "GET",
    path: "/v1/projects/{ref}/database/backups",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllBackupsInput,
    outputSchema: V1ListAllBackupsOutput,
  },
  v1ListAllBranches: {
    id: "v1ListAllBranches",
    description: "Returns all database branches of the specified project.",
    method: "GET",
    path: "/v1/projects/{ref}/branches",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllBranchesInput,
    outputSchema: V1ListAllBranchesOutput,
  },
  v1ListAllBuckets: {
    id: "v1ListAllBuckets",
    description: "Lists all buckets",
    method: "GET",
    path: "/v1/projects/{ref}/storage/buckets",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllBucketsInput,
    outputSchema: V1ListAllBucketsOutput,
  },
  v1ListAllFunctions: {
    id: "v1ListAllFunctions",
    description: "Returns all functions you've previously added to the specified project.",
    method: "GET",
    path: "/v1/projects/{ref}/functions",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllFunctionsInput,
    outputSchema: V1ListAllFunctionsOutput,
  },
  v1ListAllNetworkBans: {
    id: "v1ListAllNetworkBans",
    description: "[Beta] Gets project's network bans",
    method: "POST",
    path: "/v1/projects/{ref}/network-bans/retrieve",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllNetworkBansInput,
    outputSchema: V1ListAllNetworkBansOutput,
  },
  v1ListAllNetworkBansEnriched: {
    id: "v1ListAllNetworkBansEnriched",
    description:
      "[Beta] Gets project's network bans with additional information about which databases they affect",
    method: "POST",
    path: "/v1/projects/{ref}/network-bans/retrieve/enriched",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllNetworkBansEnrichedInput,
    outputSchema: V1ListAllNetworkBansEnrichedOutput,
  },
  v1ListAllOrganizations: {
    id: "v1ListAllOrganizations",
    description: "Returns a list of organizations that you currently belong to.",
    method: "GET",
    path: "/v1/organizations",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllOrganizationsInput,
    outputSchema: V1ListAllOrganizationsOutput,
  },
  v1ListAllProjects: {
    id: "v1ListAllProjects",
    description: "Returns a list of all projects you've previously created.",
    method: "GET",
    path: "/v1/projects",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllProjectsInput,
    outputSchema: V1ListAllProjectsOutput,
  },
  v1ListAllSecrets: {
    id: "v1ListAllSecrets",
    description: "Returns all secrets you've previously added to the specified project.",
    method: "GET",
    path: "/v1/projects/{ref}/secrets",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllSecretsInput,
    outputSchema: V1ListAllSecretsOutput,
  },
  v1ListAllSnippets: {
    id: "v1ListAllSnippets",
    description: "Lists SQL snippets for the logged in user",
    method: "GET",
    path: "/v1/snippets",
    pathParams: [],
    queryParams: ["project_ref", "cursor", "limit", "sort_by", "sort_order"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllSnippetsInput,
    outputSchema: V1ListAllSnippetsOutput,
  },
  v1ListAllSsoProvider: {
    id: "v1ListAllSsoProvider",
    description: "Lists all SSO providers",
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/sso/providers",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAllSsoProviderInput,
    outputSchema: V1ListAllSsoProviderOutput,
  },
  v1ListAvailableRestoreVersions: {
    id: "v1ListAvailableRestoreVersions",
    description: "Lists available restore versions for the given project",
    method: "GET",
    path: "/v1/projects/{ref}/restore",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListAvailableRestoreVersionsInput,
    outputSchema: V1ListAvailableRestoreVersionsOutput,
  },
  v1ListJitAccess: {
    id: "v1ListJitAccess",
    description: "Mappings of roles a user can assume in the project database",
    method: "GET",
    path: "/v1/projects/{ref}/database/jit/list",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListJitAccessInput,
    outputSchema: V1ListJitAccessOutput,
  },
  v1ListMigrationHistory: {
    id: "v1ListMigrationHistory",
    description: "Only available to selected partner OAuth apps",
    method: "GET",
    path: "/v1/projects/{ref}/database/migrations",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListMigrationHistoryInput,
    outputSchema: V1ListMigrationHistoryOutput,
  },
  v1ListOrganizationMembers: {
    id: "v1ListOrganizationMembers",
    description: "List members of an organization",
    method: "GET",
    path: "/v1/organizations/{slug}/members",
    pathParams: ["slug"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListOrganizationMembersInput,
    outputSchema: V1ListOrganizationMembersOutput,
  },
  v1ListProjectAddons: {
    id: "v1ListProjectAddons",
    description:
      "Returns the billing addons that are currently applied, including the active compute instance size, and lists every addon option that can be provisioned with pricing metadata.",
    method: "GET",
    path: "/v1/projects/{ref}/billing/addons",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListProjectAddonsInput,
    outputSchema: V1ListProjectAddonsOutput,
  },
  v1ListProjectTpaIntegrations: {
    id: "v1ListProjectTpaIntegrations",
    description: "Lists all third-party auth integrations",
    method: "GET",
    path: "/v1/projects/{ref}/config/auth/third-party-auth",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1ListProjectTpaIntegrationsInput,
    outputSchema: V1ListProjectTpaIntegrationsOutput,
  },
  v1MergeABranch: {
    id: "v1MergeABranch",
    description: "Merges the specified database branch",
    method: "POST",
    path: "/v1/branches/{branch_id_or_ref}/merge",
    pathParams: ["branch_id_or_ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["migration_version"] },
    response: { kind: "json" },
    inputSchema: V1MergeABranchInput,
    outputSchema: V1MergeABranchOutput,
  },
  v1ModifyDatabaseDisk: {
    id: "v1ModifyDatabaseDisk",
    description: "Modify database disk",
    method: "POST",
    path: "/v1/projects/{ref}/config/disk",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["attributes"] },
    response: { kind: "void" },
    inputSchema: V1ModifyDatabaseDiskInput,
    outputSchema: V1ModifyDatabaseDiskOutput,
  },
  v1OauthAuthorizeProjectClaim: {
    id: "v1OauthAuthorizeProjectClaim",
    description:
      "Initiates the OAuth authorization flow for the specified provider. After successful authentication, the user can claim ownership of the specified project.",
    method: "GET",
    path: "/v1/oauth/authorize/project-claim",
    pathParams: [],
    queryParams: [
      "project_ref",
      "client_id",
      "response_type",
      "redirect_uri",
      "state",
      "response_mode",
      "code_challenge",
      "code_challenge_method",
    ],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1OauthAuthorizeProjectClaimInput,
    outputSchema: V1OauthAuthorizeProjectClaimOutput,
  },
  v1PatchAMigration: {
    id: "v1PatchAMigration",
    description: "Only available to selected partner OAuth apps",
    method: "PATCH",
    path: "/v1/projects/{ref}/database/migrations/{version}",
    pathParams: ["ref", "version"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["name", "rollback"] },
    response: { kind: "void" },
    inputSchema: V1PatchAMigrationInput,
    outputSchema: V1PatchAMigrationOutput,
  },
  v1PatchNetworkRestrictions: {
    id: "v1PatchNetworkRestrictions",
    description: "[Alpha] Updates project's network restrictions by adding or removing CIDRs",
    method: "PATCH",
    path: "/v1/projects/{ref}/network-restrictions",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["add", "remove"] },
    response: { kind: "json" },
    inputSchema: V1PatchNetworkRestrictionsInput,
    outputSchema: V1PatchNetworkRestrictionsOutput,
  },
  v1PauseAProject: {
    id: "v1PauseAProject",
    description: "Pauses the given project",
    method: "POST",
    path: "/v1/projects/{ref}/pause",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1PauseAProjectInput,
    outputSchema: V1PauseAProjectOutput,
  },
  v1PushABranch: {
    id: "v1PushABranch",
    description: "Pushes the specified database branch",
    method: "POST",
    path: "/v1/branches/{branch_id_or_ref}/push",
    pathParams: ["branch_id_or_ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["migration_version"] },
    response: { kind: "json" },
    inputSchema: V1PushABranchInput,
    outputSchema: V1PushABranchOutput,
  },
  v1ReadOnlyQuery: {
    id: "v1ReadOnlyQuery",
    description: "All entity references must be schema qualified.",
    method: "POST",
    path: "/v1/projects/{ref}/database/query/read-only",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["query", "parameters"] },
    response: { kind: "void" },
    inputSchema: V1ReadOnlyQueryInput,
    outputSchema: V1ReadOnlyQueryOutput,
  },
  v1RemoveAReadReplica: {
    id: "v1RemoveAReadReplica",
    description: "[Beta] Remove a read replica",
    method: "POST",
    path: "/v1/projects/{ref}/read-replicas/remove",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["database_identifier"] },
    response: { kind: "void" },
    inputSchema: V1RemoveAReadReplicaInput,
    outputSchema: V1RemoveAReadReplicaOutput,
  },
  v1RemoveProjectAddon: {
    id: "v1RemoveProjectAddon",
    description:
      "Disables the selected addon variant, including rolling the compute instance back to its previous size.",
    method: "DELETE",
    path: "/v1/projects/{ref}/billing/addons/{addon_variant}",
    pathParams: ["ref", "addon_variant"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1RemoveProjectAddonInput,
    outputSchema: V1RemoveProjectAddonOutput,
  },
  v1RemoveProjectSigningKey: {
    id: "v1RemoveProjectSigningKey",
    description:
      "Remove a signing key from a project. Only possible if the key has been in revoked status for a while.",
    method: "DELETE",
    path: "/v1/projects/{ref}/config/auth/signing-keys/{id}",
    pathParams: ["id", "ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1RemoveProjectSigningKeyInput,
    outputSchema: V1RemoveProjectSigningKeyOutput,
  },
  v1ResetABranch: {
    id: "v1ResetABranch",
    description: "Resets the specified database branch",
    method: "POST",
    path: "/v1/branches/{branch_id_or_ref}/reset",
    pathParams: ["branch_id_or_ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["migration_version"] },
    response: { kind: "json" },
    inputSchema: V1ResetABranchInput,
    outputSchema: V1ResetABranchOutput,
  },
  v1RestartAProject: {
    id: "v1RestartAProject",
    description: "Restarts the given project",
    method: "POST",
    path: "/v1/projects/{ref}/restart",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1RestartAProjectInput,
    outputSchema: V1RestartAProjectOutput,
  },
  v1RestoreABranch: {
    id: "v1RestoreABranch",
    description: "Cancels scheduled deletion and restores the branch to active state",
    method: "POST",
    path: "/v1/branches/{branch_id_or_ref}/restore",
    pathParams: ["branch_id_or_ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1RestoreABranchInput,
    outputSchema: V1RestoreABranchOutput,
  },
  v1RestoreAProject: {
    id: "v1RestoreAProject",
    description: "Restores the given project",
    method: "POST",
    path: "/v1/projects/{ref}/restore",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1RestoreAProjectInput,
    outputSchema: V1RestoreAProjectOutput,
  },
  v1RestorePhysicalBackup: {
    id: "v1RestorePhysicalBackup",
    description: "Restores a physical backup for a database",
    method: "POST",
    path: "/v1/projects/{ref}/database/backups/restore",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["id"] },
    response: { kind: "void" },
    inputSchema: V1RestorePhysicalBackupInput,
    outputSchema: V1RestorePhysicalBackupOutput,
  },
  v1RestorePitrBackup: {
    id: "v1RestorePitrBackup",
    description: "Restores a PITR backup for a database",
    method: "POST",
    path: "/v1/projects/{ref}/database/backups/restore-pitr",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["recovery_time_target_unix"],
    },
    response: { kind: "void" },
    inputSchema: V1RestorePitrBackupInput,
    outputSchema: V1RestorePitrBackupOutput,
  },
  v1RevokeToken: {
    id: "v1RevokeToken",
    description: "[Beta] Revoke oauth app authorization and it's corresponding tokens",
    method: "POST",
    path: "/v1/oauth/revoke",
    pathParams: [],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["client_id", "client_secret", "refresh_token"],
    },
    response: { kind: "void" },
    inputSchema: V1RevokeTokenInput,
    outputSchema: V1RevokeTokenOutput,
  },
  v1RollbackMigrations: {
    id: "v1RollbackMigrations",
    description: "Only available to selected partner OAuth apps",
    method: "DELETE",
    path: "/v1/projects/{ref}/database/migrations",
    pathParams: ["ref"],
    queryParams: ["gte"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1RollbackMigrationsInput,
    outputSchema: V1RollbackMigrationsOutput,
  },
  v1RunAQuery: {
    id: "v1RunAQuery",
    description: "[Beta] Run sql query",
    method: "POST",
    path: "/v1/projects/{ref}/database/query",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["query", "parameters", "read_only"],
    },
    response: { kind: "void" },
    inputSchema: V1RunAQueryInput,
    outputSchema: V1RunAQueryOutput,
  },
  v1SetupAReadReplica: {
    id: "v1SetupAReadReplica",
    description: "[Beta] Set up a read replica",
    method: "POST",
    path: "/v1/projects/{ref}/read-replicas/setup",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["read_replica_region"] },
    response: { kind: "void" },
    inputSchema: V1SetupAReadReplicaInput,
    outputSchema: V1SetupAReadReplicaOutput,
  },
  v1ShutdownRealtime: {
    id: "v1ShutdownRealtime",
    description: "Shutdowns realtime connections for a project",
    method: "POST",
    path: "/v1/projects/{ref}/config/realtime/shutdown",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "void" },
    inputSchema: V1ShutdownRealtimeInput,
    outputSchema: V1ShutdownRealtimeOutput,
  },
  v1Undo: {
    id: "v1Undo",
    description: "Initiates an undo to a given restore point",
    method: "POST",
    path: "/v1/projects/{ref}/database/backups/undo",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["name"] },
    response: { kind: "void" },
    inputSchema: V1UndoInput,
    outputSchema: V1UndoOutput,
  },
  v1UpdateABranchConfig: {
    id: "v1UpdateABranchConfig",
    description: "Updates the configuration of the specified database branch",
    method: "PATCH",
    path: "/v1/branches/{branch_id_or_ref}",
    pathParams: ["branch_id_or_ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: [
        "branch_name",
        "git_branch",
        "reset_on_push",
        "persistent",
        "status",
        "request_review",
        "notify_url",
      ],
    },
    response: { kind: "json" },
    inputSchema: V1UpdateABranchConfigInput,
    outputSchema: V1UpdateABranchConfigOutput,
  },
  v1UpdateAFunction: {
    id: "v1UpdateAFunction",
    description: "Updates a function with the specified slug and project.",
    method: "PATCH",
    path: "/v1/projects/{ref}/functions/{function_slug}",
    pathParams: ["ref", "function_slug"],
    queryParams: [
      "slug",
      "name",
      "verify_jwt",
      "import_map",
      "entrypoint_path",
      "import_map_path",
      "ezbr_sha256",
    ],
    headerParams: [],
    requestBody: { kind: "body", contentType: "application/vnd.denoland.eszip", field: "body" },
    response: { kind: "json" },
    inputSchema: V1UpdateAFunctionInput,
    outputSchema: V1UpdateAFunctionOutput,
  },
  v1UpdateAProject: {
    id: "v1UpdateAProject",
    description: "Updates the given project",
    method: "PATCH",
    path: "/v1/projects/{ref}",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["name"] },
    response: { kind: "json" },
    inputSchema: V1UpdateAProjectInput,
    outputSchema: V1UpdateAProjectOutput,
  },
  v1UpdateASsoProvider: {
    id: "v1UpdateASsoProvider",
    description: "Updates a SSO provider by its UUID",
    method: "PUT",
    path: "/v1/projects/{ref}/config/auth/sso/providers/{provider_id}",
    pathParams: ["ref", "provider_id"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["metadata_xml", "metadata_url", "domains", "attribute_mapping", "name_id_format"],
    },
    response: { kind: "json" },
    inputSchema: V1UpdateASsoProviderInput,
    outputSchema: V1UpdateASsoProviderOutput,
  },
  v1UpdateActionRunStatus: {
    id: "v1UpdateActionRunStatus",
    description: "Updates the status of an ongoing action run.",
    method: "PATCH",
    path: "/v1/projects/{ref}/actions/{run_id}/status",
    pathParams: ["ref", "run_id"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["clone", "pull", "health", "configure", "migrate", "seed", "deploy"],
    },
    response: { kind: "json" },
    inputSchema: V1UpdateActionRunStatusInput,
    outputSchema: V1UpdateActionRunStatusOutput,
  },
  v1UpdateAuthServiceConfig: {
    id: "v1UpdateAuthServiceConfig",
    description: "Updates a project's auth config",
    method: "PATCH",
    path: "/v1/projects/{ref}/config/auth",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: [
        "site_url",
        "disable_signup",
        "jwt_exp",
        "smtp_admin_email",
        "smtp_host",
        "smtp_port",
        "smtp_user",
        "smtp_pass",
        "smtp_max_frequency",
        "smtp_sender_name",
        "mailer_allow_unverified_email_sign_ins",
        "mailer_autoconfirm",
        "mailer_subjects_invite",
        "mailer_subjects_confirmation",
        "mailer_subjects_recovery",
        "mailer_subjects_email_change",
        "mailer_subjects_magic_link",
        "mailer_subjects_reauthentication",
        "mailer_subjects_password_changed_notification",
        "mailer_subjects_email_changed_notification",
        "mailer_subjects_phone_changed_notification",
        "mailer_subjects_mfa_factor_enrolled_notification",
        "mailer_subjects_mfa_factor_unenrolled_notification",
        "mailer_subjects_identity_linked_notification",
        "mailer_subjects_identity_unlinked_notification",
        "mailer_templates_invite_content",
        "mailer_templates_confirmation_content",
        "mailer_templates_recovery_content",
        "mailer_templates_email_change_content",
        "mailer_templates_magic_link_content",
        "mailer_templates_reauthentication_content",
        "mailer_templates_password_changed_notification_content",
        "mailer_templates_email_changed_notification_content",
        "mailer_templates_phone_changed_notification_content",
        "mailer_templates_mfa_factor_enrolled_notification_content",
        "mailer_templates_mfa_factor_unenrolled_notification_content",
        "mailer_templates_identity_linked_notification_content",
        "mailer_templates_identity_unlinked_notification_content",
        "mailer_notifications_password_changed_enabled",
        "mailer_notifications_email_changed_enabled",
        "mailer_notifications_phone_changed_enabled",
        "mailer_notifications_mfa_factor_enrolled_enabled",
        "mailer_notifications_mfa_factor_unenrolled_enabled",
        "mailer_notifications_identity_linked_enabled",
        "mailer_notifications_identity_unlinked_enabled",
        "mfa_max_enrolled_factors",
        "uri_allow_list",
        "external_anonymous_users_enabled",
        "external_email_enabled",
        "external_phone_enabled",
        "saml_enabled",
        "saml_external_url",
        "security_sb_forwarded_for_enabled",
        "security_captcha_enabled",
        "security_captcha_provider",
        "security_captcha_secret",
        "sessions_timebox",
        "sessions_inactivity_timeout",
        "sessions_single_per_user",
        "sessions_tags",
        "rate_limit_anonymous_users",
        "rate_limit_email_sent",
        "rate_limit_sms_sent",
        "rate_limit_verify",
        "rate_limit_token_refresh",
        "rate_limit_otp",
        "rate_limit_web3",
        "mailer_secure_email_change_enabled",
        "refresh_token_rotation_enabled",
        "password_hibp_enabled",
        "password_min_length",
        "password_required_characters",
        "security_manual_linking_enabled",
        "security_update_password_require_reauthentication",
        "security_refresh_token_reuse_interval",
        "mailer_otp_exp",
        "mailer_otp_length",
        "sms_autoconfirm",
        "sms_max_frequency",
        "sms_otp_exp",
        "sms_otp_length",
        "sms_provider",
        "sms_messagebird_access_key",
        "sms_messagebird_originator",
        "sms_test_otp",
        "sms_test_otp_valid_until",
        "sms_textlocal_api_key",
        "sms_textlocal_sender",
        "sms_twilio_account_sid",
        "sms_twilio_auth_token",
        "sms_twilio_content_sid",
        "sms_twilio_message_service_sid",
        "sms_twilio_verify_account_sid",
        "sms_twilio_verify_auth_token",
        "sms_twilio_verify_message_service_sid",
        "sms_vonage_api_key",
        "sms_vonage_api_secret",
        "sms_vonage_from",
        "sms_template",
        "hook_mfa_verification_attempt_enabled",
        "hook_mfa_verification_attempt_uri",
        "hook_mfa_verification_attempt_secrets",
        "hook_password_verification_attempt_enabled",
        "hook_password_verification_attempt_uri",
        "hook_password_verification_attempt_secrets",
        "hook_custom_access_token_enabled",
        "hook_custom_access_token_uri",
        "hook_custom_access_token_secrets",
        "hook_send_sms_enabled",
        "hook_send_sms_uri",
        "hook_send_sms_secrets",
        "hook_send_email_enabled",
        "hook_send_email_uri",
        "hook_send_email_secrets",
        "hook_before_user_created_enabled",
        "hook_before_user_created_uri",
        "hook_before_user_created_secrets",
        "hook_after_user_created_enabled",
        "hook_after_user_created_uri",
        "hook_after_user_created_secrets",
        "external_apple_enabled",
        "external_apple_client_id",
        "external_apple_email_optional",
        "external_apple_secret",
        "external_apple_additional_client_ids",
        "external_azure_enabled",
        "external_azure_client_id",
        "external_azure_email_optional",
        "external_azure_secret",
        "external_azure_url",
        "external_bitbucket_enabled",
        "external_bitbucket_client_id",
        "external_bitbucket_email_optional",
        "external_bitbucket_secret",
        "external_discord_enabled",
        "external_discord_client_id",
        "external_discord_email_optional",
        "external_discord_secret",
        "external_facebook_enabled",
        "external_facebook_client_id",
        "external_facebook_email_optional",
        "external_facebook_secret",
        "external_figma_enabled",
        "external_figma_client_id",
        "external_figma_email_optional",
        "external_figma_secret",
        "external_github_enabled",
        "external_github_client_id",
        "external_github_email_optional",
        "external_github_secret",
        "external_gitlab_enabled",
        "external_gitlab_client_id",
        "external_gitlab_email_optional",
        "external_gitlab_secret",
        "external_gitlab_url",
        "external_google_enabled",
        "external_google_client_id",
        "external_google_email_optional",
        "external_google_secret",
        "external_google_additional_client_ids",
        "external_google_skip_nonce_check",
        "external_kakao_enabled",
        "external_kakao_client_id",
        "external_kakao_email_optional",
        "external_kakao_secret",
        "external_keycloak_enabled",
        "external_keycloak_client_id",
        "external_keycloak_email_optional",
        "external_keycloak_secret",
        "external_keycloak_url",
        "external_linkedin_oidc_enabled",
        "external_linkedin_oidc_client_id",
        "external_linkedin_oidc_email_optional",
        "external_linkedin_oidc_secret",
        "external_slack_oidc_enabled",
        "external_slack_oidc_client_id",
        "external_slack_oidc_email_optional",
        "external_slack_oidc_secret",
        "external_notion_enabled",
        "external_notion_client_id",
        "external_notion_email_optional",
        "external_notion_secret",
        "external_slack_enabled",
        "external_slack_client_id",
        "external_slack_email_optional",
        "external_slack_secret",
        "external_spotify_enabled",
        "external_spotify_client_id",
        "external_spotify_email_optional",
        "external_spotify_secret",
        "external_twitch_enabled",
        "external_twitch_client_id",
        "external_twitch_email_optional",
        "external_twitch_secret",
        "external_twitter_enabled",
        "external_twitter_client_id",
        "external_twitter_email_optional",
        "external_twitter_secret",
        "external_x_enabled",
        "external_x_client_id",
        "external_x_email_optional",
        "external_x_secret",
        "external_workos_enabled",
        "external_workos_client_id",
        "external_workos_secret",
        "external_workos_url",
        "external_web3_solana_enabled",
        "external_web3_ethereum_enabled",
        "external_zoom_enabled",
        "external_zoom_client_id",
        "external_zoom_email_optional",
        "external_zoom_secret",
        "db_max_pool_size",
        "db_max_pool_size_unit",
        "api_max_request_duration",
        "mfa_totp_enroll_enabled",
        "mfa_totp_verify_enabled",
        "mfa_web_authn_enroll_enabled",
        "mfa_web_authn_verify_enabled",
        "passkey_enabled",
        "webauthn_rp_display_name",
        "webauthn_rp_id",
        "webauthn_rp_origins",
        "mfa_phone_enroll_enabled",
        "mfa_phone_verify_enabled",
        "mfa_phone_max_frequency",
        "mfa_phone_otp_length",
        "mfa_phone_template",
        "nimbus_oauth_client_id",
        "nimbus_oauth_client_secret",
        "oauth_server_enabled",
        "oauth_server_allow_dynamic_registration",
        "oauth_server_authorization_path",
        "custom_oauth_enabled",
      ],
    },
    response: { kind: "json" },
    inputSchema: V1UpdateAuthServiceConfigInput,
    outputSchema: V1UpdateAuthServiceConfigOutput,
  },
  v1UpdateBackupSchedule: {
    id: "v1UpdateBackupSchedule",
    description:
      "Sets the time at which the daily backup runs. The change takes effect on the next backup window that includes the new time. If the new time has already passed for today, the first backup at the new time will occur the following day. It can only be updated 3 times per 24 hours.",
    method: "PATCH",
    path: "/v1/projects/{ref}/database/backups/schedule",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["schedule_for"] },
    response: { kind: "json" },
    inputSchema: V1UpdateBackupScheduleInput,
    outputSchema: V1UpdateBackupScheduleOutput,
  },
  v1UpdateDatabasePassword: {
    id: "v1UpdateDatabasePassword",
    description: "Updates the database password",
    method: "PATCH",
    path: "/v1/projects/{ref}/database/password",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["password"] },
    response: { kind: "json" },
    inputSchema: V1UpdateDatabasePasswordInput,
    outputSchema: V1UpdateDatabasePasswordOutput,
  },
  v1UpdateHostnameConfig: {
    id: "v1UpdateHostnameConfig",
    description: "[Beta] Updates project's custom hostname configuration",
    method: "POST",
    path: "/v1/projects/{ref}/custom-hostname/initialize",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["custom_hostname"] },
    response: { kind: "json" },
    inputSchema: V1UpdateHostnameConfigInput,
    outputSchema: V1UpdateHostnameConfigOutput,
  },
  v1UpdateJitAccess: {
    id: "v1UpdateJitAccess",
    description: "Modifies the roles that can be assumed and for how long",
    method: "PUT",
    path: "/v1/projects/{ref}/database/jit",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["user_id", "roles"] },
    response: { kind: "json" },
    inputSchema: V1UpdateJitAccessInput,
    outputSchema: V1UpdateJitAccessOutput,
  },
  v1UpdateJitAccessConfig: {
    id: "v1UpdateJitAccessConfig",
    description: "[Beta] Update project's temporary access configuration.",
    method: "PUT",
    path: "/v1/projects/{ref}/jit-access",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["state"] },
    response: { kind: "json" },
    inputSchema: V1UpdateJitAccessConfigInput,
    outputSchema: V1UpdateJitAccessConfigOutput,
  },
  v1UpdateNetworkRestrictions: {
    id: "v1UpdateNetworkRestrictions",
    description: "[Beta] Updates project's network restrictions",
    method: "POST",
    path: "/v1/projects/{ref}/network-restrictions/apply",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["dbAllowedCidrs", "dbAllowedCidrsV6"],
    },
    response: { kind: "json" },
    inputSchema: V1UpdateNetworkRestrictionsInput,
    outputSchema: V1UpdateNetworkRestrictionsOutput,
  },
  v1UpdatePgsodiumConfig: {
    id: "v1UpdatePgsodiumConfig",
    description:
      "[Beta] Updates project's pgsodium config. Updating the root_key can cause all data encrypted with the older key to become inaccessible.",
    method: "PUT",
    path: "/v1/projects/{ref}/pgsodium",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["root_key"] },
    response: { kind: "json" },
    inputSchema: V1UpdatePgsodiumConfigInput,
    outputSchema: V1UpdatePgsodiumConfigOutput,
  },
  v1UpdatePoolerConfig: {
    id: "v1UpdatePoolerConfig",
    description: "Updates project's supavisor config",
    method: "PATCH",
    path: "/v1/projects/{ref}/config/database/pooler",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["default_pool_size", "pool_mode"],
    },
    response: { kind: "json" },
    inputSchema: V1UpdatePoolerConfigInput,
    outputSchema: V1UpdatePoolerConfigOutput,
  },
  v1UpdatePostgresConfig: {
    id: "v1UpdatePostgresConfig",
    description: "Updates project's Postgres config",
    method: "PUT",
    path: "/v1/projects/{ref}/config/database/postgres",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: [
        "effective_cache_size",
        "logical_decoding_work_mem",
        "cron.log_statement",
        "log_autovacuum_min_duration",
        "log_checkpoints",
        "log_connections",
        "log_disconnections",
        "log_duration",
        "log_lock_waits",
        "log_recovery_conflict_waits",
        "log_replication_commands",
        "log_startup_progress_interval",
        "log_temp_files",
        "maintenance_work_mem",
        "track_activity_query_size",
        "max_connections",
        "max_locks_per_transaction",
        "max_parallel_maintenance_workers",
        "max_parallel_workers",
        "max_parallel_workers_per_gather",
        "max_replication_slots",
        "max_slot_wal_keep_size",
        "max_standby_archive_delay",
        "max_standby_streaming_delay",
        "max_wal_size",
        "max_wal_senders",
        "max_worker_processes",
        "session_replication_role",
        "shared_buffers",
        "statement_timeout",
        "track_commit_timestamp",
        "wal_keep_size",
        "wal_sender_timeout",
        "work_mem",
        "checkpoint_timeout",
        "hot_standby_feedback",
        "restart_database",
      ],
    },
    response: { kind: "json" },
    inputSchema: V1UpdatePostgresConfigInput,
    outputSchema: V1UpdatePostgresConfigOutput,
  },
  v1UpdatePostgrestServiceConfig: {
    id: "v1UpdatePostgrestServiceConfig",
    description: "Updates project's postgrest config",
    method: "PATCH",
    path: "/v1/projects/{ref}/postgrest",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["db_extra_search_path", "db_schema", "max_rows", "db_pool"],
    },
    response: { kind: "json" },
    inputSchema: V1UpdatePostgrestServiceConfigInput,
    outputSchema: V1UpdatePostgrestServiceConfigOutput,
  },
  v1UpdateProjectApiKey: {
    id: "v1UpdateProjectApiKey",
    description: "Updates an API key for the project",
    method: "PATCH",
    path: "/v1/projects/{ref}/api-keys/{id}",
    pathParams: ["ref", "id"],
    queryParams: ["reveal"],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["name", "description", "secret_jwt_template"],
    },
    response: { kind: "json" },
    inputSchema: V1UpdateProjectApiKeyInput,
    outputSchema: V1UpdateProjectApiKeyOutput,
  },
  v1UpdateProjectLegacyApiKeys: {
    id: "v1UpdateProjectLegacyApiKeys",
    description:
      "Disable or re-enable JWT based legacy (anon, service_role) API keys. This API endpoint will be removed in the future, check for HTTP 404 Not Found.",
    method: "PUT",
    path: "/v1/projects/{ref}/api-keys/legacy",
    pathParams: ["ref"],
    queryParams: ["enabled"],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1UpdateProjectLegacyApiKeysInput,
    outputSchema: V1UpdateProjectLegacyApiKeysOutput,
  },
  v1UpdateProjectSigningKey: {
    id: "v1UpdateProjectSigningKey",
    description: "Update a signing key, mainly its status",
    method: "PATCH",
    path: "/v1/projects/{ref}/config/auth/signing-keys/{id}",
    pathParams: ["id", "ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["status"] },
    response: { kind: "json" },
    inputSchema: V1UpdateProjectSigningKeyInput,
    outputSchema: V1UpdateProjectSigningKeyOutput,
  },
  v1UpdateRealtimeConfig: {
    id: "v1UpdateRealtimeConfig",
    description: "Updates realtime configuration",
    method: "PATCH",
    path: "/v1/projects/{ref}/config/realtime",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: [
        "private_only",
        "connection_pool",
        "max_concurrent_users",
        "max_events_per_second",
        "max_bytes_per_second",
        "max_channels_per_client",
        "max_joins_per_second",
        "max_presence_events_per_second",
        "max_payload_size_in_kb",
        "suspend",
        "presence_enabled",
      ],
    },
    response: { kind: "void" },
    inputSchema: V1UpdateRealtimeConfigInput,
    outputSchema: V1UpdateRealtimeConfigOutput,
  },
  v1UpdateSslEnforcementConfig: {
    id: "v1UpdateSslEnforcementConfig",
    description: "[Beta] Update project's SSL enforcement configuration.",
    method: "PUT",
    path: "/v1/projects/{ref}/ssl-enforcement",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "json", contentType: "application/json", fields: ["requestedConfig"] },
    response: { kind: "json" },
    inputSchema: V1UpdateSslEnforcementConfigInput,
    outputSchema: V1UpdateSslEnforcementConfigOutput,
  },
  v1UpdateStorageConfig: {
    id: "v1UpdateStorageConfig",
    description: "Updates project's storage config",
    method: "PATCH",
    path: "/v1/projects/{ref}/config/storage",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["fileSizeLimit", "features", "external"],
    },
    response: { kind: "void" },
    inputSchema: V1UpdateStorageConfigInput,
    outputSchema: V1UpdateStorageConfigOutput,
  },
  v1UpgradePostgresVersion: {
    id: "v1UpgradePostgresVersion",
    description: "[Beta] Upgrades the project's Postgres version",
    method: "POST",
    path: "/v1/projects/{ref}/upgrade",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["target_version", "release_channel"],
    },
    response: { kind: "json" },
    inputSchema: V1UpgradePostgresVersionInput,
    outputSchema: V1UpgradePostgresVersionOutput,
  },
  v1UpsertAMigration: {
    id: "v1UpsertAMigration",
    description: "Only available to selected partner OAuth apps",
    method: "PUT",
    path: "/v1/projects/{ref}/database/migrations",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: ["Idempotency-Key"],
    requestBody: {
      kind: "json",
      contentType: "application/json",
      fields: ["query", "name", "rollback"],
    },
    response: { kind: "void" },
    inputSchema: V1UpsertAMigrationInput,
    outputSchema: V1UpsertAMigrationOutput,
  },
  v1VerifyDnsConfig: {
    id: "v1VerifyDnsConfig",
    description:
      "[Beta] Attempts to verify the DNS configuration for project's custom hostname configuration",
    method: "POST",
    path: "/v1/projects/{ref}/custom-hostname/reverify",
    pathParams: ["ref"],
    queryParams: [],
    headerParams: [],
    requestBody: { kind: "none" },
    response: { kind: "json" },
    inputSchema: V1VerifyDnsConfigInput,
    outputSchema: V1VerifyDnsConfigOutput,
  },
} as const;

export type OpenApiOperationId = keyof typeof openApiOperationIdMap;
export type OperationId = keyof typeof operationDefinitions;
export type OperationDefinition<Id extends OperationId = OperationId> =
  (typeof operationDefinitions)[Id];
export type OperationInput<Id extends OperationId> =
  (typeof operationDefinitions)[Id]["inputSchema"]["Type"];
export type OperationOutput<Id extends OperationId> =
  (typeof operationDefinitions)[Id]["outputSchema"]["Type"];
export type JsonOperationDefinition<Id extends OperationId = OperationId> = Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "json" } }
>;
export type TextOperationDefinition<Id extends OperationId = OperationId> = Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "text" } }
>;
export type VoidOperationDefinition<Id extends OperationId = OperationId> = Extract<
  OperationDefinition<Id>,
  { readonly response: { readonly kind: "void" } }
>;
