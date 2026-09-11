#!/usr/bin/env bash
# Runs one GitHub Actions self-hosted runner, forever.
#
# Each pass mints a just-in-time registration, lets the runner take exactly one
# job with it, and throws it away. The registration is single-use, so an
# instance that dies mid-job leaves nothing behind on GitHub and no long-lived
# runner token is ever written to disk. `instances` in supabase/config.toml is
# the pool size: one instance is one concurrent job.
set -euo pipefail

# The runner refuses to execute as root, and the platform launcher may hand us
# a root process regardless of the image's USER. Drop down before doing work.
if [ "$(id -u)" -eq 0 ]; then
  exec setpriv --reuid=runner --regid=runner --init-groups "$0" "$@"
fi

RUNNER_HOME="${RUNNER_HOME:-/home/runner/actions-runner}"
RUNNER_WORK_DIR="${RUNNER_WORK_DIR:-/home/runner/_work}"
RUNNER_STATE_FILE="${RUNNER_STATE_FILE:-/home/runner/state.json}"
RUNNER_LABELS="${RUNNER_LABELS:-supabase}"
RUNNER_GROUP_ID="${RUNNER_GROUP_ID:-1}"
RUNNER_NAME_PREFIX="${RUNNER_NAME_PREFIX:-supabase}"
GITHUB_API_URL="${GITHUB_API_URL:-https://api.github.com}"
GITHUB_OWNER="${GITHUB_OWNER:-}"
GITHUB_REPO="${GITHUB_REPO:-}"
PORT="${PORT:-8080}"

scope_description=""
jobs_completed=0
shutting_down=0
runner_pid=""
runner_id=""

log() {
  printf '%s [runner] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

fail() {
  log "ERROR: $*"
  write_state "error" "$*"
  exit 1
}

write_state() {
  local phase="$1" detail="${2:-}"
  jq -n \
    --arg phase "$phase" \
    --arg detail "$detail" \
    --arg scope "$scope_description" \
    --arg labels "$RUNNER_LABELS" \
    --arg updated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson jobs "$jobs_completed" \
    '{phase: $phase, detail: $detail, scope: $scope, labels: $labels, jobs_completed: $jobs, updated_at: $updated}' \
    > "$RUNNER_STATE_FILE.tmp" && mv "$RUNNER_STATE_FILE.tmp" "$RUNNER_STATE_FILE"
}

b64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# GitHub App private keys arrive through `supabase secrets` as a single line
# more often than not, so accept PEM, \n-escaped PEM, or base64-wrapped PEM.
app_private_key() {
  local raw="$github_app_key"
  if [[ "$raw" == *"BEGIN"*"PRIVATE KEY"* ]]; then
    printf '%b\n' "$raw"
  else
    printf '%s' "$raw" | tr -d '\n' | openssl base64 -d -A
  fi
}

app_jwt() {
  local now header payload signing_input signature
  now="$(date +%s)"
  header="$(printf '%s' '{"alg":"RS256","typ":"JWT"}' | b64url)"
  payload="$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$((now - 60))" "$((now + 540))" "$github_app_id" | b64url)"
  signing_input="${header}.${payload}"
  signature="$(printf '%s' "$signing_input" \
    | openssl dgst -sha256 -sign <(app_private_key) -binary \
    | b64url)"
  printf '%s.%s' "$signing_input" "$signature"
}

gh_api() {
  local method="$1" path="$2" token="$3" body="${4:-}"
  local -a args=(
    --fail-with-body -sS
    -X "$method"
    -H "Authorization: Bearer $token"
    -H "Accept: application/vnd.github+json"
    -H "X-GitHub-Api-Version: 2022-11-28"
    -H "User-Agent: supabase-cli-compute"
  )
  if [ -n "$body" ]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi

  # --fail-with-body puts GitHub's explanation on stdout alongside a non-zero
  # exit, so capture both and report the reason rather than just the code.
  local response status=0
  response="$(curl "${args[@]}" "${GITHUB_API_URL}${path}" 2>&1)" || status=$?
  if [ "$status" -ne 0 ]; then
    log "GitHub API ${method} ${path} failed: $(printf '%s' "$response" | tr '\n' ' ' | cut -c1-300)"
    return "$status"
  fi
  printf '%s' "$response"
}

installation_id() {
  local jwt="$1" path
  if [ -n "$GITHUB_REPO" ]; then
    path="/repos/${GITHUB_OWNER}/${GITHUB_REPO}/installation"
  else
    path="/orgs/${GITHUB_OWNER}/installation"
  fi
  gh_api GET "$path" "$jwt" | jq -er '.id'
}

# A PAT is used as-is; an App mints a fresh installation token per pass, which
# keeps every token we hold short-lived.
github_token() {
  if [ -n "$github_pat" ]; then
    printf '%s' "$github_pat"
    return
  fi

  local jwt install_id
  jwt="$(app_jwt)"
  install_id="$github_app_installation"
  if [ -z "$install_id" ]; then
    install_id="$(installation_id "$jwt")"
  fi
  gh_api POST "/app/installations/${install_id}/access_tokens" "$jwt" | jq -er '.token'
}

# Which size a worker runs at is declared in supabase/config.toml, so read it
# back off the container rather than keeping a second copy of it in a label: a
# resized pool then relabels itself with nobody editing the runner. cgroup
# reports the instance's own cap; /proc/meminfo reports the whole host, so it is
# no fallback.
size_label() {
  if [ -n "${RUNNER_SIZE_LABEL:-}" ]; then
    printf '%s' "$RUNNER_SIZE_LABEL"
    return 0
  fi

  local bytes=""
  if [ -r /sys/fs/cgroup/memory.max ]; then
    bytes="$(cat /sys/fs/cgroup/memory.max)"
  elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
    bytes="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
  fi

  # "max" (or anything non-numeric) means uncapped. Advertising a wrong size is
  # worse than advertising none, because jobs still get scheduled onto it.
  case "$bytes" in
    '' | *[!0-9]*) return 0 ;;
  esac

  # Round to the nearest GiB: a 2gb instance need not report exactly 2 GiB. The
  # upper bound rejects a cgroup v1 "unlimited" sentinel, which overflows to a
  # negative number here.
  local gib=$(( (bytes + 536870912) / 1073741824 ))
  if [ "$gib" -lt 1 ] || [ "$gib" -gt 64 ]; then
    return 0
  fi

  printf 'supabase-%sgb' "$gib"
}

# A JIT registration carries only the labels it is given: unlike `config.sh`,
# GitHub adds no implicit ones, so a workflow saying `runs-on: self-hosted`
# would never match. Supply the defaults a normal runner would have.
labels_json() {
  local arch
  case "$(uname -m)" in
    x86_64) arch=X64 ;;
    aarch64 | arm64) arch=ARM64 ;;
    *) arch="$(uname -m)" ;;
  esac
  jq -Rn --arg raw "$RUNNER_LABELS" --arg arch "$arch" --arg size "$(size_label)" \
    '["self-hosted", "Linux", $arch, $size] + ($raw | split(",") | map(gsub("^\\s+|\\s+$"; "")))
     | map(select(length > 0))
     | unique_by(ascii_downcase)'
}

# Returns the opaque JIT config blob the runner consumes instead of a
# `config.sh` registration.
jit_config() {
  local token="$1" name="$2" path body
  if [ -n "$GITHUB_REPO" ]; then
    path="/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runners/generate-jitconfig"
  else
    path="/orgs/${GITHUB_OWNER}/actions/runners/generate-jitconfig"
  fi
  body="$(jq -n \
    --arg name "$name" \
    --arg work "$RUNNER_WORK_DIR" \
    --argjson group "$RUNNER_GROUP_ID" \
    --argjson labels "$(labels_json)" \
    '{name: $name, runner_group_id: $group, labels: $labels, work_folder: $work}')"
  gh_api POST "$path" "$token" "$body" | jq -er '[.runner.id, .encoded_jit_config] | @tsv'
}

# GitHub reaps an ephemeral runner once it finishes a job, but one that shuts
# down while idle -- a redeploy, or scaling the pool down -- would linger in the
# runner list as offline. Clear it out ourselves; 404 just means GitHub got
# there first.
delete_runner() {
  local id="$1" path token code
  [ -n "$id" ] || return 0
  if [ -n "$GITHUB_REPO" ]; then
    path="/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/runners/${id}"
  else
    path="/orgs/${GITHUB_OWNER}/actions/runners/${id}"
  fi
  token="$(github_token)" || return 0
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE \
    -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "${GITHUB_API_URL}${path}" || true)"
  case "$code" in
    204 | 404) : ;;
    *) log "could not remove runner ${id} (HTTP ${code})" ;;
  esac
}

on_terminate() {
  shutting_down=1
  log "shutdown signal received"
  if [ -n "$runner_pid" ] && kill -0 "$runner_pid" 2>/dev/null; then
    log "asking the runner to finish its current job"
    kill -TERM "$runner_pid" 2>/dev/null || true
  fi
}

# --- startup checks -----------------------------------------------------

# A job step is a grandchild of this script and inherits its environment, so
# the credentials are taken out of it here: a shell variable is not exported,
# which puts the token beyond reach of anything the runner executes.
github_pat="${GITHUB_PAT:-}"
github_app_id="${GITHUB_APP_ID:-}"
github_app_key="${GITHUB_APP_PRIVATE_KEY:-}"
github_app_installation="${GITHUB_APP_INSTALLATION_ID:-}"
unset GITHUB_PAT GITHUB_APP_ID GITHUB_APP_PRIVATE_KEY GITHUB_APP_INSTALLATION_ID

[ -n "$GITHUB_OWNER" ] || fail "GITHUB_OWNER is not set. Set it to the org (or user) that owns the runners."

if [ -z "$github_pat" ] && [ -z "$github_app_id" ]; then
  fail "No GitHub credentials. Set GITHUB_PAT, or GITHUB_APP_ID plus GITHUB_APP_PRIVATE_KEY."
fi

if [ -z "$github_pat" ] && [ -z "$github_app_key" ]; then
  fail "GITHUB_APP_ID is set without GITHUB_APP_PRIVATE_KEY."
fi

if [ -n "$GITHUB_REPO" ]; then
  scope_description="${GITHUB_OWNER}/${GITHUB_REPO}"
else
  scope_description="${GITHUB_OWNER} (org-wide)"
fi

trap on_terminate TERM INT

mkdir -p "$RUNNER_WORK_DIR"
write_state "starting"

# The launcher expects the image to answer HTTP on $PORT, which also gives a
# private compute's state somewhere to be read from inside the project.
PORT="$PORT" RUNNER_STATE_FILE="$RUNNER_STATE_FILE" python3 /srv/health.py &
health_pid=$!

log "supervising runner for ${scope_description}, labels: ${RUNNER_LABELS}"

backoff=5
while [ "$shutting_down" -eq 0 ]; do
  runner_name="${RUNNER_NAME_PREFIX}-$(hostname)-$(date +%s)-${RANDOM}"

  write_state "registering"
  if ! token="$(github_token)"; then
    log "could not obtain a GitHub token; retrying in ${backoff}s"
    sleep "$backoff"
    backoff=$(( backoff < 60 ? backoff * 2 : 60 ))
    continue
  fi

  if ! registration="$(jit_config "$token" "$runner_name")"; then
    log "could not generate a JIT runner config; retrying in ${backoff}s"
    sleep "$backoff"
    backoff=$(( backoff < 60 ? backoff * 2 : 60 ))
    continue
  fi
  runner_id="${registration%%$'\t'*}"
  jit="${registration#*$'\t'}"

  backoff=5
  log "registered ${runner_name}; waiting for a job"
  write_state "listening" "$runner_name"

  status=0
  "$RUNNER_HOME/run.sh" --jitconfig "$jit" &
  runner_pid=$!
  wait "$runner_pid" || status=$?
  runner_pid=""
  delete_runner "$runner_id"

  if [ "$shutting_down" -eq 1 ]; then
    log "runner stopped for shutdown"
    break
  fi

  if [ "$status" -eq 0 ]; then
    jobs_completed=$(( jobs_completed + 1 ))
    log "job finished (${jobs_completed} total); recycling"
  else
    log "runner exited with status ${status}; recycling"
  fi

  write_state "cleaning"
  # The registration was single-use, so the only thing worth carrying over is
  # nothing: wipe the job workspace so the next job starts clean.
  find "$RUNNER_WORK_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true
done

write_state "stopped"
kill "$health_pid" 2>/dev/null || true
log "exiting"
