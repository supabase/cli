# 0020. Config naming vocabulary: `CliConfig`, `ProjectConfig`, `CliSettings`, and the `Cli*` prefix rule

**Status**: accepted
**Date**: 2026-08-24

## Problem Statement

Before CLI-2235 (PR supabase/cli#6328), the config vocabulary had already drifted once, silently.
`CliConfig` named the CLI's own runtime settings service — platform `apiUrl`, access token,
telemetry flags, `supabaseHome` — what this decision now calls `CliSettings`. `ProjectConfig` named
the config-file document (`supabase/config.toml`/`.json`), the full local superset the CLI reads and
writes — what this decision now calls `CliConfig`. Neither name meant what its own words suggest,
and nothing recorded that either meaning had been chosen on purpose; the collision surfaced only
when CLI-2230 needed to introduce a genuinely new, third thing and no name was left to give it —
the rename CLI-2235 executed is what freed one.

That third thing is a hosted-project subset. `config diff` (CLI-2156), `config pull` (CLI-2064), and
Studio's own drift detection all need a shape that describes what a Supabase project looks like on
the platform — a sparse overlay of the hosted sections (`api`, `auth`, `db`, `realtime`, `storage`,
`workers`, `experimental`), never the full document with local-only sections stripped out and
defaults applied. CLI-2230 introduced that mapping (`toProjectConfig`, exported from
`@supabase/config`'s root entrypoint; PR supabase/cli#6339). Studio is already an external
consumer: supabase/supabase#48906 builds Studio's config-drift page against the shapes this
package publishes.

The renames CLI-2235 made were free only because `packages/config` is still `private: true`; nothing
outside this monorepo could have imported the old names. CLI-2169 will flip the package to `public`,
and every rename after that point breaks a real external consumer instead of nothing. Once that
window closes, a name chosen carelessly — or left undocumented, the way `CliConfig`/`ProjectConfig`
were before this decision — is a breaking change to fix, not a search-and-replace. Recording the
vocabulary now, while it is still free to fix, is the point of this ADR.

## Decision

This decision fixes three names and one prefix rule as the settled vocabulary for `@supabase/config`
and its CLI consumer:

| Name            | Meaning                                                                                                                                                                                                                                                  | Owner              |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `CliConfig`     | The full config-file document (`supabase/config.toml`/`.json`) — the local superset, including local-only sections (`studio`, ports, `edge_runtime`, `analytics`, `[remotes.*]`, …).                                                                     | `@supabase/config` |
| `ProjectConfig` | The hosted-project subset: a sparse overlay of the hosted sections (`api`, `auth`, `db`, `realtime`, `storage`, `workers`, `experimental`) describing what a Supabase project looks like on the platform. Introduced by CLI-2230 (PR supabase/cli#6339). | `@supabase/config` |
| `CliSettings`   | The CLI's own runtime settings — platform `apiUrl`, access token, telemetry flags, `supabaseHome`, ….                                                                                                                                                    | `apps/cli`         |

Prefix rule: `Cli*` names the local checkout side — what the CLI reads, writes, or resolves about
itself on disk. A bare `Project*` name is reserved for the hosted Supabase project. Helpers that
operate on config values follow the config family regardless of their inputs, not the shape of
whatever they're passed — `resolveCliConfigValue` and `CliConfigParseError` are `Cli*`-named even
though one resolves a config value and the other reports a parse failure, because in both cases the
config in question is the local-checkout document.

This convention is documented normatively in three places, so it is available wherever a session —
human or agent — starts working in this repo:

- repo-root `AGENTS.md`, in a "Config Naming Vocabulary" section
- `packages/config/README.md`, in a "Naming" section
- `packages/config/docs/cli-config-loading.md`, in its "Vocabulary" section

ADRs 0000–0019 are historical records of the decisions made at the time and are not rewritten to
reflect this vocabulary. ADR 0009 and ADR 0018 each carry a 2026-08-25 addendum mapping their
pre-rename symbol names — their own `ProjectConfig*`-prefixed exports — onto the settled
`CliConfig*` names; a reader applies those mappings when reading the ADR body, rather than the ADR
text itself being rewritten in place.

## Rationale

- Record-now-or-drift-again: the vocabulary already drifted once, silently, with no ADR to catch it;
  the only fix available after CLI-2169 publishes is a breaking rename, so the cost of not recording
  this now only increases with time.
- The private-to-public publish window (CLI-2169) is the real deadline: every day `packages/config`
  stays private is a day these names can still change for free.
- Both humans and agents load `AGENTS.md` at the start of a session, not any individual ADR, so the
  convention has to live where sessions start, not only in a decision record consulted by whoever
  happens to remember it exists.

## Consequences

### Positive

- A single documented meaning per name removes the ambiguity that let `CliConfig`/`ProjectConfig`
  drift once already.
- The convention lives in three places that are actually read at the point of use — `AGENTS.md` at
  session start, the package `README.md` and `cli-config-loading.md` when working directly in
  `@supabase/config` — rather than only in an ADR.
- The `Cli*`/bare `Project*` prefix rule generalizes past these three names, giving future symbols
  (helpers, error classes, services) a rule to apply instead of a name to look up case by case.

### Negative

- One more pair of names to keep straight for anyone new to the codebase, on top of the pre-existing
  `CliConfig`/`ProjectConfig` collision history they may need to unlearn if they've seen the old
  meanings elsewhere.
- ADR 0009 and ADR 0018 stay unrewritten with their pre-rename names; a reader who doesn't notice
  the addendum before reading either ADR's body will read stale symbol names.
- `ProjectConfig` is not implemented as of this decision — CLI-2230 is still in flight — so the name
  is reserved in documentation ahead of the exports landing, and a reader can find the name before
  finding it in code.

## Alternatives Considered

1. **Leave the convention in PR history only** (CLI-2235's PR description/commits): rejected. The
   vocabulary drifted once already without anyone deciding to drift it; PR history is not consulted
   before naming a new symbol, so nothing here would have prevented a second drift.
2. **Defer the renames until after `packages/config` publishes**, once every affected name is known
   for certain: rejected. Renames are free only before publish (CLI-2169); waiting converts every
   one of them from a search-and-replace into a breaking change for Studio and any other external
   consumer.
3. **Keep `ProjectConfig` naming the document and coin a longer name for the hosted subset**:
   rejected. A bare `Project*` name should read as the hosted Supabase project, not the local
   checkout, and the document is genuinely CLI-side — it carries sections (`studio`, ports,
   `edge_runtime`, `analytics`, `[remotes.*]`) that only make sense for a local checkout and have no
   hosted-project meaning at all — so `ProjectConfig` is the wrong bare name for it even before the
   collision history is considered.

## Related Decisions

- [ADR 0009](0009-configuration-schema-and-validation.md): Configuration Schema & Validation — the
  entrypoint architecture whose document-schema symbols this decision's `CliConfig` name applies to;
  carries a CLI-2235 addendum mapping its `ProjectConfig*` symbols.
- [ADR 0018](0018-sparse-config-subtraction.md): Sparse Config Subtraction — the subtraction core
  whose symbols this decision's `CliConfig` name applies to; carries a CLI-2235 addendum mapping its
  `ProjectConfig*` symbols.
- [ADR 0019](0019-config-api-response-passthrough.md): Raw API-Response Passthrough — the ADR that
  first assigns `ProjectConfig` its hosted meaning (`_apiResponse` is attached to API-sourced
  `ProjectConfig` values); this decision generalizes that assignment into the settled vocabulary.

## See Also

- [`packages/config/docs/cli-config-loading.md`](../../packages/config/docs/cli-config-loading.md)
- [`packages/config/README.md`](../../packages/config/README.md)
- CLI-2235 (PR supabase/cli#6328) — the rename that surfaced the collision this ADR records
- CLI-2230 (PR supabase/cli#6339) — introduces `ProjectConfig`/`toProjectConfig`
- CLI-2238 — this ticket
- supabase/supabase#48906 — Studio's drift-detection work, waiting on the published package

## Addendum (2026-08-26): family-neutral names for cross-family operands (`EffectiveConfig`)

CLI-2230's implementation surfaced the prefix rule's one deliberate exception. The operand type of
the sparse comparison core (`subtractCliConfig`/`omitDefaultValues`) accepts both families — the
`CliConfig` document and the sparse `ProjectConfig` overlay — so either prefix would misdescribe
it. CLI-2230 names it `EffectiveConfig` (`DeepPartial<Omit<CliConfig, "remotes">>`, exported from
the pure entrypoint) and deleted the former `BaseCliConfig` export, whose `Cli*` name wrongly
claimed the local-checkout side for a type that `ProjectConfig` values must also satisfy. The
general rule: a symbol that genuinely spans both families takes a family-neutral name rather than
a misleading prefix. Ruled on CLI-2230 (2026-08-26); ADR 0018 carries a sibling addendum from
that work.
