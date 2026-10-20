# Command target

Every command that acts on a database or hosted project announces the target it resolved, once, before it acts. The same identity goes to machine consumers as the JSON `target` object.

This page is the shared reference for how a command's target is chosen, which errors the selection raises, the deprecated selector flags, how a hosted write is confirmed, and what the banner and the JSON `target` carry. [ADR 0033](../../../docs/adr/0033-target-selection-and-hosted-mutation-consent.md) records why. The `SIDE_EFFECTS.md` of every `hosted`, `selectable` and `account` command opens with a `Target:` line that links here and lists only what is specific to that command: its own calls, files, exit codes and prompt, and any selector rule that differs from this page. A `local-only` command has no `Target:` line.

## Groups

The `Target:` line names the command's group and its consent default: `Target: <group>, consent default <No|Yes>`, or `Target: <group>, no consent` when the command never asks for hosted-mutation consent. A document that covers several subcommands gives each one's default.

| Group        | Acts on                         | With no `--remote` | Selector flags                                                               |
| ------------ | ------------------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `selectable` | a database or the Storage API   | the local stack    | `--remote`; deprecated `--local`, `--linked`, `--project-ref` and `--db-url` |
| `hosted`     | a hosted project                | the linked project | `--remote=<ref\|branch>`; deprecated `--project-ref`                         |
| `account`    | the account or an organisation  | no project         | none                                                                         |
| `local-only` | the local stack or the checkout | the local stack    | none                                                                         |

The consent default is the answer a confirmation starts on. It is `No` for anything that replaces or deletes live state and for arbitrary SQL, migration, seed and storage writes, and `Yes` for create-only operations (`projects create`, `orgs create`, `branches create`, `domains create` and `bootstrap`). `no consent` means the command never asks for hosted-mutation consent because it only reads or writes local files. It can still ask a local question of its own, such as `config pull` before it rewrites `config.toml` or `migration fetch` before it replaces local migrations.

## Choosing a target

| You pass            | Target                                                                          |
| ------------------- | ------------------------------------------------------------------------------- |
| nothing             | The local stack on a `selectable` command; the linked project on a `hosted` one |
| `--remote`          | The linked project                                                              |
| `--remote=<ref>`    | That project: 20 lowercase letters, never looked up as a branch                 |
| `--remote=<url>`    | That database: a `postgres://` or `postgresql://` URL                           |
| `--remote=<branch>` | A branch of the linked project, by name or UUID                                 |

- **The linked project** is `SUPABASE_PROJECT_ID`, else `supabase/.temp/project-ref`. With neither, an interactive terminal (stdin and stdout are TTYs and the output is text) gets the project picker (`GET /v1/projects`), and any other run fails with `ProjectRefNotLinkedError`. A malformed ref from either source fails with `InvalidProjectRefError`. `SUPABASE_PROJECT_ID` alone never makes a `selectable` command remote: it is a ref source once `--remote` is passed, and enough for the `default; pass --remote` hint. The CLI never falls back between local and remote.
- **A branch** resolves with the lookup `supabase link` uses (`GET /v1/projects/{parent}/branches`, where `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project), and the command acts on that branch's own project. With no linked project a UUID is looked up with `GET /v1/branches/{id}`, and one the API can't look up fails as ``Branch "<uuid>" not found. Run `supabase branches list` to see available branches.``, never as a schema error.
- **Hosted-only commands** take `--remote=<ref|branch>` for another project, and a bare `--remote` changes nothing for them. `link` takes its target as an argument and has no `--remote`. `branches *` commands act on a parent project, so their `--remote` takes a ref, never a branch name.
- **A database URL** applies only where the remote side is Postgres. `storage`, `seed buckets` and hosted commands need a project, so they reject `--remote=<url>` when the flags are parsed, as an invalid `--remote` value (`--remote takes a project ref or a branch name.`, or `--remote takes a project ref.` on `branches *`). The run exits 1 before anything else happens, and the URL is never echoed. A value with `://` that is not a `postgres://` or `postgresql://` URL, and a keyword connection string (`host=… user=…`), is rejected on every command and is never looked up as a branch.
- **`--remote=true|yes|on|1`** means a bare `--remote`. `--no-remote` and `--remote=false|no|off|0` fail with `--remote doesn't take false. Leave it out to <fallback>.`, and an empty `--remote=` with `--remote= has an empty value. Pass --remote for the linked project or --remote=<values>; leave it out to <fallback>.` `<fallback>` is `target the local database`, `target the local Storage API` or, on a hosted command, `use the linked project`; `<values>` is `<ref|branch|url>` where the command takes a database URL, `<ref|branch>` elsewhere and `<ref>` on `branches *`. Neither error prints the command's help.
- **A local stack that is down in a linked checkout.** A database command that defaults to the local stack and can't reach it adds `To use the linked project instead, pass --remote.` to its error's suggestion when the checkout is linked (`SUPABASE_PROJECT_ID` is set, or `supabase/.temp/project-ref` names a project). `gen types` adds it to its errors for a local database container that is missing or can't be inspected.

## `--remote <word>`

`--remote=<word>` always parses as a value. A bare `--remote` followed by a word is rewritten to `--remote=<word>` when the command takes no operands (a hidden one does not count), when the word is a database URL, or when the command already has more words than operands.

The one ambiguous shape is a bare `--remote` directly followed by a word the command took as an operand. It is settled before anything runs, and the error offers both readings:

- **A project-ref-shaped word** (20 lowercase letters) fails when the command still has room for operands, with no network call: pass `--remote=<ref>` for that project, or put `--remote` last to keep the word as an operand. It is read as `--remote=<ref>` only when the command takes no operands or its operands are already full.
- **Any other word** is checked against the branches of the linked project, when one is known. The run fails when the word names a branch, equals a branch name ignoring case, or is one edit from the name of a non-default branch of five or more characters; swapping two adjacent letters is one edit. The error offers `--remote=<branch>` for the branch, or the command's operands followed by `--remote` for the linked project. Otherwise the word runs as the operand. `--remote=<unknown>` is separate: its "Did you mean" suggestion allows up to two edits.
- **A listing that fails** still fails the run before anything runs, and the error gives the cause: `HTTP <status>`, the network error, or a missing or invalid access token. It never echoes the word, and its linked-project example reads `supabase <path> <operands> --remote`. The suggestion follows the cause: a `401` says to log in again, or to fix `SUPABASE_ACCESS_TOKEN` when the token came from the environment; a `403` says to use a token that can read the project's branches; a `404` says the linked ref may be a preview branch, so link its parent project.

## Selector errors

These fail with exit 1 before the command does any work:

| Condition                                                                                                 | Error                                                     |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| more than one of `--remote`, `--linked`, `--db-url` and `--local`, or `--project-ref` with `--project-id` | `TargetSelectorConflictError`                             |
| `--remote` given more than once with different values                                                     | `TargetSelectorConflictError`                             |
| `--project-ref` or `--project-id` with `--local`, `--db-url` or `--remote=<value>`                        | `TargetProjectRefConflictError`                           |
| an empty `--db-url`, `--project-ref` or `--project-id`                                                    | `TargetEmptyValueError`                                   |
| `--project-ref` or `--project-id` given a URL or connection string                                        | `TargetInvalidValueError`                                 |
| `--remote=<url>` on a command with no database connection                                                 | a flag-parse error: an invalid `--remote` value           |
| a branch name given to a `branches *` command                                                             | `TargetNeedsProjectError`                                 |
| a bare `--remote` followed by a project-ref-shaped word, or by a word that may name a branch              | `TargetRemoteAmbiguousError`                              |
| `--password` with `--remote=<url>` or the local default                                                   | `TargetPasswordConflictError`                             |
| `--remote=<branch>` naming no branch of the linked project                                                | `LinkBranchNotFoundError`                                 |
| a branch name with no linked project to search                                                            | `LinkBranchNotLinkedError`                                |
| linked state whose ref is malformed, so there is no project to search                                     | `LinkParentRefInvalidError`                               |
| a branch that has no project ref yet because it is still provisioning                                     | `LinkBranchNotReadyError`                                 |
| the branch lookup fails to reach the API or gets a non-200 status                                         | `LinkBranchListNetworkError`, `LinkBranchListStatusError` |

A selector conflict lists only the selector flags the command has: `Only one of --remote, --linked, --db-url and --local can be set; got …`, with the suggestion to use `--remote` or `--remote=<values>` on its own. A bare `--remote` together with `--project-ref=<x>` is accepted: the alias's value wins and its warning prints. A `false` switch counts as absent, so `--linked=false` selects nothing. A repeated `--remote` is one selection when every occurrence resolves to the same target, and a bare `--remote` is the linked project, so `--remote --remote` and `--remote=<ref> --remote=<ref>` run. When the occurrences differ the run fails before anything runs, with `--remote is given more than once with different values; pass it once.` and the suggestion to pass `--remote` once.

`LinkBranchNotFoundError` names the parent project, lists the branches it has, offers the nearest name as "Did you mean" and, for a word of lowercase letters, or a 20-letter word with an uppercase letter (which is still looked up as a branch and gets the lowercase spelling as a suggestion), notes that a project ref is exactly 20 lowercase letters. A `404` from the branch listing adds that the linked ref may itself be a preview branch and says to link its parent project.

## `--password`

`db dump`, `db pull`, `db push`, `db schema declarative generate`, `migration list`, `migration repair` and `migration squash` take `--password`, which applies only when the target is a project: a bare `--remote`, a ref or a branch. Anything else fails before the command runs, with `TargetPasswordConflictError`:

- `--remote=<url>`: `--password can't be used with --remote=<db-url>. Put the password in the connection string: postgres://USER:PASSWORD@HOST:PORT/postgres`
- the local default: `--password only applies to a linked project. The local database uses [db].password from supabase/config.toml.`, followed by `To use the linked project instead, pass --remote.` in a linked checkout.

A command's own `SIDE_EFFECTS.md` records where else its password can come from and when it is withheld from a target.

## Deprecated selector flags

`--linked`, `--project-ref`, `--db-url` and `--local` (and `gen types --project-id`) still work in v3 and are removed in v4, as is the `linked` value of `db diff --from` and `--to`, which `remote` replaces. Each goes through the same resolver as the `--remote` form it maps to and prints a warning on stderr in every output format, before the `Target:` line. The warning names only the replacement:

| Flag                  | The warning says                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--linked`            | `--linked is deprecated and will be removed in v4. Use --remote instead`                                                                                                     |
| `--project-ref=<ref>` | `--project-ref is deprecated and will be removed in v4. Use --remote=<ref> instead`, or `Use --remote=<branch> instead` when the value is a branch name                      |
| `--db-url=<url>`      | `--db-url is deprecated and will be removed in v4. Use --remote=<db-url> instead`, then `, or --remote=<ref> with an access token set` when the URL names a Supabase project |
| `--local`             | `--local isn't needed (local is the default) and will be removed in v4`                                                                                                      |

A warning never repeats an operand, a flag value or a database URL, because a CI log would keep them, and it carries no example command. Two values have their own wording: a branch whose name is a boolean literal (`true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0`) is reached with `--remote=<its ref or UUID>`, and a keyword `--db-url` connection string is converted to a `postgresql://` URL for `--remote=<url>`.

## Hosted-mutation consent

Every persistent mutation of a hosted resource asks for consent first, including a write through a non-local `--remote=<url>`. A loopback host on the local or shadow database ports, or the local stack's endpoint, counts as local.

- **Approval.** `--yes`, or a `SUPABASE_YES` in the shell environment. A `SUPABASE_YES` in a project `.env*` file does not count. The last `--yes` on the command line wins, and `SUPABASE_YES` is read only when `--yes` never appears, so `--yes=false --yes` confirms and `--yes --yes=false` declines. A bare `--yes` followed by `false`, `no`, `off`, `0` or `n` reads as false, as the flag parser does. Stdin is never read, so a piped `y` does nothing. The confirmation line names which one approved: `Confirmed by --yes: <action> on <target>`.
- **Prompt.** Only text output on an interactive stdout with a TTY stdin, with no agent driving, is asked. The question starts on the command's consent default.
- **Refusal.** JSON, stream-json, `-o json|yaml|toml|env`, agent and non-TTY runs fail with `HostedMutationConsentRequiredError` unless `--yes` is set. The error names the action and target, says why the run can't ask and tells an agent to ask the user before passing `--yes`. Nothing is changed.
- **Decline.** A declined prompt fails with `HostedMutationDeclinedError` (`context canceled`), exit 1, and nothing is changed.
- **One question.** A command asks once, after the plan is known and before the first persistent effect, and lists everything it will do.
- **Network bans.** Removing a network ban to connect needs `--yes` or a shell `SUPABASE_YES`; without one, the command fails with `LinkedDbNetworkBannedError`. Its suggestion is `Re-run with --yes to remove them, or run supabase network-bans remove --remote=<ref> --db-unban-ip <addrs> --experimental --yes.`, and `<ref>` is always the project whose bans blocked the connection, which after `db pull --remote=<other-ref>` is not the linked project. This applies to reads too.
- **Reads never prompt.** A command marked `no consent` never asks for hosted-mutation consent, on any target, and `--yes` and `SUPABASE_YES` have no effect on it. `db query --read-only` is a read and skips consent too.

## Banner

`Target: <text>` on stderr in every output format, printed once per distinct text. It is best effort: it adds no API call and no auth requirement, and it never prints credentials.

| Target                                | Text                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| Local stack                           | `local stack (<host>:<port>)`                                                       |
| Local stack, nothing selected, linked | `local stack (<host>:<port>) · default; pass --remote for <name> (<ref>)`           |
| `--remote=<url>`                      | `custom Postgres (<host>:<port>)`; the connection string's credentials never appear |
| Linked project the cache names        | `project <name> (<ref>) · production`                                               |
| Linked project nothing vouches for    | `project <ref>`, or `project <name> (<ref>)` when the project picker named it       |
| Ref other than the linked project     | `project <ref> (not the linked project)`                                            |
| Branch found by name or UUID          | `project <parent name> (<parent ref>) · branch <name> (<ref>)`                      |
| The project's default branch          | `project <name> (<ref>) · production`                                               |
| Branch UUID, no linked project        | `project <ref>`: the lookup does not say whether it is the default branch           |

On a `hosted` command the banner is the notice that the command is talking to a remote project, and it names the linked project the command defaults to. The `default; pass --remote` hint appears only when a project is linked, by `SUPABASE_PROJECT_ID` or the link file, and no `--remote` was passed; a bare `db push`, `db pull` or `migration fetch` in a linked checkout runs locally and prints it.

Identity comes from `supabase/.temp/linked-project.json`, with no API call. A cache that names the resolved ref itself marks a production project. The cache can be stale or missing, so it never proves a branch: "branch" is claimed only on positive evidence, which is a branch lookup by name or UUID or a live probe. A branch's parent shows as its bare ref when the cache doesn't know its name.

## JSON `target`

`json` and `stream-json` results carry `target`, tagged by `kind`:

| `kind`   | Fields                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local`  | `host`, `port`                                                                                                                                            |
| `db-url` | `host`, `port`                                                                                                                                            |
| `linked` | `project_ref`, `environment` (`production`, `branch` or `unverified`), optional `project_name`, optional `parent_project_ref` (a branch's parent project) |

`environment` is `production` when the linked-project cache names the resolved ref or the resolved branch is the project's default branch, `branch` on positive evidence of any other branch, and `unverified` otherwise, including a branch UUID looked up with no linked project. A failed identity check is `unverified`, never `branch`.

The first announced target becomes the run's `target`, so a command that announces two (`db diff --from=remote --to=<url>`) prints both and reports the first. `db diff --from`/`--to` announces every database endpoint in resolution order, the local stack and a database URL included, so `--from local` reports `{"kind":"local","host":"127.0.0.1","port":54322}`; `migrations` announces nothing, and the same target on both sides prints one line. It is merged into object results, the `stream-json` result event and the machine error envelope. Arrays, `--output {json,yaml,toml,env}` payloads and generated artifacts such as `gen types` output are unchanged. A command that owns extra `target` fields (for example `branch`, `local_scope`, or `config push`'s `environment`) adds them in front of the announced identity's, and its own values win on a clash.

The schema is `CommandTargetJson` in `src/shared/output/command-target.service.ts`; every target is encoded through it before it reaches output.

## Help and docs

A group's help labels each subcommand `[local or remote]` (`selectable`), `[remote only]` (`hosted`) or `[local only]`; `account` and removed commands carry no label. A command's own help has a `TARGET` section above `USAGE`, and its `--remote` row reads `--remote[=<ref|branch|url>]` where the command takes a database URL, `--remote[=<ref|branch>]` where it doesn't, and `--remote[=<ref>]` on `branches *`. JSON help gives the `remote` flag `value` and `valueOptional` fields in place of the bracketed name.

Docs and examples put `--remote` last, in the `=` form when it has a value (`db pull add_profiles --remote`, `db push --remote=<ref>`), so it cannot be read as anything else. Shell completion never offers a space-separated value for `--remote` on a command that takes operands.
