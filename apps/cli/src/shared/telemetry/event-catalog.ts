// CLI telemetry catalog. Mirrors apps/cli-go/internal/telemetry/events.go
// 1:1 so legacy/ ports send byte-identical PostHog payloads. When the Go
// catalog changes, update this file in the same PR.

export const EventCommandExecuted = "cli_command_executed";
export const EventProjectLinked = "cli_project_linked";
export const EventLoginCompleted = "cli_login_completed";
export const EventStackStarted = "cli_stack_started";
export const EventUpgradeSuggested = "cli_upgrade_suggested";

export const PropFeatureKey = "feature_key";
export const PropOrgSlug = "org_slug";

export const PropPlatform = "platform";
export const PropSchemaVersion = "schema_version";
export const PropDeviceId = "device_id";
export const PropSessionId = "$session_id";
export const PropIsFirstRun = "is_first_run";
export const PropIsTty = "is_tty";
export const PropIsCi = "is_ci";
export const PropIsAgent = "is_agent";
export const PropOs = "os";
export const PropArch = "arch";
export const PropCliVersion = "cli_version";
export const PropEnvSignals = "env_signals";
export const PropCommandRunId = "command_run_id";
export const PropCommand = "command";
export const PropFlags = "flags";
export const PropExitCode = "exit_code";
export const PropDurationMs = "duration_ms";

export const GroupOrganization = "organization";
export const GroupProject = "project";

export const MaxEnvSignalValueLength = 80;

// Env vars whose presence (any non-empty value) is recorded as `true` in env_signals.
// Order matches apps/cli-go/internal/telemetry/events.go:126-167.
export const EnvSignalPresenceKeys: ReadonlyArray<string> = [
  // AI tools signals
  "CURSOR_AGENT",
  "CURSOR_TRACE_ID",
  "GEMINI_CLI",
  "CODEX_SANDBOX",
  "CODEX_CI",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_AGENT",
  "AUGMENT_AGENT",
  "OPENCODE_CLIENT",
  "CLAUDECODE",
  "CLAUDE_CODE",
  "REPL_ID",
  "COPILOT_MODEL",
  "COPILOT_ALLOW_ALL",
  "COPILOT_GITHUB_TOKEN",
  // CI signals
  "CI",
  "GITHUB_ACTIONS",
  "BUILDKITE",
  "TF_BUILD",
  "JENKINS_URL",
  "GITLAB_CI",
  // Extra signals
  "GITHUB_TOKEN",
  "GITHUB_HEAD_REF",
  "BITBUCKET_CLONE_DIR",
  // Supabase environment signals
  "SUPABASE_ACCESS_TOKEN",
  "SUPABASE_HOME",
  "SYSTEMROOT",
  "SUPABASE_SSL_DEBUG",
  "SUPABASE_CA_SKIP_VERIFY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NPM_CONFIG_REGISTRY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_POSTGRES_URL",
  "SUPABASE_ENV",
];

// Env vars whose trimmed values are recorded in env_signals, capped at
// MaxEnvSignalValueLength chars. Order matches events.go:171-178.
export const EnvSignalValueKeys: ReadonlyArray<string> = [
  "AI_AGENT",
  "CURSOR_EXTENSION_HOST_ROLE",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "TERM_COLOR_MODE",
];
