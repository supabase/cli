package diff

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	pgschema "github.com/stripe/pg-schema-diff/pkg/diff"
)

var managedSchemas = append([]string{
	"pg_catalog",
	// Owned by extensions
	"cron",
	"graphql",
	"graphql_public",
	"net",
	"pgmq",
	"pgroonga",
	"pgtle",
	"repack",
	"tiger",
	"tiger_data",
	"topology",
	"vault",
	// Deprecated extensions
	"pgsodium",
	"pgsodium_masks",
	"timescaledb_experimental",
	"timescaledb_information",
	"_timescaledb_cache",
	"_timescaledb_catalog",
	"_timescaledb_config",
	"_timescaledb_debug",
	"_timescaledb_functions",
	"_timescaledb_internal",
	// Managed by Supabase
	"auth",
	"extensions",
	"pgbouncer",
	"realtime",
	"storage",
	"supabase_functions",
	"supabase_migrations",
}, localSchemas...)

func DiffPgSchema(ctx context.Context, source, target string, schema []string) (string, error) {
	dbSrc, err := sql.Open("pgx", source)
	if err != nil {
		return "", errors.Errorf("failed to open source database: %w", err)
	}
	defer dbSrc.Close()
	dbDst, err := sql.Open("pgx", target)
	if err != nil {
		return "", errors.Errorf("failed to open target database: %w", err)
	}
	defer dbDst.Close()
	// Generate DDL based on schema plan
	opts := []pgschema.PlanOpt{pgschema.WithDoNotValidatePlan()}
	if len(schema) > 0 {
		opts = append(opts, pgschema.WithIncludeSchemas(schema...))
	} else {
		opts = append(opts, pgschema.WithExcludeSchemas(managedSchemas...))
	}
	plan, err := pgschema.Generate(
		ctx,
		pgschema.DBSchemaSource(dbSrc),
		pgschema.DBSchemaSource(dbDst),
		opts...,
	)
	if err != nil {
		return "", errors.Errorf("failed to generate plan: %w", err)
	}
	var lines []string
	for _, stat := range plan.Statements {
		for _, harzard := range stat.Hazards {
			lines = append(lines, fmt.Sprintf("-- %s", harzard))
		}
		lines = append(lines, fmt.Sprintf("%s;\n", stat.DDL))
	}
	return fmt.Sprintln(strings.Join(lines, "\n")), nil
}
