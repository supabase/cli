package lint

import (
	"context"
	_ "embed"
	"fmt"
	"os"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/debug"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/check.sql
	checkSchemaScript string
)

func Run(ctx context.Context, schema []string, fsys afero.Fs) error {
	// Sanity checks.
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	if err := utils.AssertSupabaseDbIsRunning(); err != nil {
		return err
	}
	// Run lint script
	var opts []func(*pgx.ConnConfig)
	if viper.GetBool("DEBUG") {
		opts = append(opts, debug.SetupPGX)
	}
	url := fmt.Sprintf("postgresql://postgres:postgres@localhost:%d/postgres", utils.Config.Db.Port)
	if err := LintDatabase(ctx, url, schema, opts...); err != nil {
		return err
	}
	return nil
}

func LintDatabase(ctx context.Context, url string, schema []string, options ...func(*pgx.ConnConfig)) error {
	// Parse connection url
	config, err := pgx.ParseConfig(url)
	if err != nil {
		return err
	}
	// Apply config overrides
	for _, op := range options {
		op(config)
	}
	// Connect to database
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	// Enable plpgsql_check
	enable := "CREATE EXTENSION IF NOT EXISTS plpgsql_check;"
	if _, err := conn.Exec(ctx, enable); err != nil {
		return err
	}
	// Use prepared statements
	if _, err := conn.Prepare(ctx, "ps1", checkSchemaScript); err != nil {
		return err
	}
	batch := pgx.Batch{}
	for _, s := range schema {
		batch.Queue("ps1", s)
	}
	br := conn.SendBatch(ctx, &batch)
	defer br.Close()
	for _, s := range schema {
		fmt.Fprintln(os.Stderr, "Linting schema:", s)
		rows, err := br.Query()
		if err != nil {
			return err
		}
		for rows.Next() {
			v, err := rows.Values()
			if err != nil {
				return err
			}
			fmt.Println(v)
		}
		err = rows.Err()
		if err != nil {
			return err
		}
	}
	return nil
}
