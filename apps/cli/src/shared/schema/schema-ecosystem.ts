export const SCHEMA_ECOSYSTEM_MAPPING_HELP = `Coming from another tool:
  Prisma db pull                 →  schema pull
  Prisma db push                 →  schema apply
  Prisma migrate dev --create-only →  schema generate
  Prisma migrate deploy          →  migrations push
  Prisma migrate diff            →  schema generate --dry-run / migrations diff
  Drizzle Kit pull               →  schema pull
  Drizzle Kit push               →  schema apply
  Drizzle Kit generate           →  schema generate
  Drizzle Kit migrate            →  migrations apply / migrations push
  Convex dev                     →  schema apply
  Convex deploy                  →  migrations push
  Convex deployment select       →  explicit --from / --against per command`;

export const SCHEMA_PULL_NO_MERGE_HELP = `Pull does not merge SQL files. Use:
  --output <directory>  Export alongside the existing schema
  --force               Replace the complete managed schema and report changed paths`;
