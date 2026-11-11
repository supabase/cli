# Current v4 API Checkpoints

Reviewed against Effect 4.0.0 at upstream commit
[`6389d9ac6`](https://github.com/Effect-TS/effect/tree/6389d9ac64c0f62ccc8b575fb9afc65fc104e814).
Always inspect the consuming project's pinned version before applying these changes.

## Imports

Current v4 groups modules by domain without the prerelease `unstable` segment:

```ts
import { Config, Context, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import { SqlClient } from "effect/sql";
import { Rpc, RpcGroup } from "effect/rpc";
import { Atom } from "effect/reactivity";
import { TestClock } from "effect/testing";
```

Direct imports such as `effect/http/HttpClient` also work. Check `effect/package.json`
exports instead of mechanically moving every `@effect/*` package into `effect`:
platform adapters, framework integrations, SQL drivers, and `@effect/vitest` still
have separate packages. The root barrel does not re-export every domain module.

## Common Migration Traps

| Older API or assumption                              | Current v4                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Config.string`, `boolean`, `redacted`               | `Config.String`, `Boolean`, `Redacted`                                                 |
| `Config.mapOrFail`                                   | `Config.mapEffect`; failure must be `Config.ConfigError`                               |
| `effect/unstable/http`                               | `effect/http`                                                                          |
| Root `TestClock` import                              | `effect/testing`                                                                       |
| `Context.Tag` / `Effect.Service` service definitions | `Context.Service` plus explicit `Layer` implementations                                |
| `Effect.catchAll`                                    | `Effect.catch`; prefer `catchTag` for selected tagged errors                           |
| `Effect.fork` / `forkDaemon`                         | `Effect.forkChild` / `forkDetach`; prefer `forkScoped` for layer-owned work            |
| `Either`                                             | `Result`; inspect constructors and payload fields rather than just renaming the import |
| `Schema.makeEffect` failures are `SchemaError`       | Instance `schema.makeEffect` fails with `SchemaIssue.Issue`                            |

## Validation Boundaries

```ts
const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const config = Config.schema(Port, "PORT");
const constructed = Port.makeEffect(8080); // failure: SchemaIssue.Issue
const decoded = Schema.decodeUnknownEffect(Port)(8080); // failure: Schema.SchemaError
const wrapped = constructed.pipe(Effect.mapError((issue) => new Schema.SchemaError(issue)));
```

See `SCHEMA.md` for constructor defaults, wire decoding, and error handling;
`CONFIG.md` for provider-based configuration; and `TESTING.md` for virtual time.

## Upstream Sources

- [Package exports](https://github.com/Effect-TS/effect/blob/6389d9ac64c0f62ccc8b575fb9afc65fc104e814/packages/effect/package.json)
- [Generated v3-to-v4 migration reference](https://github.com/Effect-TS/effect/blob/6389d9ac64c0f62ccc8b575fb9afc65fc104e814/migration/v3-to-v4.md)
- [Schema migration guide](https://github.com/Effect-TS/effect/blob/6389d9ac64c0f62ccc8b575fb9afc65fc104e814/migration/schema.md)

Use source signatures and type-check representative call sites when updating this
skill. A name appearing in a source comment is not evidence that it is exported.
