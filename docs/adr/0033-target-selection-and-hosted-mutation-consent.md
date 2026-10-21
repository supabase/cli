# 0033. Target selection and hosted-mutation consent

**Status**: proposed
**Date**: 2026-10-15

## Problem Statement

Commands that can act on either the local stack or a hosted project chose their default per handler.
`db push`, `db dump`, `migration list`, `inspect`, `storage` and `gen types` defaulted to the linked
project. `db reset`, `db query`, `migration up`, `seed buckets` and `db diff` defaulted to local.
Commands with identical flags defaulted in opposite directions, so a user could not tell whether a
command would reach production.

Three more problems sat next to it:

- Each family parsed the target flags its own way. `--linked=false` still selected the linked
  project, and `--project-id` and `--project-ref` named the same thing on different commands.
  `--project-ref` selected a project on one command and errored on the next, `--db-url` was missing
  from some, and database commands took no branch names.
- Project-ref resolution had several chains. Some commands opened a project picker when the checkout
  was unlinked, and database and storage commands failed.
- Confirmation for a hosted mutation was inconsistent. `db push` defaulted to Yes and ran in JSON
  and non-TTY mode. `migration up --linked` and `migration repair <versions>` wrote to the remote with
  no prompt. Some prompts came after the first persistent effect. A piped `y` or `SUPABASE_YES` in a
  committed `supabase/.env` could approve a production write.

Output rarely said which target a command had resolved.

## Decision

### Target groups

Every leaf command declares one group with `withTargetPolicy`. The declaration is the source of
truth for the default target, the consent default and the help labels, so none of them can drift from
behaviour. `resolveTarget` and `requireHostedMutationConsent` require it, so a command that resolves
a target or asks for consent without one fails to compile, and a handler never passes a default.

- `local-only`: `start`, `stop`, `status`, `stack *`, `init`, `unlink`, `functions serve`,
  `migration new`, `gen signing-key`, `db schema declarative sync`. They act on the local stack or
  the checkout and have no target flags.
- `account`: `login`, `logout`, `whoami`, `orgs *`, `projects` (except `projects api-keys`),
  `bootstrap`, `feedback`. They act on the account or an organisation and have no default project.
- `hosted`: `functions deploy`, `secrets *`, `config *`, `branches *`, `projects api-keys` and the
  other platform resource commands. They have no local side, so they act on the linked project by
  default and take `--remote=<ref|branch>` for another project. `link` is the one hosted command
  without `--remote`: its target is the `[ref-or-branch]` argument, and `--project-ref` still works.
- `selectable`: `db push`, `db pull`, `migration fetch`, `db reset`, `db query`, `db lint`,
  `db advisors`, `db dump`, `db diff`, `test db`, `inspect *`,
  `migration list|up|down|squash|repair`, `gen types`, `storage *`, `seed buckets`,
  `db schema declarative generate`. They run locally unless `--remote` is passed.
- `removed`: `db branch *`, `db remote changes`, `db remote commit`. They exit 1 with replacement
  guidance.

`db push`, `db pull`, `migration fetch`, `db dump`, `migration list`, `migration repair`,
`inspect`, `gen types` and `storage ls|cp|mv|rm` move from the linked project to local.
`db schema declarative generate` stops asking which target to use.

### One flag: `--remote`

`--remote` selects the target on every command that can act on a hosted project, except `link`. It
is bare or takes a value, and there is no workspace-level switch, so the intent is on the command
line and nowhere else.

| You pass            | Target                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| nothing             | The local stack on `selectable` commands; the linked project on `hosted` |
| `--remote`          | The linked project, production or a branch                               |
| `--remote=<ref>`    | That project: 20 lowercase letters, never looked up as a branch          |
| `--remote=<url>`    | That database: a `postgres://` or `postgresql://` URL                    |
| `--remote=<branch>` | A branch of the linked project, by name or UUID                          |

Every command resolves a `--remote=<branch|uuid>` value with one resolver, the one `supabase link`
uses. A value that matches no branch fails with link's error, which lists the branches; a 20-letter
value with an uppercase letter is still looked up as a branch, and the error hints that refs are
lowercase. A branch UUID also resolves in a checkout with no linked project, where it is reported as
the bare project ref, `unverified` in JSON, because the lookup does not say whether it is the
default branch, and one the API can't look up fails as branch not found. A keyword connection string
(`host=… user=…`) is rejected, not looked up as a branch. A URL applies only where the remote side
is Postgres: `storage`, `seed buckets` and `hosted` commands need a project, so the `--remote`
parser rejects a URL there as an invalid value, before any later check or request, without echoing
it. `hosted` commands accept `--remote=<ref|branch>`, and bare `--remote` changes nothing for them.
`SUPABASE_PROJECT_ID` alone never makes a `selectable` command remote; it is only a ref source once
`--remote` is passed, and it alone is enough for the `default; pass --remote` hint. An unresolvable
remote target fails. The CLI never falls back between local and remote.

`--remote=<value>` always parses. `--remote <value>` is rewritten to `--remote=<value>` before
parsing when the command takes no positional (a hidden one, such as `gen types`'s legacy language,
does not count), when the token is a database URL, or when the command already has more bare tokens
than positionals. The one ambiguous shape, a bare `--remote` directly followed by a token the
command took as a positional, is settled before anything runs. A project-ref-shaped token fails
with no request, because a 20-letter operand such as a migration or function name must not silently
retarget the command at another project: the error offers `--remote=<ref>` for that project and
`--remote` last to keep the operand. A `branches *` command, whose `--remote` never names a branch,
applies only this check. Any other token is checked against the linked project's branches. It fails
when it names a branch, equals one ignoring case, or is one edit (an adjacent swap counts as one)
from a non-default branch name of five or more characters, so an ordinary word is not mistaken for
a typo; otherwise it runs as the operand. When the branches can't be listed the run
still fails closed, and the error names the cause (an HTTP status or the network error, with the fix
for a 401, 403 or 404). Docs, help and examples put `--remote` last, in the `=` form when it has a
value, so it cannot be read as anything else, and shell completion never offers a space-separated
value for `--remote` on a command that has a positional.

### Deprecated aliases

`--linked`, `--project-ref`, `--db-url` and `gen types --project-id` stay through v3 as hidden
aliases. Each goes through the same resolver as the `--remote` form it maps to, prints a warning
that names that form, and says v4 removes it. `--local` is still accepted and does nothing, because
local is already the default; it warns the same way. v4 removes all of them, and `db diff`'s
`linked` value for `--from` and `--to`, which `remote` replaces. A warning names only the
replacement and carries no example command. It never repeats an operand, a flag value or a URL,
because they can be secrets that a CI log would then keep.

### Selector rules

One parser (`parseTargetSelector`) backs every `selectable` command and maps the deprecated aliases
onto `--remote`:

- `--remote` and the aliases name one target and are never resolved by precedence.
  `--remote=<value>` together with an alias is an error, and so are two of `--remote`, `--linked`,
  `--db-url` and `--local`, or `--project-ref` with `--local` or `--db-url`.
- A repeated `--remote` is one selection when every occurrence resolves to the same target, with a
  bare `--remote` counting as the linked project, and an error before anything runs when they differ.
- A bare `--remote` together with `--project-ref=<x>` is accepted, as `--linked --project-ref=<x>`
  is: the alias's value wins and its warning prints.
- `db diff` with `--remote` together with `--from` or `--to` is an error. The aliases are accepted
  there with a warning that names the `--from`/`--to` value: `--project-ref` points a `remote` side
  at the project it names, and is an error when neither side is `remote`; `--linked`, `--db-url`
  and `--local` change nothing. In `--from` and `--to`, `remote` means the linked project, or the
  one `--project-ref` names.
- `--no-remote` and `--remote=false` fail and tell the user to leave `--remote` out.
  `--remote yes`, `--remote y`, `--remote 1`, `--remote true` and `--remote on` mean bare `--remote`. An empty
  `--remote=` value is rejected, and the message names the values that command accepts. Neither
  error prints the command's help.
- A conflict error lists only the selector flags the command has and suggests the `--remote` form.
  `--remote` on `link`, which takes the project as its argument, and on a `local-only` command
  fails with a message saying so instead of an unknown-flag error.
- `--password` is rejected unless the target is a project, meaning bare `--remote`, a ref or a
  branch.

### One project-ref chain

`ProjectRefResolver.resolveRef` is the only chain: `--remote=<ref>`, then `SUPABASE_PROJECT_ID`, then
`supabase/.temp/project-ref`, then the project picker (interactive terminals only), then a not-linked
error. Database, storage and seed commands use it too. These scope adapters stay because their scope
differs: `link` skips the ref file, `branches` derives the parent project, `projects delete` prompts
for the project, and `projects list` and `services` read the ref for display only. Branch names and
UUIDs go through the one branch resolver on every command, the `config` family included.

### Announcing the target

A command that resolves a target announces it once on stderr, in every output format, and reports
the same identity as JSON `target`; [the command target doc](../../apps/cli/docs/command-target.md)
has the formats. A command with two database endpoints (`db diff --from`/`--to`) announces each in
resolution order, the local stack and a database URL included, and reports the first. The
announcement is best effort: it adds no API call and no auth requirement, and it never prints
credentials. Identity comes from `supabase/.temp/linked-project.json`, which can be stale or
missing, so it never proves a branch: "branch" is shown only on positive evidence (a branch lookup
by name or UUID, or a live probe), and anything else is the bare ref, `unverified` in JSON. A
project's default branch is production, not a preview branch: `--remote=<default branch>`, by name
or UUID, resolves to the production project, so the banner, the consent prompt and JSON
`environment: "production"` all say so, and a script that checks `environment` to stay away from
production sees it. A UUID looked up with no linked project cannot tell, so it stays `unverified`.

### Hosted-mutation consent

Every persistent mutation of a hosted resource in the `account`, `hosted` and `selectable` groups
needs consent. This includes writes through a non-local `--remote=<url>`: a loopback host on the
local or shadow database ports, or the local stack's endpoint, counts as local; anything else is
hosted.

- **Default.** It comes from the command's policy. Create-only operations default to Yes:
  `projects create`, `orgs create`, `branches create`, `domains create` and `bootstrap`. Everything
  that replaces or deletes live state, and all arbitrary SQL, migration, seed and storage writes,
  default to No.
- **Approval.** Only `--yes` or a `SUPABASE_YES` in the shell environment counts, and the
  confirmation line names which one. A `SUPABASE_YES` in the project `supabase/.env` does not,
  because the checkout must not pre-approve its collaborators' and agents' production writes. The
  compiled binary also loads `.env`, `.env.local` and `.env.$NODE_ENV[.local]` from the working
  directory into the environment, so when any of those files defines `SUPABASE_YES` at all, whatever
  its value, the environment's value is treated as the file's and a shell export needs `--yes` as
  well. The last `--yes` on the command line wins, and `SUPABASE_YES` is read only when `--yes`
  never appears: `--yes=false --yes` confirms and `--yes --yes=false` declines. A bare `--yes`
  followed by `false`, `no`, `off`, `0` or `n` reads as false, as the flag parser does.
- **No stdin.** The CLI never reads stdin for consent. A piped `y` does nothing.
- **Interactive only.** A prompt appears only for text output on an interactive stdout with a TTY
  stdin. JSON, stream-json, `-o json|yaml|toml|env`, agents (`--agent`, or an AI tool detected from
  the environment) and non-TTY runs fail with `HostedMutationConsentRequiredError` unless `--yes` is
  set. The error names the action and target, says why the run can't ask, and tells an agent to ask
  the user before passing `--yes`.
- **Decline.** A declined prompt fails with `HostedMutationDeclinedError` ("context canceled"). It
  replaces the per-command cancelled errors. `compute delete` keeps its typed-name confirmation
  through the same service.
- **One question.** A command asks once, listing everything it will do. `db push` covers roles,
  pending migrations, seeds and vault in one question. `functions deploy --prune` computes its
  prune candidates first, so deploy and prune are confirmed together. `config push` lists every
  resource that will change.
- **Ordering.** Consent comes after the target is resolved and the plan is known, and before the
  first persistent effect. That includes local file writes that precede a remote history update:
  declining the `db pull` or `pull` history update aborts before any file is written. A temporary
  login role may be created before consent. Removing a network ban may not: it needs `--yes` and the
  `HostedMutationConsent` token only the consent module constructs, and without `--yes` the command
  fails with `LinkedDbNetworkBannedError`. Its suggestion is to re-run with `--yes` or to run
  `supabase network-bans remove --remote=<ref>` with the ref of the project that failed, which need
  not be the linked one. Under `--yes`, a failed ban listing or removal fails the command with
  that error instead. This applies to reads too.
- **Reads never prompt.** `db query --read-only` is a read: it sends `read_only: true` to the
  Management API for a linked target, and runs the statement in a read-only transaction for a local
  or database URL target. It skips consent.
- **Exemptions.** A leaf that never asks declares `consent: "none"`. A `selectable` leaf must also
  give a `consentExemptReason`, because it can reach a hosted database: they are reads or write only
  local files (`db lint`, `db advisors`, `db dump`, `db diff`, `db schema declarative generate`,
  `gen types`, `storage ls`, `inspect *`, `migration fetch`, `migration list`). Other leaves with a
  reason are `login` (mints the caller's own token), `feedback add` (sending the message is the
  command's purpose), `domains reverify` (re-runs verification and changes no configuration),
  `telemetry disable` (a local preference), `notebooks pull` and the removed commands.
- **Consent-free operations.** A `consent: "none"` leaf may send a non-GET request only from a
  reviewed list: the temporary login role, network-ban removal during connection setup (token-gated
  as above), the network-ban list and the vanity-subdomain availability check, which are POSTs that
  only read, and DNS verification, which re-runs a check. `notebooks pull` alone may also create a
  notebook: it only creates, and asks through the same prompt check as consent before it does.
- **Local prompts.** An explicitly requested local reset does not prompt: `migration down` and
  `migration repair --all` lose their local prompts. Incidental resets, `stack destroy`, checkout
  overwrites and `storage rm` keep theirs. Local prompts still honour a project `.env`
  `SUPABASE_YES`.

## Rationale

The default now follows what a command can target, not who wrote the handler. A checkout reaches a
hosted database through a `selectable` command only when the invocation says `--remote`. The intent
is visible in the command line, so there is no per-checkout switch to forget or to inherit, and one
flag means the same thing on every command. Keeping the old flags as aliases through v3 gives
scripts, CI and agents the whole v3 line to move.

Consent is a rule about the person running the command. Taking it from flags and the shell
environment only, never from stdin or the checkout, means a script or an agent has to opt in
explicitly, and the opt-in is visible in its invocation. Defaulting replace-and-delete operations
to No makes the Enter key safe.

## Consequences

### Positive

- A command's default destination follows its group. The banner and the JSON `target` say where it
  went.
- One selector parser, one ref chain, one branch resolver and one consent service replace
  per-handler code.
- A hosted write cannot run before its confirmation, because consent is ordered before the first
  persistent effect and declining writes nothing.

### Negative

- Breaking changes in v3: the flipped defaults, including bare `db push`, `db pull` and
  `migration fetch`, which most people run meaning the linked project, and the new `--yes`
  requirement for unattended hosted writes. A bare run in a linked checkout prints a hint, and v2
  warns ahead of time.
- Anyone who followed the v2 warning and added `--linked` gets a second warning in v3 asking for
  `--remote`. v4 removes the aliases.
- `SUPABASE_YES` in `supabase/.env`, a piped `y` and `-o json` runs in a terminal no longer confirm
  hosted writes.
- Reads that hit a network ban now fail instead of clearing it.
- A hosted `db query` needs consent unless it is `--read-only`.
- `db reset`'s JSON `target` changes from a string to the `target` object.
- Declining the `db pull` or `pull` history update loses the "write the file only" path.
- Every command that resolves a target adds a stderr line. A ref the cache does not vouch for
  shows as the bare ref, and JSON reports it `unverified`.
- The cancelled-error tags are consolidated and new tags are added, so telemetry keyed on the old
  tags needs updating.

## Alternatives Considered

1. **Per-command defaults for the target and for consent**: keep each handler's choice and document
   it. This is the current state, and users cannot predict it. The group annotation declares both
   once.
2. **Default every `selectable` command to linked**: it reaches a hosted database from an
   unconfigured checkout.
3. **A workspace `target = "local" | "remote"` key**: it covers remote-first workflows, but the same
   command line then reaches different places in different checkouts, and every example needs a
   caveat. `--remote` states the intent where it applies.
4. **Keep `--linked`, `--db-url` and `--project-ref` as the flags**: three flags behave differently
   per command and none takes a branch name. `--remote` replaces them with one rule.
5. **Remove the old flags in v3**: it breaks working scripts in the same release that flips the
   defaults. They warn through v3 and go in v4.
6. **Honour `SUPABASE_YES` from the project `.env`**: convenient for CI, but a committed file would
   approve every collaborator's and agent's production writes. CI sets the variable in the shell.
7. **Prompt before removing a network ban**: reads must never prompt, and removal clears the ban for
   the whole project, not only the caller. The failure points at the command that does it on purpose.
8. **Accept a piped `y` as consent**: a piped stream is not a decision by the person running the
   command. A script that means to approve says so with `--yes`.

## Related Decisions

- [ADR 0004](0004-cli-design-goals-and-workflows.md): the safety model this decision amends.
- [ADR 0032](0032-config-value-precedence.md): config value precedence. This ADR supersedes its
  seed consent section.

## See Also

- [CLI config loading](../../packages/config/docs/cli-config-loading.md)
- [`apps/cli` agent rules](../../apps/cli/AGENTS.md)
