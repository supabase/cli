package fetch

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

func Run(ctx context.Context, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return err
	}
	if empty, err := afero.IsEmpty(fsys, utils.MigrationsDir); err != nil {
		return errors.Errorf("failed to read migrations: %w", err)
	} else if !empty {
		title := fmt.Sprintf("Do you want to overwrite existing files in %s directory?", utils.Bold(utils.MigrationsDir))
		if shouldOverwrite, err := utils.NewConsole().PromptYesNo(ctx, title, true); err != nil {
			return err
		} else if !shouldOverwrite {
			return errors.New(context.Canceled)
		}
	}
	result, err := fetchMigrationHistory(ctx, config, options...)
	if err != nil {
		return err
	}
	for _, r := range result {
		name := fmt.Sprintf("%s_%s.sql", r.Version, r.Name)
		path := filepath.Join(utils.MigrationsDir, name)
		contents := strings.Join(r.Statements, ";\n") + ";\n"
		if err := afero.WriteFile(fsys, path, []byte(contents), 0644); err != nil {
			return errors.Errorf("failed to write migration: %w", err)
		}
	}
	return nil
}

func fetchMigrationHistory(ctx context.Context, config pgconn.Config, options ...func(*pgx.ConnConfig)) ([]migration.MigrationFile, error) {
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	return migration.ReadMigrationTable(ctx, conn)
}
