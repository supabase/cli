# Examples

Minimal deployable compute, one per way of packaging code for the lambda
backend, plus `actions-runner`, which is a working service rather than a
greeting. Each runtime directory is discovered by
`compute-stacks.macro.ts` and scaffolded verbatim by `compute new`; adding a
runtime here means adding it to `COMPUTE_RUNTIMES` too, which the macro checks
at build time. The three hello-world examples each return JSON that includes the `GREETING`
secret (null until the project has one), so the secret-rotation loop is visible
in responses; `actions-runner` serves its own state instead.

| Example          | Spec                                                                      | Notes                                                                                                           |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `node`           | `{"runtime":"node","size":"2gb-1vcpu","exposure":"public","instances":1}` | catalog runtime; entry `index.mjs` exports `{ fetch }`                                                          |
| `deno`           | `{"runtime":"deno","size":"2gb-1vcpu","exposure":"public","instances":1}` | catalog runtime; entry `main.ts` exports `{ fetch }`                                                            |
| `dockerfile`     | `{"size":"2gb-1vcpu","exposure":"public","instances":1}`                  | no `runtime`: the context carries its own Dockerfile; the app serves plain HTTP on `$PORT`                      |
| `actions-runner` | `{"size":"2gb-1vcpu","exposure":"private","instances":1}`                 | no `runtime`, like `dockerfile`; registers self-hosted GitHub Actions runners and scaffolds its own `README.md` |
