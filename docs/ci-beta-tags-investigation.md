# Why develop pushes recompute `2.99.0-beta.1` instead of advancing to `beta.2`

## TL;DR

The plan job in `.github/workflows/release.yml` runs `semantic-release --dry-run` with branch config `{ name: "develop", prerelease: "beta" }`. semantic-release internally normalizes that branch's `channel` to **the branch name** (`"develop"`), not to `"beta"`. The existing beta tags on origin (`v2.99.0-beta.1`, `v2.99.0-beta.2`) have no channel git-notes (the `success` step that writes them is skipped under dry-run + minimal plugin set), so they have `channels: [null]`. Neither `[null]` nor `["beta"]` matches the branch's `"develop"` channel, so `getLastRelease` filters them out and falls through to the highest stable tag (`v2.98.2`). Then `getNextVersion` for a `fix:`/`feat:` workload on a prerelease branch bumps `2.98.2 → 2.99.0` and re-applies `-beta.1` → the same `2.99.0-beta.1` is emitted on every push.

This is **not** the same root cause described in PR #5209's body. The "tag missing on origin" theory is wrong: the tag *is* on origin (created by `softprops/action-gh-release` in the GH-release step on the original publish run), and `getLastRelease` ignores it for a different reason.

## Reproducing the failure

Branch state (`develop @ ef1b13a7`, 2026-05-07):

- `v2.98.2`  → channels: `["latest"]` (note written by an older release run)
- `v2.99.0-beta.1` (sha `62509de5`) → channels: `[null]` (no note ever written)
- `v2.99.0-beta.2` (sha `ef1b13a7`) → channels: `[null]` (no note ever written)

`apps/cli/package.json` `release` section:

```json
{
  "branches": ["main", { "name": "develop", "prerelease": "beta" }],
  "plugins": ["@semantic-release/commit-analyzer"]
}
```

Running `semantic-release@24 --dry-run --no-ci` against this exact state:

```
Found git tag v2.98.2 associated with version 2.98.2 on branch develop
Found 111 commits since last release
Analysis of 111 commits complete: minor release
The next release version is 2.99.0-beta.1   ← wrong, should be 2.99.0-beta.2
```

Running the same with **only one config change** (`"channel": "beta"` added to the develop branch):

```json
{ "name": "develop", "prerelease": "beta", "channel": "beta" }
```

```
Found git tag v2.99.0-beta.1 associated with version 2.99.0-beta.1 on branch develop
Found 5 commits since last release
Analysis of 5 commits complete: patch release
The next release version is 2.99.0-beta.2   ← correct
```

(This was reproduced against a bare clone of `develop` with the legacy `refs/notes/semantic-release` channel note backfilled for `v2.99.0-beta.1`. Without the backfill, even the channel-fix run still falls back to `v2.98.2`, because no current beta tag has a channel note semantic-release can read.)

## Where the channel name comes from

`semantic-release/lib/branches/normalize.js`:

```js
export function prerelease({ prerelease }) {
  return prerelease.map(({ name, prerelease, channel, tags, ...rest }) => {
    const preid = prerelease === true ? name : prerelease;
    return {
      ...rest,
      channel: isNil(channel) ? name : channel,   // ← defaults to branch NAME, not preid
      type: "prerelease",
      name,
      prerelease: preid,
      tags,
    };
  });
}
```

For `{ name: "develop", prerelease: "beta" }`:

- `preid = "beta"` → `branch.prerelease` is set to `"beta"` (used for the prerelease label in the version)
- `channel = isNil(undefined) ? "develop" : undefined` → `branch.channel` is `"develop"` (used for tag-channel matching)

These are different identifiers. The version label is `beta`, but the channel name semantic-release matches against tag notes is `develop`.

## Where the filter rejects v2.99.0-beta.1

`semantic-release/lib/get-last-release.js`:

```js
const [{ version, gitTag, channels } = {}] = branch.tags
  .filter(
    (tag) =>
      ((branch.type === "prerelease" &&
        tag.channels.some((channel) => isSameChannel(branch.channel, channel)) &&
        semver.parse(tag.version).prerelease.includes(...)) ||
        !semver.prerelease(tag.version)) &&
      ...
  )
  .sort((a, b) => semver.rcompare(a.version, b.version));
```

For `branch.channel = "develop"` and `v2.99.0-beta.1` with `channels: [null]`:

- First clause (prerelease arm): `[null].some(c => isSameChannel("develop", c))` → `isSameChannel("develop", null)` is `false` → first clause `false`.
- Second clause (stable fallback): `!semver.prerelease("2.99.0-beta.1")` → `false`.
- Tag is filtered out.

The only tags that survive the filter are stable ones (matching the second clause). The highest stable is `v2.98.2`, which becomes `lastRelease`. `getNextVersion` for a prerelease branch then bumps `2.98.2` (minor, given the commits) and stamps `-beta.1` → `2.99.0-beta.1`.

## Why `dry_run: true` makes this self-perpetuating

In a normal semantic-release pipeline, the `success` step (driven by `@semantic-release/github` or similar) calls `addNote(...)` to write `{"channels": ["beta"]}` to `refs/notes/semantic-release-<tag>` and `git push origin refs/notes/semantic-release-<tag>`. Subsequent runs read that note in `getTagsNotes` and the channel match works.

This repo's `release.yml` runs the plan job with `dry_run: true` and only `@semantic-release/commit-analyzer` plugins, so no `success` step ever runs and no notes are ever written. Origin has notes for old tags up through `v2.98.2` (left over from an earlier full pipeline) but nothing for `v2.99.0-beta.1` or `v2.99.0-beta.2`.

```text
$ git for-each-ref refs/notes/ | grep -E "v2\.9[5-9]"
refs/notes/semantic-release-v2.95.0
…
refs/notes/semantic-release-v2.98.2
# (no v2.99.* entries)
```

## Why PR #5209's "Push version tag" step does not fix this

PR #5209 added an explicit `git push origin v${version}` step in `release-shared.yml` to guarantee the tag lands on origin even if `softprops/action-gh-release` fails. That's a useful guarantee, but it's not the bug here:

- The tag was already on origin before #5209 (created by `softprops/action-gh-release` on the original `2.99.0-beta.1` run at 2026-05-07T09:29:09Z).
- semantic-release's `getTags` finds it.
- `getLastRelease` discards it because of the channel name mismatch, regardless of whether the tag is on origin.

The PR's `should_release` decision logic and the `[warn] No packages were published` signal in `publish.ts` make the silent-no-op visible and make manual re-cut viable, but they don't change semantic-release's version computation.

## Fix options

### A. Config + per-tag channel note (smallest correct fix)

1. Add `"channel": "beta"` to the develop branch entry in `apps/cli/package.json`:
   ```json
   { "name": "develop", "prerelease": "beta", "channel": "beta" }
   ```
2. Add a step to `.github/workflows/release-shared.yml` (in the `publish` job, after the existing `Push version tag` step, gated to prerelease channels) that writes and pushes the channel note:
   ```sh
   note_ref="refs/notes/semantic-release-${tag}"
   git notes --ref="$note_ref" add -f -m "{\"channels\":[\"${channel}\"]}" "${tag}"
   git push origin "$note_ref"
   ```
   where `channel` is `"beta"` for the develop pipeline (`null`/no-op for stable on main, since main's tags don't need a channel note for the release branch's filter).
3. One-time backfill (admin step, outside this PR): write the channel note for `v2.99.0-beta.2` on origin so the very next push to develop sees a beta tag with a recognized channel and computes `2.99.0-beta.3`. Without this backfill, even with (1) and (2), the next push still falls back to `v2.98.2` because no current beta tag has a channel note.
   ```sh
   git fetch origin v2.99.0-beta.2
   git notes --ref=refs/notes/semantic-release-v2.99.0-beta.2 add -f \
     -m '{"channels":["beta"]}' v2.99.0-beta.2
   git push origin refs/notes/semantic-release-v2.99.0-beta.2
   ```

Verified locally that (1) alone is sufficient once any beta tag has a channel note; (2) ensures every future beta tag is annotated; (3) seeds the chain.

### B. Replace semantic-release in the plan job

Drop semantic-release from the plan job entirely and compute the next prerelease version with a small shell script that:

1. Lists `v*-beta.*` tags reachable from `HEAD`.
2. If the highest such tag points at `HEAD`, no release.
3. Otherwise, increment its prerelease counter (`2.99.0-beta.N → 2.99.0-beta.N+1`).

This sidesteps the channel-tracking machinery entirely and removes the `cycjimmy/semantic-release-action` + GH App token dependency from the plan job. Bigger change, but eliminates the class of bug.

### C. Run semantic-release without `dry_run`

Use the full `@semantic-release/github` (or `@semantic-release/git`) pipeline so the `success` step writes channel notes naturally. This is what PR #5209 explicitly listed as out-of-scope ("touches branch-protection, the GH App push token, and how main → develop fast-forwards interact with channel tracking — separate change").

## Recommendation

Take **A** in this PR — it's a one-line config fix plus a ~5-line workflow step, fully reproducible locally, with a clearly-scoped one-time backfill. It can be reviewed and reverted independently. **B** is a reasonable follow-up if the team wants to remove semantic-release from this path entirely, but it's not required to unstick beta numbering.

## Appendix: state at time of writing

- npm dist-tags: `latest=2.98.2`, `beta=2.99.0-beta.2`
- Origin tags: `v2.98.2`, `v2.99.0-beta.1`, `v2.99.0-beta.2`
- Origin channel notes: present for `v2.95.0` through `v2.98.2`; missing for `v2.99.0-beta.1` and `v2.99.0-beta.2`
- `v2.99.0-beta.2` was published via a manual `workflow_dispatch` re-cut (the path documented in PR #5209), not by a push event on develop.
