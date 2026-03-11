# Start

Start the local Supabase development stack for local app development and testing.

## When to use

Run this before commands or application flows that depend on local Supabase services. Use foreground mode while actively working so you can watch startup and service state updates, or `--detach` when you want the stack to keep running in the background.

<!-- USAGE:START -->
<!-- USAGE:END -->

<!-- FLAGS:START -->
<!-- FLAGS:END -->

<!-- EXAMPLES:START -->
<!-- EXAMPLES:END -->

## Tips

- First run may take longer because required binaries and images are downloaded on demand.
- Use `--detach` for background daemon mode and `supabase stop` when you are done.
- Use repeated `--exclude` flags to skip optional services you do not need.
