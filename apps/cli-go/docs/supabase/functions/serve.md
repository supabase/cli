## supabase-functions-serve

Serve all Functions locally.

`supabase functions serve` command includes additional flags to assist developers in debugging Edge Functions via the v8 inspector protocol, allowing for debugging via Chrome DevTools, VS Code, and IntelliJ IDEA for example. Refer to the [docs guide](/docs/guides/functions/debugging-tools) for setup instructions.

1. `--inspect`
   * Alias of `--inspect-mode brk`.

2. `--inspect-mode [ run | brk | wait ]`
   * Activates the inspector capability.
   * `run` mode simply allows a connection without additional behavior. It is not ideal for short scripts, but it can be useful for long-running scripts where you might occasionally want to set breakpoints.
   * `brk` mode same as `run` mode, but additionally sets a breakpoint at the first line to pause script execution before any code runs.
   * `wait` mode similar to `brk` mode, but instead of setting a breakpoint at the first line, it pauses script execution until an inspector session is connected.

3. `--inspect-main`
   * Can only be used when one of the above two flags is enabled.
   * By default, creating an inspector session for the main worker is not allowed, but this flag allows it.
   * Other behaviors follow the `inspect-mode` flag mentioned above.

Additionally, the following properties can be customized via `supabase/config.toml` under `edge_runtime` section.

1. `inspector_port`
   * The port used to listen to the Inspector session, defaults to 8083.
2. `policy`
   * A value that indicates how the edge-runtime should forward incoming HTTP requests to the worker.
   * `per_worker` allows multiple HTTP requests to be forwarded to a worker that has already been created.
   * `oneshot` will force the worker to process a single HTTP request and then exit. (Debugging purpose, This is especially useful if you want to reflect changes you've made immediately.)
