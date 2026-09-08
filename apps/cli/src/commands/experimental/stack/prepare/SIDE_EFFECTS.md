# `experimental stack prepare`

## Reads

- Reads `supabase/config.toml` from the selected project root.
- Reads the selected stack descriptor and state when `--stack-id` addresses an existing stack.
- Reads or downloads the artifact inputs for the selected capabilities.

## Writes

- Creates a durable stack descriptor and state when a named or current project stack is created.
- Writes prepared runtime artifacts to the stack artifact cache.
- Does not start, stop, destroy, or otherwise activate the stack.

## Network and subprocesses

- May access the container registry when preparing a Docker runtime.
- May download native runtime artifacts.
- May invoke the configured runtime tooling through the stack package.
