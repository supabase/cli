# `supabase experimental workers` screencast

`workers.gif` records the whole worker lifecycle — `new`, `push`, `list`,
`status`, `delete` — driving the real CLI against a real Supabase project.

![supabase experimental workers](./workers.gif)

## Re-recording

Requires [`vhs`](https://github.com/charmbracelet/vhs) (`brew install vhs`), a
logged-in CLI, and a linked project. From the repository root:

```sh
pnpm exec turbo run supabase#build   # the tape records this checkout's binary
apps/cli/demo/setup.sh
vhs apps/cli/demo/workers.tape
```

`setup.sh` builds `.workdir/` — a pristine, linked project directory with a bare
`config.toml`, so the recording starts from the same state every time and shows
`experimental workers new` writing the first `[workers.<name>]` section. It
reuses whatever project this checkout is linked to; override with
`SUPABASE_PROJECT_REF`.

The tape ends by deleting the worker it deployed, so a completed recording
leaves the project as it found it. If a recording is interrupted, run
`apps/cli/demo/cleanup.sh` to remove the stray worker and the workdir.

## Notes

- The recording deploys to a live project, so `experimental workers list` also
  shows whatever else already exists there. Prune the project first if you want
  a clean table.
- `push` runs without `--wait`, which is why `list` and `status` show the worker
  as `building`: the command returns once the deploy is accepted and the
  server-side container build continues after it. Waiting for a real build would
  add minutes to the recording.
- The frame is sized around `experimental workers --help`, whose global-flag
  table is laid out at a fixed ~173 columns and does not reflow.
