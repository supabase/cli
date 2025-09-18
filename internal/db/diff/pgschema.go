package diff

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	pgschema "github.com/stripe/pg-schema-diff/pkg/diff"
	"github.com/supabase/cli/internal/utils"
)

func DiffPgSchema(ctx context.Context, source, target pgconn.Config, schema []string, _ ...func(*pgx.ConnConfig)) (string, error) {
	dbSrc, err := sql.Open("pgx", utils.ToPostgresURL(source))
	if err != nil {
		return "", errors.Errorf("failed to open source database: %w", err)
	}
	defer dbSrc.Close()
	dbDst, err := sql.Open("pgx", utils.ToPostgresURL(target))
	if err != nil {
		return "", errors.Errorf("failed to open target database: %w", err)
	}
	defer dbDst.Close()
	// Generate DDL based on schema plan
	opts := []pgschema.PlanOpt{pgschema.WithDoNotValidatePlan()}
	if len(schema) > 0 {
		opts = append(opts, pgschema.WithIncludeSchemas(schema...))
	} else {
		opts = append(opts,
			pgschema.WithExcludeSchemas(managedSchemas...),
			pgschema.WithExcludeSchemas(
				"topology", // unsupported due to views
				"realtime", // unsupported due to partitioned table
				"storage",  // unsupported due to unique index
			),
		)
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
