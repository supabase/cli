#!/usr/bin/env bash
# Prepares a pristine, linked project directory for `workers.tape` to record in.
#
# The tape drives the real CLI against a real Supabase project, so this script
# only assembles the workdir; it never touches the platform. Run it before every
# recording so the tape always starts from the same state.
#
#   apps/cli/demo/setup.sh
#   vhs apps/cli/demo/workers.tape
#
# Override the project with SUPABASE_PROJECT_REF; otherwise the repo's own
# linked project (supabase/.temp/) is reused.
set -euo pipefail

demo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$demo_dir/../../.." && pwd)"
workdir="$demo_dir/.workdir"
binary="$repo_root/apps/cli/dist/supabase-legacy"

if [[ ! -x "$binary" ]]; then
  echo "Missing $binary — run: pnpm exec turbo run supabase#build" >&2
  exit 1
fi

# The ref the recording deploys into: explicit env first, then whatever this
# checkout is linked to, in either of the two shapes `link` has written.
project_ref="${SUPABASE_PROJECT_REF:-}"
if [[ -z "$project_ref" && -f "$repo_root/supabase/.temp/project-ref" ]]; then
  project_ref="$(tr -d '[:space:]' < "$repo_root/supabase/.temp/project-ref")"
fi
if [[ -z "$project_ref" && -f "$repo_root/supabase/.temp/linked-project.json" ]]; then
  project_ref="$(sed -n 's/.*"ref"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    "$repo_root/supabase/.temp/linked-project.json")"
fi
if [[ -z "$project_ref" ]]; then
  echo "No project ref found — set SUPABASE_PROJECT_REF or run: supabase link" >&2
  exit 1
fi

rm -rf "$workdir"
mkdir -p "$workdir/supabase/.temp" "$workdir/bin"

# A bare config.toml: the tape's `workers new` is what adds the first
# [workers.<name>] section, so the recording shows it being written.
printf 'project_id = "%s"\n' "$project_ref" > "$workdir/supabase/config.toml"
printf '%s' "$project_ref" > "$workdir/supabase/.temp/project-ref"

# `supabase` on PATH is this checkout's binary, so the recording shows the
# branch under development rather than whatever is installed globally.
cat > "$workdir/bin/supabase" <<EOF
#!/bin/sh
exec "$binary" "\$@"
EOF
chmod +x "$workdir/bin/supabase"

# Everything the tape's hidden preamble sources, kept here so the tape itself
# stays readable. The unset list is `@vercel/detect-agent`'s env catalogue: the
# CLI auto-switches to JSON output when it thinks a coding agent is driving it,
# and a recording started from inside one would inherit that and render every
# command as JSON instead of the tables the screencast is about.
cat > "$workdir/bin/demo-env.sh" <<EOF
export PATH="$workdir/bin:\$PATH"
export SUPABASE_NO_UPDATE_NOTIFIER=1
export PS1="\[\e[38;5;42m\]❯\[\e[0m\] "
unset AI_AGENT ANTIGRAVITY ANTIGRAVITY_AGENT AUGMENT_AGENT AUGMENT_CLI CLAUDE \
  CLAUDE_CODE CLAUDE_CODE_IS_COWORK CLAUDECODE CODEX CODEX_CI CODEX_SANDBOX \
  CODEX_THREAD_ID COPILOT_ALLOW_ALL COPILOT_GITHUB_TOKEN COPILOT_MODEL COWORK \
  CURSOR CURSOR_AGENT CURSOR_CLI CURSOR_EXTENSION_HOST_ROLE CURSOR_TRACE_ID \
  DEVIN DEVIN_LOCAL_PATH GEMINI GEMINI_CLI GITHUB_COPILOT GITHUB_COPILOT_CLI \
  OPENCODE OPENCODE_CLIENT REPL_ID REPLIT
EOF

echo "Ready: $workdir (project $project_ref)"
