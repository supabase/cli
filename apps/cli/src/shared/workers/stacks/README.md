# Examples

Minimal deployable workers, one per way of packaging code for the lambda
backend. Each returns JSON that includes the `GREETING` secret (null until the
project has one), so the secret-rotation loop is visible in responses.

| Example      | Spec                                                                      | Notes                                                                                      |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `node`       | `{"runtime":"node","size":"2gb-1vcpu","exposure":"public","instances":1}` | catalog runtime; entry `index.mjs` exports `{ fetch }`                                     |
| `deno`       | `{"runtime":"deno","size":"2gb-1vcpu","exposure":"public","instances":1}` | catalog runtime; entry `main.ts` exports `{ fetch }`                                       |
| `dockerfile` | `{"size":"2gb-1vcpu","exposure":"public","instances":1}`                  | no `runtime`: the context carries its own Dockerfile; the app serves plain HTTP on `$PORT` |
