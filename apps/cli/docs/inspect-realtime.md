# `supabase inspect realtime`

Debug a Realtime connection by joining a channel as a real client.

Every other `inspect` family answers its question by querying Postgres. Realtime
cannot be inspected that way: whether a frame reaches a subscriber is a property
of the websocket, the API key, the channel's RLS and the replication stream
_together_. The only way to establish it is to connect and watch.

| Command                                 | The question it answers                  |
| --------------------------------------- | ---------------------------------------- |
| `check [channel]`                       | Why is Realtime not working?             |
| `listen [channel]`                      | Is the frame I expect actually arriving? |
| `broadcast <channel> <event> [payload]` | Did the server take my message?          |
| `presence [channel]`                    | Who else is on this channel?             |

---

## Build and run it locally

Running from source is the fast loop; the compiled binary is what ships.

```sh
cd apps/cli

# fast loop — no build step
bun src/main.ts inspect realtime check

# the real artifact (bundles the Realtime SDK into a single binary)
pnpm run build:binary
./dist/supabase inspect realtime check
```

> `pnpm exec turbo run supabase#build` also builds the Go sidecar and
> `@supabase/config`. Use `build:binary` when you only want the CLI binary.

Tests:

```sh
cd apps/cli

# everything for this family (61 unit + 57 integration, no network, no server)
bun --bun vitest run --project unit --project integration src/commands/inspect/realtime

# the whole in-process suite
pnpm run test:unit && pnpm run test:integration
```

The handler tests run against a scripted session rather than a socket
(`RealtimeSessions`, see `realtime-session.service.ts`), so they need no
stack, no project and no credentials.

## Point it at something

Resolution order, per value, so a URL and a key can come from different places:

1. `--url` / `--api-key` (`--publishable-key` is accepted as an alias)
2. `SUPABASE_URL` / `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_ANON_KEY`
3. the project the command is pointed at: `--local`, `--linked`, `--project-ref`
4. auto-detect — a local stack when one is _answering_ (it is probed, not
   assumed), otherwise the linked project

```sh
# in a project directory with a running stack: nothing to pass
supabase inspect realtime check

# a hosted project
supabase inspect realtime check --project-ref abcdefghijklmnopqrst

# anything, including self-hosted
supabase inspect realtime check --url https://abc.supabase.co --api-key sb_publishable_...
```

## For people

```sh
# 1. Always start here. It names the step that broke.
supabase inspect realtime check

# 2. Watch a channel. Ctrl-C to stop.
supabase inspect realtime listen room_a

# 3. Make something arrive, from another terminal.
supabase inspect realtime broadcast room_a ping '{"n":1}'

# 4. Watch database changes, with commit-to-receipt latency per row.
supabase inspect realtime listen --postgres public.messages --event INSERT

# 5. See who is present; hold your own membership open with listen --as.
supabase inspect realtime presence room_a
supabase inspect realtime listen room_a --as me --duration 5m
```

A healthy `check` looks like this:

```
✔ resolve: using local stack at http://127.0.0.1:54321
✔ reach: 127.0.0.1:54321 is serving Realtime (probe status 400).
✔ join: joined "room_a" (6ms)
```

A broken one names the cause instead of "transport error":

```
✔ resolve: using https://abc.supabase.co
✘ reach: abc.supabase.co rejected the API key.
```

## For agents

The contract, in order of how much it matters:

**Exit code is the verdict.** `0` means the command did what was asked — which
for `listen` includes receiving nothing, because an empty log is a finding, not
a failure. Non-zero means a step failed.

**One JSON object on stdout, diagnostics on stderr.** Always parseable:

```sh
supabase inspect realtime check --output-format json | jq '.steps'
# [{"name":"resolve","ok":true,...},{"name":"reach",...},{"name":"join",...,"durationMs":348}]
```

**Branch on `error.code`, never on message text.**

| `error.code`                              | Meaning                                                    | Whose problem       |
| ----------------------------------------- | ---------------------------------------------------------- | ------------------- |
| `RealtimeTargetNotResolvedError`          | no URL/key could be found                                  | the invocation      |
| `RealtimeInvalidUrlError`                 | `--url` is not an http(s) URL                              | the invocation      |
| `RealtimeInvalidOptionError`              | a flag value is out of range                               | the invocation      |
| `RealtimeKeyRejectedError`                | the endpoint refused the key                               | the caller's config |
| `RealtimeEndpointUnhealthyError`          | no server, or the gateway is down (`kind` narrows it)      | the service         |
| `RealtimeJoinFailedError`                 | the channel was refused (usually RLS on a private channel) | the policy          |
| `RealtimePostgresSubscriptionFailedError` | the server refused the table subscription                  | the project config  |
| `RealtimeBroadcastFailedError`            | the send was not acknowledged                              | the service         |

**Tails must be bounded.** `--output-format json` emits a single object when the
tail ends, so an unbounded tail in that format could never emit anything — the
command refuses it and says so. Either bound it or stream it:

```sh
# bounded: one object at the end
supabase inspect realtime listen room_a --duration 30s --output-format json

# streamed: one NDJSON object per frame, as they arrive
supabase inspect realtime listen room_a --output-format stream-json \
  | jq -c 'select(.type=="realtime-frame") | {category, event, payload}'
```

Each `realtime-frame` carries the structured `payload` _and_ a rendered `line`,
so a consumer can inspect fields or echo what a human would have seen.

**Choose what gets recorded** with `--categories`: the channel-side buckets
(`system`, `broadcast`, `presence`, `postgres`) are on by default, the client's
own internals (`transport`, `channel`) are opt-in, and `all` records everything.
`--server-log-level info|warning|error` sets the server's verbosity for the
connection.

**Credentials never appear in output.** API keys, JWTs and `?apikey=` query
params are redacted before any frame is recorded, including in `stream-json` and
in `--debug` HTTP logs.

## Debugging playbook

What each symptom actually means, with the command that distinguishes the causes.

### "Realtime isn't working"

```sh
supabase inspect realtime check
```

`reach` fails → wrong URL/ref (404), rejected key (401/403), or an unreachable
host. `join` fails → the endpoint is fine and the server refused _this channel_,
which on a private channel means RLS.

### "My subscription joins but no events arrive"

The most common report, and the one with the most causes. `listen` now separates
them for you:

```sh
supabase inspect realtime listen --postgres public.messages
```

- **"Subscription refused"** — the server rejected the subscription: the table is
  not in the `supabase_realtime` publication, or the filter/columns are invalid.
  The server's own reason is printed.
- **Confirmed, then silence** — the subscription is live. The command says so and
  names the three remaining causes: nothing changed, the `--filter` excludes what
  did change, or RLS does not grant the subscribing role. To rule RLS out:

```sh
# as a real user
supabase inspect realtime listen --postgres public.messages --email you@example.com

# ignoring RLS entirely — if this works and the above does not, it is your policy
supabase inspect realtime listen --postgres public.messages --service-role
```

> UPDATE and DELETE additionally need the table's replica identity to carry the
> old row. If INSERT arrives and UPDATE does not, check `REPLICA IDENTITY`.

### "Presence is broken"

Presence only reaches a client that asked for it, so this needs two sessions:

```sh
# terminal 1 — holds a membership open
supabase inspect realtime listen room_a --as alice --duration 5m

# terminal 2 — should see alice
supabase inspect realtime presence room_a
```

### "My private channel rejects everyone"

Three runs isolate the layer:

```sh
supabase inspect realtime check room_a --private                      # anon → expect refusal
supabase inspect realtime check room_a --private --email you@example.com  # your user
supabase inspect realtime check room_a --private --service-role       # ignores RLS
```

If only the last one joins, the problem is your `realtime.messages` policy, not
Realtime. Note that `check --service-role` says so in its output, because a pass
with an elevated key proves nothing about application users.

### "Replay isn't replaying"

`--replay-since` replays only messages that were **persisted** — sent through
`realtime.send()`, the REST broadcast endpoint, or a database trigger. A message
broadcast over a socket is not replayable. Replay also requires `--private`.

```sh
supabase inspect realtime listen topic:orders --private --replay-since 5m --replay-limit 20
```

Replayed frames carry `meta.replayed: true`.

## The guided tour

One command that runs the scenarios above in order, printing each command before
it runs it:

```sh
cd apps/cli
bun scripts/demo-inspect-realtime.ts                       # uses whatever it can detect
bun scripts/demo-inspect-realtime.ts --url ... --api-key ...
bun scripts/demo-inspect-realtime.ts --table public.messages --email dev@example.com --password ...
```

Steps that need something it cannot provide (a table in the publication, a user
to sign in as) are skipped with an explanation rather than failed, so it is safe
to run against any target.

## Implementation notes

**The user token must be applied before the channel subscribes.** `RealtimeClient.connect()`
starts its own auth without awaiting it, and `RealtimeChannel.subscribe()` builds the join
payload from whatever `accessTokenValue` holds at that moment. Passing the SDK an `accessToken`
callback and subscribing immediately races that: the join goes out with no `access_token` and the
server treats the connection as anonymous, which silently defeats every RLS check — private
channels are refused and `postgres_changes` on an RLS-protected table confirms the subscription
then delivers nothing. The session awaits `setAuth(token)` before subscribing; a manually set
token also survives resubscribes.

**A confirmed `postgres_changes` subscription is not a guarantee of delivery.** Some servers
honour `postgres_changes_options.wait` and reject the join; others answer `ok` and report the
refusal afterwards in a `system` frame. The session exposes both outcomes separately (`joined`
and `postgresSubscribed`) so a caller can tell them apart.

**The API key travels as `?apikey=`.** That is the only place both a local Kong gateway and a
hosted deployment read it on the websocket route; an `apikey` header that works elsewhere in the
stack returns 401 here. `redactHttpUrl` keeps it out of `--debug` output.

**A bare 500 from the probe means healthy.** This route legitimately answers 500 to a non-upgrade
request on hosted Supabase and 400 on a local stack, so only 502/503/504 are read as an outage.

## Related

- `SIDE_EFFECTS.md` in the command directory — files read/written, routes
  called, environment variables, exit codes.
- `../../../realtime/test/e2e` in the Realtime repo — the server-side e2e suite.
  It covers the same protocol from the other direction and is the better tool for
  load and throughput work; this command is for debugging one connection.
