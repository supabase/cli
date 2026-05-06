# Request Body Encoding

Internal reference for how `@supabase/api` models and encodes non-JSON request bodies.

## OpenAPI To SDK Mapping

The generator treats OpenAPI `type: "string"` plus `format: "binary"` as a binary input, not a text input.

The public SDK contract for binary request inputs is:

- `Uint8Array`
- `ArrayBuffer`
- `Blob`

`Uint8Array` is the canonical byte type across the SDK and tests.

`ArrayBuffer` and `Blob` are accepted for browser and runtime ergonomics.

Node `Buffer` is intentionally not part of the documented public contract. It still works in practice because `Buffer` is a subclass of `Uint8Array`, but we do not model or document it separately.

## Runtime Encoding Rules

Binary request inputs are normalized to `Uint8Array` before transport:

- `Uint8Array` passes through as-is
- `ArrayBuffer` becomes `new Uint8Array(...)`
- `Blob` is read into bytes

Multipart plain-object fields are not flattened. Object-valued parts such as `metadata` are JSON-stringified before being added to form data.

This means multipart request bodies can contain both:

- binary parts, represented by `Uint8Array | ArrayBuffer | Blob`
- structured JSON parts, represented by plain objects that become JSON text

## Current Non-JSON Request Shapes

The current Management API routes that rely on non-JSON request encoding are:

- `POST /v1/oauth/token`
  `application/x-www-form-urlencoded`
- `POST /v1/projects/{ref}/functions`
  `application/vnd.denoland.eszip`
- `PATCH /v1/projects/{ref}/functions/{function_slug}`
  `application/vnd.denoland.eszip`
- `POST /v1/projects/{ref}/functions/deploy`
  `multipart/form-data`

The generated SDK models those routes as:

- raw eszip body routes
  `body: Uint8Array | ArrayBuffer | Blob`
- multipart deploy route
  `body.file: Array<Uint8Array | ArrayBuffer | Blob>`
  and `body.metadata` remains a structured object
- OAuth token exchange
  remains object-based and urlencoded, not binary

## CLI Relationship

`@supabase/cli` should treat the SDK contract as the source of truth.

The CLI's job is to map user input onto these SDK types:

- raw binary `--body-file <path>` becomes `Uint8Array`
- raw binary `--body -` becomes `Uint8Array` from stdin
- multipart binary `--upload field=path` values become `Uint8Array`
- multipart structured fields passed with `--json` remain JSON objects

The CLI-specific UX and examples live in `apps/cli/docs/platform-command-generation.md`.

## Maintenance

When request-body behavior changes:

1. Update this document first
2. Update the CLI body-handling section in `apps/cli/docs/platform-command-generation.md`
3. Keep examples aligned with the request serialization tests in `packages/api` and the platform body parsing tests in `apps/cli`

If new non-JSON body kinds appear later, extend this document instead of creating route-specific notes.
