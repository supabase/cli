# Supabase OpenAPI Specification

This directory contains the OpenAPI specification for Supabase Management APIs.

`v1-openapi.yaml` is a committed snapshot of the upstream specification and is the input
`go generate` uses to build the Go [client](../pkg/api/client.gen.go) and
[types](../pkg/api/types.gen.go). `overlay.yaml` patches the specification on its way
through codegen, for shapes `oapi-codegen` cannot consume directly.

Committing the snapshot keeps codegen reproducible: `go generate` needs no network
access, and CI's `Codegen` check fails only when a pull request leaves `pkg/api` out of
sync with the snapshot. Upstream changes arrive through the
[API Sync workflow](../../../.github/workflows/cli-go-api-sync.yml), which refreshes the
snapshot and regenerates the client together in one pull request, so a spec change no
longer breaks unrelated pull requests.

## Updating the specification

The specification is generated from our NestJS middleware. `v1-openapi.yaml` is
refreshed from **staging** (`https://api.supabase.green/api/v1-yaml`) by the API
Sync workflow, so staging is the snapshot's authoritative upstream and the Go
client tracks the API as staging exposes it. The production release is viewable
as [Swagger UI](https://api.supabase.com/api/v1), which is useful for reading the
shipped API but is not what the snapshot is generated from -- expect it to lag
the snapshot.

Refreshing the snapshot by hand is rarely necessary, since API Sync does it
automatically. To pick up a change from local development before it reaches staging:

1. Update the snapshot

```bash
curl -fsSL -o api/v1-openapi.yaml http://127.0.0.1:8080/api/v1-yaml
```

2. Regenerate the Go client and API types

```bash
go generate
```

3. [Optional] Add [properties](https://swagger.io/docs/specification/basic-structure/) that NestJS does not generate to `overlay.yaml`
