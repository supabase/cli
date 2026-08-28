# Screencast of the full `supabase workers` lifecycle, recorded against a real
# linked project. Run from the repository root:
#
#   apps/cli/demo/setup.sh
#   vhs apps/cli/demo/workers.tape
#
# setup.sh builds the pristine workdir this records in and puts this checkout's
# binary on PATH as `supabase`. The tape deletes the worker it deploys, so a
# completed recording leaves the project as it found it; `cleanup.sh` handles an
# aborted one.

Output apps/cli/demo/workers.gif

Set Shell bash
# `workers --help` lays its global-flag table out at a fixed ~173 columns and
# does not reflow, so the frame is sized to fit it rather than the other way
# round: 1560px at 14px JetBrains Mono is ~176 columns. The height is what that
# same help output needs; every other step is shorter.
Set FontSize 14
Set Width 1560
Set Height 700
Set Padding 20
Set TypingSpeed 55ms
Set Theme "Catppuccin Mocha"
Set CursorBlink false

# A clean prompt and a clean environment: `supabase` resolving to the binary
# setup.sh wrapped, no upgrade nag, and no coding-agent env leaking in from
# whatever shell `vhs` was started in. See setup.sh for what this sources.
Hide
Type "cd apps/cli/demo/.workdir"
Enter
Type "source bin/demo-env.sh"
Enter
Type "clear"
Enter
Show
Sleep 1s

# --- What the group offers -------------------------------------------------
Type "supabase workers --help"
Enter
Sleep 6s

Type "clear"
Enter
Sleep 500ms

# --- new: scaffold locally, nothing deployed -------------------------------
Type "supabase workers new"
Enter
Sleep 2s
Type "hello-api"
Sleep 800ms
Enter
Sleep 1.5s

# Runtime picker, pre-selected on the default (deno); walk down to node.
Down
Sleep 600ms
Down
Sleep 800ms
Enter
Sleep 1.5s

# Size picker, pre-selected on 2gb.
Sleep 800ms
Enter
Sleep 3s

# The choice is recorded in config.toml, not just on disk.
Type "cat supabase/config.toml"
Enter
Sleep 4s

Type "clear"
Enter
Sleep 500ms

# --- push: build and deploy ------------------------------------------------
# Returns once the platform accepts the spec and the uploaded context; the
# server-side build runs on after it. `--wait` blocks for the build's verdict.
Type "supabase workers push hello-api"
Enter
Sleep 8s

Type "clear"
Enter
Sleep 500ms

# --- list: config.toml unioned with what the API reports -------------------
Type "supabase workers list"
Enter
Sleep 8s

Type "clear"
Enter
Sleep 500ms

# --- status: one worker in detail ------------------------------------------
Type "supabase workers status hello-api"
Enter
Sleep 7s

Type "clear"
Enter
Sleep 500ms

# --- delete: irreversible, so it confirms by name --------------------------
Type "supabase workers delete hello-api"
Enter
Sleep 3s
Type "hello-api"
Sleep 800ms
Enter
Sleep 6s
