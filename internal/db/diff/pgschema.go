package diff

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/go-errors/errors"
	pgschema "github.com/stripe/pg-schema-diff/pkg/diff"
)

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
	plan, err := pgschema.Generate(
		ctx,
		pgschema.DBSchemaSource(dbSrc),
		pgschema.DBSchemaSource(dbDst),
		pgschema.WithDoNotValidatePlan(),
		pgschema.WithIncludeSchemas(schema...),
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
