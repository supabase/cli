## supabase-functions-serve

Serve all Functions locally.

### Debugging Your Code

`supabase functions serve` command includes additional flags to assist developers in debugging using tools like `DevTools`. These flags are simple switches that can be used without extra input.

However, these three flags are mutually exclusive, and only one can be selected.

Note that the `--inspect-main` flag must be used in conjunction with one of these three flags.

1. `--inspect`
   * Activates the inspector capability.
   * Simply allows a connection without additional actions.
   * Not ideal for short scripts, but can be useful for long-running scripts where you might occasionally want to set breakpoints.

2. `--inspect-brk`
   * Functions the same as `--inspect`, but additionally sets a breakpoint at the first line to pause script execution before any code runs.

3. `--inspect-wait`
   * Similar to `--inspect-brk`, but instead of setting a breakpoint at the first line, it pauses script execution until an inspector session is connected.

#### Additional Flag
* `--inspect-main`
  * Can only be used when one of the above three flags is enabled.
  * By default, creating an inspector session for the main worker is not allowed, but this flag allows it.
  * Other behaviors follow the chosen flag among the three mentioned above.