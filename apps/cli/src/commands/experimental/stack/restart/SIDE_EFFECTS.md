# `supabase experimental stack restart`

Restarts an existing managed local stack while preserving its durable identity
and data. The command resolves the selected stack, loads its project
configuration, prepares artifacts, stops the existing owner, and starts the same
stack with that configuration. It never creates or destroys a stack.

`--stack` and `--stack-id` are mutually exclusive. Explicit ids use the
persisted project root when loading configuration. Legacy `-o/--output` is
rejected; use `--output-format json`.

Configuration and preparation failures happen before stop. A stop failure does
not trigger start. A start failure leaves the selected stack stopped and
recoverable under the same id.
