package migration

import (
	"context"
	_ "embed"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgconn"
)

var (
	//go:embed scripts/dump_schema.sh
	dumpSchemaScript string
	//go:embed scripts/dump_data.sh
	dumpDataScript string
	//go:embed scripts/dump_role.sh
	dumpRoleScript string

	InternalSchemas = []string{
		"information_schema",
		"pg_*", // Wildcard pattern follows pg_dump
		// Initialised by supabase/postgres image and owned by postgres role
		"_analytics",
		"_realtime",
		"_supavisor",
		"auth",
		"extensions",
		"pgbouncer",
		"realtime",
		"storage",
		"supabase_functions",
		"supabase_migrations",
		// Owned by extensions
		"cron",
		"dbdev",
		"graphql",
		"graphql_public",
		"net",
		"pgmq",
		"pgsodium",
		"pgsodium_masks",
		"pgtle",
		"repack",
		"tiger",
		"tiger_data",
		"timescaledb_*",
		"_timescaledb_*",
		"topology",
		"vault",
	}
	// Data dump includes auth, storage, etc. for migrating to new project
	excludedSchemas = []string{
		"information_schema",
		"pg_*", // Wildcard pattern follows pg_dump
		// Owned by extensions
		// "cron",
		"graphql",
		"graphql_public",
		// "net",
		// "pgmq",
		"pgsodium",
		"pgsodium_masks",
		"pgtle",
		"repack",
		"tiger",
		"tiger_data",
		"timescaledb_*",
		"_timescaledb_*",
		"topology",
		"vault",
		// Managed by Supabase
		// "auth",
		"extensions",
		"pgbouncer",
		"realtime",
		// "storage",
		// "supabase_functions",
		"supabase_migrations",
		// TODO: Remove in a few version in favor of _supabase internal db
		"_analytics",
		"_realtime",
		"_supavisor",
	}
	reservedRoles = []string{
		"anon",
		"authenticated",
		"authenticator",
		"dashboard_user",
		"pgbouncer",
		"postgres",
		"service_role",
		"supabase_admin",
		"supabase_auth_admin",
		"supabase_functions_admin",
		"supabase_read_only_user",
		"supabase_realtime_admin",
		"supabase_replication_admin",
		"supabase_storage_admin",
		// Managed by extensions
		"pgsodium_keyholder",
		"pgsodium_keyiduser",
		"pgsodium_keymaker",
		"pgtle_admin",
	}
	allowedConfigs = []string{
		// Ref: https://github.com/supabase/postgres/blob/develop/ansible/files/postgresql_config/supautils.conf.j2#L10
		"pgaudit.*",
		"pgrst.*",
		"session_replication_role",
		"statement_timeout",
		"track_io_timing",
	}
)

type pgDumpOption struct {
	schema       []string
	keepComments bool
	excludeTable []string
	columnInsert bool
}

type DumpOptionFunc func(*pgDumpOption)

func WithSchema(schema ...string) DumpOptionFunc {
	return func(pdo *pgDumpOption) {
		pdo.schema = schema
	}
}

func WithComments(keep bool) DumpOptionFunc {
	return func(pdo *pgDumpOption) {
		pdo.keepComments = keep
	}
}

func WithColumnInsert(use bool) DumpOptionFunc {
	return func(pdo *pgDumpOption) {
		pdo.columnInsert = use
	}
}

func WithoutTable(table ...string) DumpOptionFunc {
	return func(pdo *pgDumpOption) {
		pdo.excludeTable = table
	}
}

func toEnv(config pgconn.Config) []string {
	return []string{
		"PGHOST=" + config.Host,
		fmt.Sprintf("PGPORT=%d", config.Port),
		"PGUSER=" + config.User,
		"PGPASSWORD=" + config.Password,
		"PGDATABASE=" + config.Database,
	}
}

type ExecFunc func(context.Context, string, []string, io.Writer) error

func DumpSchema(ctx context.Context, config pgconn.Config, w io.Writer, exec ExecFunc, opts ...DumpOptionFunc) error {
	var opt pgDumpOption
	for _, apply := range opts {
		apply(&opt)
	}
	env := toEnv(config)
	if len(opt.schema) > 0 {
		// Must append flag because empty string results in error
		env = append(env, "EXTRA_FLAGS=--schema="+strings.Join(opt.schema, "|"))
	} else {
		env = append(env, "EXCLUDED_SCHEMAS="+strings.Join(InternalSchemas, "|"))
	}
	if !opt.keepComments {
		env = append(env, "EXTRA_SED=/^--/d")
	}
	return exec(ctx, dumpSchemaScript, env, w)
}

func DumpData(ctx context.Context, config pgconn.Config, w io.Writer, exec ExecFunc, opts ...DumpOptionFunc) error {
	var opt pgDumpOption
	for _, apply := range opts {
		apply(&opt)
	}
	env := toEnv(config)
	if len(opt.schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(opt.schema, "|"))
	} else {
		env = append(env, "INCLUDED_SCHEMAS=*", "EXCLUDED_SCHEMAS="+strings.Join(excludedSchemas, "|"))
	}
	var extraFlags []string
	if opt.columnInsert {
		extraFlags = append(extraFlags, "--column-inserts", "--rows-per-insert 100000")
	}
	for _, table := range opt.excludeTable {
		escaped := quoteUpperCase(table)
		// Use separate flags to avoid error: too many dotted names
		extraFlags = append(extraFlags, "--exclude-table "+escaped)
	}
	if len(extraFlags) > 0 {
		env = append(env, "EXTRA_FLAGS="+strings.Join(extraFlags, " "))
	}
	return exec(ctx, dumpDataScript, env, w)
}

func quoteUpperCase(table string) string {
	escaped := strings.ReplaceAll(table, ".", `"."`)
	return fmt.Sprintf(`"%s"`, escaped)
}

func DumpRole(ctx context.Context, config pgconn.Config, w io.Writer, exec ExecFunc, opts ...DumpOptionFunc) error {
	var opt pgDumpOption
	for _, apply := range opts {
		apply(&opt)
	}
	env := append(toEnv(config),
		"RESERVED_ROLES="+strings.Join(reservedRoles, "|"),
		"ALLOWED_CONFIGS="+strings.Join(allowedConfigs, "|"),
	)
	if !opt.keepComments {
		env = append(env, "EXTRA_SED=/^--/d")
	}
	return exec(ctx, dumpRoleScript, env, w)
}
