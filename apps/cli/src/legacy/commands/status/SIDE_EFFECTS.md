# `supabase status`

## Files Read

| Path                             | Format | When                                     |
| -------------------------------- | ------ | ---------------------------------------- |
| `<workdir>/supabase/config.toml` | TOML   | always, to resolve project configuration |

## Files Written

| Path | Format | When |
| ---- | ------ | ---- |
| —    | —      | —    |

## API Routes

| Method | Path | Auth | Request body | Response (used fields) |
| ------ | ---- | ---- | ------------ | ---------------------- |
| —      | —    | —    | —            | —                      |

## Environment Variables

| Variable | Purpose | Required? |
| -------- | ------- | --------- |
| —        | —       | —         |

## Exit Codes

| Code | Condition                                     |
| ---- | --------------------------------------------- |
| `0`  | success — status displayed                    |
| `1`  | malformed config                              |
| `1`  | Docker daemon not running or connection error |

## Output

### `--output-format text` (Go CLI compatible)

Prints a table of service names, container IDs, images, and URLs.

```
         supabase local development setup is running.

         API URL: http://127.0.0.1:54321
     GraphQL URL: http://127.0.0.1:54321/graphql/v1
  S3 Storage URL: http://127.0.0.1:54321/storage/v1/s3
          DB URL: postgresql://postgres:postgres@127.0.0.1:54322/postgres
      Studio URL: http://127.0.0.1:54323
    Inbucket URL: http://127.0.0.1:54324
      JWT secret: super-secret-jwt-token-with-at-least-32-characters-long
        anon key: ...
service_role key: ...
   S3 Access Key: 625729a08b95bf1b7ff351a663f3a23c
   S3 Secret Key: 850181e4652dd023b7a98c58ae0d2d34bd487ee0ead3abe0
       S3 Region: local
```

### `--output-format json`

```json
{
  "API_URL": "http://127.0.0.1:54321",
  "DB_URL": "postgresql://...",
  "ANON_KEY": "...",
  "SERVICE_ROLE_KEY": "...",
  "JWT_SECRET": "...",
  "S3_ACCESS_KEY": "...",
  "S3_SECRET_KEY": "...",
  "S3_REGION": "local"
}
```

### `--output-format stream-json`

Not applicable.

## Notes

- `--override-name` flag overrides specific variable names in env output.
- `-o env` output format uses KEY=VALUE pairs.
- `-o json` output format uses a JSON object.
- `-o pretty` (default) uses the human-readable table format.
