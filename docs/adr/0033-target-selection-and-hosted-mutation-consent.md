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
truth for the default target and for the consent default.

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
uses. A value that matches no branch fails with link's error, which lists the branches. A branch
UUID also resolves in a checkout with no linked project. A URL applies only where the remote side is
Postgres: `storage`, `seed buckets` and `hosted` commands need a project and reject one. `hosted`
commands accept `--remote=<ref|branch>`, and bare `--remote` changes nothing for them. The linked
project comes from `SUPABASE_PROJECT_ID`, then the link file. `SUPABASE_PROJECT_ID` alone never
makes a `selectable` command remote; it is only a ref source once `--remote` is passed. An
unresolvable remote target fails. The CLI never falls back between local and remote.

`--remote=<value>` always parses. `--remote <value>` is rewritten to `--remote=<value>` before
parsing when the command takes no positional, when the token is a ref or URL, or when the command
already has more bare tokens than positionals. The one ambiguous shape, a bare `--remote` directly
followed by a token the command took as a positional, is checked against the linked project's
branches before anything runs. A token that exactly matches a branch, is within a small edit
distance of one, or can't be checked because the branch listing failed stops the run with an error
that offers both readings: `--remote=<word>` for the branch, `<word> --remote` for the operand. Any
other token runs as the command's operand.

### Deprecated aliases

`--linked`, `--project-ref`, `--db-url` and `gen types --project-id` stay through v3 as hidden
aliases. Each goes through the same resolver as the `--remote` form it maps to, prints a warning
that names that form, and says v4 removes it. `--local` is still accepted and does nothing, because
local is already the default; it warns the same way. v4 removes all of them, and `db diff`'s
`linked` value for `--from` and `--to`, which `remote` replaces.

A warning shows the command path, the command's operand placeholders and the `--remote`
replacement, last. It never repeats the user's operands or other flags, because they can be secrets
that a CI log would then keep:

```text
Warning: --project-ref is deprecated and will be removed in v4. Use --remote=<ref> instead: supabase secrets set <NAME=VALUE>... --remote=<ref>
```

### Selector rules

One parser (`parseTargetSelector`) backs every `selectable` command and maps the deprecated aliases
onto `--remote`:

- `--remote` and the aliases name one target and are never resolved by precedence.
  `--remote=<value>` together with an alias is an error, and so are two of `--remote`, `--linked`,
  `--db-url` and `--local`, or `--project-ref` with `--local` or `--db-url`.
- A bare `--remote` together with `--project-ref=<x>` is accepted, as `--linked --project-ref=<x>`
  is: the alias's value wins and its warning prints.
- `db diff` with `--remote` or an alias together with `--from` or `--to` is an error. In `--from`
  and `--to`, `remote` always means the linked project.
- `--no-remote` and `--remote=false` fail and tell the user to leave `--remote` out.
  `--remote yes`, `--remote 1`, `--remote true` and `--remote on` mean bare `--remote`.
- An empty `--remote=` value is rejected.
- `--password` is rejected unless the target is a project, meaning bare `--remote`, a ref or a
  branch.

### One project-ref chain

`ProjectRefResolver.resolveRef` is the only chain: `--remote=<ref>`, then `SUPABASE_PROJECT_ID`, then
`supabase/.temp/project-ref`, then the project picker (interactive terminals only), then a not-linked
error. Database, storage and seed commands use it too. These scope adapters stay because their scope
differs: `link` skips the ref file, `branches` derives the parent project, `projects delete` prompts
for the project, and `projects list` and `services` read the ref for display only. Branch names and
UUIDs go through the one branch resolver on every command, the `config` family included.

### The target banner and JSON `target`

A command that resolves a target prints one line on stderr per distinct target, in every output
format. It is best effort: it adds no API call and no auth requirement, and it never prints
credentials.

```text
Target: local stack (<host>:<port>)
Target: local stack (<host>:<port>) · default; pass --remote for <name> (<ref>)
Target: custom Postgres (<host>:<port>)
Target: project <name> (<ref>) · production
Target: project <parent name> (<parent ref>) · branch <name> (<ref>)
Target: project <ref>
Target: project <ref> (not the linked project)
```

On `hosted` commands the banner is the notice that the command is talking to a remote project, and
it names the linked project they default to. A bare `db push`, `db pull` or `migration fetch` in a
linked checkout runs locally and prints the `default; pass --remote` hint.

Project identity comes from `supabase/.temp/linked-project.json` with no API call. A cache that
names the resolved ref itself is a production project. The cache can be stale or missing, so it
never proves a branch: "branch" is shown only on positive evidence (a branch lookup by name or
UUID, or a live probe), and anything else is the bare ref, reported `unverified` in JSON. The branch
line names the parent project when the cache knows its name, and shows the parent ref otherwise.

A project's default branch is production, not a preview branch. `--remote=<default branch>`, by name
or UUID, resolves to the production project: the banner, the consent prompt and JSON
`environment: "production"` all say so, so a script that checks `environment` to stay away from
production sees it. The full table and the JSON shape live in
[the command target doc](../../apps/cli/docs/command-target.md).

JSON results carry the same information as `target`:

```text
{ kind: "local", host, port }
{ kind: "db-url", host, port }
{ kind: "linked", project_ref, project_name?, environment: "production" | "branch" | "unverified", parent_project_ref? }
```

It is merged into plain-object results, the stream-json result event and error envelopes. Arrays,
`-o json|yaml|toml|env` encodings and generated artifacts such as `gen types` output are unchanged.
A `target` the handler already owns wins, so `config diff` and `pull` keep their richer objects. A
command that announces two targets (`db diff --from remote --to <url>`) prints both and reports the
first in JSON.

### Help and docs

Help states each command's target from the same policy declaration, so labels cannot drift from
behaviour. A group's help labels each subcommand `[local or remote]` (`selectable`), `[local only]`
or `[remote only]` (`hosted`); account commands carry no label. A command's own help has a `TARGET`
section above `USAGE`, and its `remote` flag row reads `--remote[=<ref|branch|url>]` on a command
that takes a database URL and `--remote[=<ref|branch>]` on one that does not (`hosted` commands,
`storage`, `seed buckets`). JSON help carries the same information as `target`. Docs, examples, help and the deprecation warnings put `--remote` last, in the `=` form
when it has a value (`db pull add_profiles --remote`, `db push --remote=<ref>`), so it cannot be
read as anything else, and shell completion never offers a space-separated value for `--remote` on
a command that has a positional.

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
  directory into the environment, so a `SUPABASE_YES` that any of those files also defines with the
  same value is treated as the file's; a shell export of that value then needs `--yes` as well.
  `--yes=false` wins over the environment.
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
  login role may be created before consent. Removing a network ban may not: it needs `--yes`, and
  without it the command fails with `LinkedDbNetworkBannedError` pointing at
  `supabase network-bans remove`. This applies to reads too.
- **Reads never prompt.** `db query --read-only` is a read: it sends `read_only: true` to the
  Management API for a linked target, and runs the statement in a read-only transaction for a local
  or database URL target. It skips consent.
- **Exemptions.** A leaf that never asks declares `consent: "none"`. A `selectable` leaf
  must also give a `consentExemptReason`, enforced by the type of `withTargetPolicy` and by the tree
  test, because it can reach a hosted database: they are reads or write only local files (`db lint`,
  `db advisors`, `db dump`, `db diff`, `db schema declarative generate`, `gen types`, `storage ls`,
  `inspect *`, `migration fetch`, `migration list`). Other leaves with a reason are `login` (mints
  the caller's own token), `feedback add` (sending the message is the command's purpose),
  `domains reverify` (re-runs verification and changes no configuration), `telemetry disable` (a
  local preference), `notebooks pull` and the removed commands.
- **Consent-free operations.** The tree test lets a `consent: "none"` leaf call five non-GET
  operations: the temporary login role, network-ban removal during connection setup (token-gated as
  above), the network-ban list and the vanity-subdomain availability check, which are POSTs that
  only read, and DNS verification, which re-runs a check. A sixth, creating a notebook, is allowed
  for `notebooks pull` alone: it only creates, and asks through the same prompt check as consent
  before it does.
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

### Guardrails

- `withTargetPolicy` stores the policy as a command annotation and provides a `TargetPolicy`
  service. `resolveTarget` and `requireHostedMutationConsent` both require it, and it is not an
  allowed runtime service, so a command that resolves a target or asks for consent without a
  declared policy fails `tsc`. Handlers never pass a default.
- `HostedMutationConsent` is a branded token only the consent module constructs. Network-ban removal
  requires one.
- `target-policy.unit.test.ts` walks the command tree for every backend variant and fails when:
  - a leaf has no policy;
  - a `local-only`, `account` or `hosted` leaf declares `--local`, `--linked` or `--db-url`;
  - a `selectable` leaf lacks `--remote`;
  - a declared database-target default disagrees with the group;
  - a leaf with `consent: "none"` calls a non-GET operation outside the reviewed consent-free map;
  - a leaf named for a mutating verb has `consent: "none"` and no exemption reason;
  - a `selectable` leaf has `consent: "none"` and no exemption reason;
  - a leaf-scoped consent-free operation belongs to a leaf without an exemption reason.
- `code-structure.unit.test.ts` fails when:
  - `--remote`, `--local`, `--linked`, `--db-url` or `--project-id` is declared with a raw `Flag.*`
    outside the shared target flags;
  - the old per-command resolvers and defaults return;
  - network-ban removal is called outside connection setup and `network-bans remove`;
  - a handler prints its own `Connecting to local|remote database` line.
- Every leaf with `consent !== "none"` has a `describeHostedConsent` test. It runs seven cases:
  JSON without `--yes`, a piped `y`, a declined prompt, an agent in an interactive terminal,
  `--yes`, a shell `SUPABASE_YES`, and `SUPABASE_YES` only in `supabase/.env`. A coverage test
  requires the set of consent leaves to equal the set of leaves under test.

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
