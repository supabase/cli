# Plan: Streamlined `supabase dev` Onboarding Experience

## Vision

Transform `supabase dev` into the single entry point for onboarding and development:

```
$ supabase dev
# Handles: init → link → pull → start → reactive dev mode
```

And `supabase push` as the single command to deploy local changes to remote.

---

## Implementation Overview

### Phase 1: Create Onboarding Module

**New file: `internal/dev/onboarding/onboarding.go`**

Create a dedicated module to orchestrate the setup flow:

```go
package onboarding

type State struct {
    ConfigExists    bool   // supabase/config.toml exists
    ProjectLinked   bool   // .temp/project-ref exists
    HasMigrations   bool   // migrations/*.sql exist
    HasFunctions    bool   // functions/* exist
}

type Options struct {
    Interactive bool
    SkipInit    bool
    SkipLink    bool
    SkipPull    bool
}

func DetectState(ctx context.Context, fsys afero.Fs) *State
func Run(ctx context.Context, fsys afero.Fs, opts Options) error
```

### Phase 2: State Detection Functions

**New file: `internal/dev/onboarding/detect.go`**

Reuse existing detection patterns:
- `ConfigExists()` - check `utils.ConfigPath` ("supabase/config.toml")
- `ProjectLinked()` - check `utils.ProjectRefPath` (".temp/project-ref")
- `HasMigrations()` - check `utils.MigrationsDir`
- `HasFunctions()` - check `utils.FunctionsDir`

### Phase 3: Flow Integration Functions

**New file: `internal/dev/onboarding/flows.go`**

Wrap existing commands as callable functions:

```go
// Init flow - reuses internal/init.Run()
func RunInitFlow(ctx context.Context, fsys afero.Fs, interactive bool) error

// Link flow - prompts for project, reuses internal/link.Run()
func PromptLinkChoice(ctx context.Context) (LinkChoice, error)
func RunLinkFlow(ctx context.Context, fsys afero.Fs) error

// Pull flow - pulls everything: schema, functions, storage config, auth config
func RunPullFlow(ctx context.Context, fsys afero.Fs) error
```

### Phase 4: Modify Dev Command

**Modify: `internal/dev/dev.go`**

Update `Run()` to orchestrate onboarding before starting dev session:

```go
func Run(ctx context.Context, fsys afero.Fs, opts RunOptions) error {
    // 1. Detect current state
    state := onboarding.DetectState(ctx, fsys)

    // 2. Init if needed
    if !state.ConfigExists && opts.Interactive {
        onboarding.RunInitFlow(ctx, fsys, true)
    }

    // 3. Offer to link ONLY after fresh init (not on every run)
    if !state.ProjectLinked && opts.Interactive && justInitialized {
        if choice == LinkChoiceYes {
            onboarding.RunLinkFlow(ctx, fsys)
            // 4. Pull everything from remote after linking
            onboarding.RunPullFlow(ctx, fsys) // pulls schema, functions, storage, auth
        }
    }

    // 5. Existing dev flow: ensure DB running, start session
    ensureDbRunning(ctx, fsys)
    return session.Run()
}
```

**Modify: `cmd/dev.go`**

Add new flag:
```go
devFlags.BoolVar(&skipOnboarding, "skip-onboarding", false, "Skip interactive setup wizard")
```

### Phase 5: Handle Conflicts

**New file: `internal/dev/onboarding/conflict.go`**

When linking to a project that has existing local migrations:

```go
type ConflictAction int
const (
    ConflictMerge      // Pull remote, keep local migrations
    ConflictReplace    // Replace local with remote
    ConflictKeepLocal  // Skip pull, keep local
)

func PromptConflictResolution(ctx context.Context) (ConflictAction, error)
```

---

## User Experience Flow

```
$ supabase dev

┌─────────────────────────────────────────────────────────┐
│ No Supabase project found. Let's set one up!            │
│                                                         │
│ [Creating supabase/config.toml...]                      │
│ [Creating supabase/.gitignore...]                       │
│                                                         │
│ Generate VS Code settings for Deno? [Y/n]               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Do you have a remote Supabase project to connect?       │
│                                                         │
│ > Yes, link to existing project                         │
│   No, I'm starting fresh                                │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Select a project to link:                               │
│                                                         │
│ > my-app (org: acme, region: us-east-1)                │
│   other-project (org: acme, region: eu-west-1)         │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Pulling from remote project...                          │
│                                                         │
│ ✓ Schema pulled                                         │
│   Created: supabase/migrations/20240115_remote_schema.sql│
│                                                         │
│ ✓ Edge Functions pulled (3 found)                       │
│   Created: supabase/functions/hello-world/index.ts      │
│   Created: supabase/functions/auth-hook/index.ts        │
│   Created: supabase/functions/stripe-webhook/index.ts   │
│                                                         │
│ ✓ Storage config synced (2 buckets)                     │
│ ✓ Auth config synced                                    │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ Starting local database...                              │
│ Starting Supabase services...                           │
│                                                         │
│ ✓ Local development environment ready!                  │
│                                                         │
│ API URL: http://127.0.0.1:54321                        │
│ Studio:  http://127.0.0.1:54323                        │
│                                                         │
│ Watching for changes...                                 │
└─────────────────────────────────────────────────────────┘
```

---

## Files to Create/Modify

### New Files
| File | Purpose |
|------|---------|
| `internal/dev/onboarding/onboarding.go` | Main orchestration and State type |
| `internal/dev/onboarding/detect.go` | State detection functions |
| `internal/dev/onboarding/flows.go` | Init, Link, Pull flow wrappers |
| `internal/dev/onboarding/conflict.go` | Conflict resolution prompts |

### Modified Files
| File | Changes |
|------|---------|
| `internal/dev/dev.go` | Add onboarding call at start of Run() |
| `cmd/dev.go` | Add `--skip-onboarding` flag |

---

## Pull Scope

When pulling from a linked remote project, pull **everything available**:

**Always pulled:**
- Schema/migrations (via `db pull`)

**Pulled if found on remote (with progress indication):**
- Edge Functions (via `functions download`)
- Storage bucket configurations (write to config.toml)
- Auth provider configurations (write to config.toml)

This creates a complete local replica of the remote project configuration.

---

## Non-Interactive Mode

For CI/CD and scripts:

```bash
# Fails fast if not initialized
supabase dev --skip-onboarding

# Or use environment variables
SUPABASE_PROJECT_ID=xyz supabase dev --skip-onboarding
```

---

## Error Handling

1. **No config + non-interactive**: Clear error with suggestion to run `supabase init`
2. **Docker not running**: Detected in `ensureDbRunning`, suggest starting Docker
3. **API errors during link**: Show error, allow retry or continue without linking
4. **Pull failures**: Log warning, continue to dev mode (partial setup > complete failure)
5. **User cancellation (Ctrl+C)**: Graceful exit, can resume on next `supabase dev`

---

## Verification Plan

1. **Fresh directory test**: Run `supabase dev` in empty directory, verify full onboarding flow
2. **Existing project test**: Run `supabase dev` in initialized project, verify it skips init
3. **Linked project test**: Run `supabase dev` in linked project, verify it skips link prompt
4. **Non-interactive test**: Run `supabase dev --skip-onboarding` without config, verify error
5. **Cancellation test**: Cancel at each step, verify can resume
6. **Conflict test**: Have local migrations, link to project with different schema, verify conflict prompt

---

## Design Decisions

1. **Link prompt only after init**: The "do you want to link?" prompt appears only immediately after a fresh init, not on every dev run. If user skips, they must run `supabase link` manually.

2. **Push stays simple**: `supabase push` will NOT have onboarding. If not linked, it fails with a clear message to run `supabase link` first. This keeps push predictable for CI/CD.

---

## Future Enhancements (Out of Scope)

1. **Project creation**: Offer to create a new remote project if user doesn't have one
2. **Template selection**: Offer starter templates during init
3. **Selective pull**: Let user choose what to pull via checkboxes
