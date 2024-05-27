## supabase-functions-serve

Serve all Functions locally.

### Debugging Your Code

`supabase functions serve` command includes additional flags to assist developers in debugging using tools like `DevTools`.

1. `--inspect`
   * Alias of `--inspect-mode run`.

2. `--inspect-mode [ off | run | brk | wait ] (default off)`
   * Activates the inspector capability.
   * The port used to listen to the Inspector session can be overridden in `supabase/config.toml` via the `inspector_port` property in the `edge_runtime` section.
   * `run` mode simply allows a connection without additional behavior. It is not ideal for short scripts, but it can be useful for long-running scripts where you might occasionally want to set breakpoints.
   * `brk` mode same as `run` mode, but additionally sets a breakpoint at the first line to pause script execution before any code runs.
   * `wait` mode similar to `brk` mode, but instead of setting a breakpoint at the first line, it pauses script execution until an inspector session is connected.

3. `--inspect-main`
   * Can only be used when one of the above two flags is enabled.
   * By default, creating an inspector session for the main worker is not allowed, but this flag allows it.
   * Other behaviors follow the `inspect-mode` flag mentioned above.

4. `--policy [ per_worker | oneshot ] (default per_worker)`
   * A value that indicates how the edge-runtime should forward incoming HTTP requests to the worker.
   * `per_worker` allows multiple HTTP requests to be forwarded to a worker that has already been created.
   * `oneshot` will force the worker to process a single HTTP request and then exit. (Debugging purpose, This is especially useful if you want to reflect changes you've made immediately.)
