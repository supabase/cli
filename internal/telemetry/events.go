package telemetry

// CLI telemetry catalog.
//
// This file is the single place to review what analytics events the CLI sends
// and what metadata may be attached to them. Comments live next to the event,
// property, group, or signal definition they describe so the catalog is easy to
// scan without reading the rest of the implementation.
const (
	//   - EventCommandExecuted: sent after a CLI command finishes, whether it
	//     succeeds or fails. This helps measure command usage, failure rates, and
	//     runtime. Event-specific properties are PropExitCode (process exit code)
	//     and PropDurationMs (command runtime in milliseconds). Related groups:
	//     none added directly by this event.
	EventCommandExecuted = "cli_command_executed"
	//   - EventProjectLinked: sent after the local CLI directory is linked to a
	//     Supabase project. This helps measure project-linking adoption and connect
	//     future events to the right project and organization. Event-specific
	//     properties: none. Related groups: GroupOrganization and GroupProject.
	//     Related group-identify payloads sent during linking are:
	//     organization group -> organization_slug, and project group -> name,
	//     organization_slug.
	EventProjectLinked = "cli_project_linked"
	//   - EventLoginCompleted: sent after a login flow completes successfully. This
	//     helps measure successful login completion and supports identity stitching
	//     between anonymous and authenticated usage. Event-specific properties:
	//     none. Related groups: none added directly by this event.
	EventLoginCompleted = "cli_login_completed"
	//   - EventStackStarted: sent after the local development stack starts
	//     successfully. This helps measure local development usage and successful
	//     stack startup. Event-specific properties: none. Related groups: none
	//     added directly by this event, but linked project groups may still be
	//     attached when available.
	EventStackStarted = "cli_stack_started"
)

// Shared event properties added to every captured event by Service.Capture.
const (
	// PropPlatform identifies the product source for the event. The CLI always
	// sends "cli".
	PropPlatform = "platform"
	// PropSchemaVersion is the version of the telemetry payload format. This is
	// not a database schema version.
	PropSchemaVersion = "schema_version"
	// PropDeviceID is an anonymous identifier for this CLI installation on this
	// machine.
	PropDeviceID = "device_id"
	// PropSessionID is the PostHog session identifier used to group activity from
	// one CLI session together.
	PropSessionID = "$session_id"
	// PropIsFirstRun is true when the current telemetry state was created during
	// this run, which helps distinguish first-time setup from repeat usage.
	PropIsFirstRun = "is_first_run"
	// PropIsTTY is true when stdout is attached to an interactive terminal.
	PropIsTTY = "is_tty"
	// PropIsCI is true when the CLI appears to be running in a CI environment.
	PropIsCI = "is_ci"
	// PropIsAgent is true when the CLI appears to be running under an AI agent or
	// automation tool.
	PropIsAgent = "is_agent"
	// PropOS is the operating system reported by the Go runtime.
	PropOS = "os"
	// PropArch is the CPU architecture reported by the Go runtime.
	PropArch = "arch"
	// PropCLIVersion is the version string of the CLI build that sent the event.
	PropCLIVersion = "cli_version"
	// PropEnvSignals is an optional summary of coarse environment hints. It is
	// not a raw dump of environment variables.
	PropEnvSignals = "env_signals"
	// PropCommandRunID identifies one command invocation and can be used to tie
	// together telemetry emitted during a single command run.
	PropCommandRunID = "command_run_id"
	// PropCommand is the normalized command path, such as "link" or "db push".
	PropCommand = "command"
	// PropFlags contains changed CLI flags for that command run. Safe flag values
	// may be included, while sensitive values are redacted in the command
	// telemetry implementation.
	PropFlags = "flags"
	// PropExitCode is the process exit code for the command that produced the
	// event.
	PropExitCode = "exit_code"
	// PropDurationMs is the command runtime in milliseconds.
	PropDurationMs = "duration_ms"
)

// Group identifiers associate events with higher-level entities in PostHog.
const (
	// GroupOrganization identifies the Supabase organization related to the
	// event.
	GroupOrganization = "organization"
	// GroupProject identifies the Supabase project related to the event.
	GroupProject = "project"
)

var (
	// EnvSignalPresenceKeys lists environment variables whose presence is recorded
	// as true inside the "env_signals" property.
	EnvSignalPresenceKeys = [...]string{
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
	}

	// EnvSignalValueKeys lists environment variables whose trimmed values may be
	// recorded inside the "env_signals" property.
	EnvSignalValueKeys = [...]string{
		"AI_AGENT",
		"CURSOR_EXTENSION_HOST_ROLE",
		"TERM",
		"TERM_PROGRAM",
		"TERM_PROGRAM_VERSION",
		"TERM_COLOR_MODE",
	}
)
