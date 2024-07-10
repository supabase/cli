package repair

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

const (
	Applied  = "applied"
	Reverted = "reverted"
)

var ErrInvalidVersion = errors.New("invalid version number")

func Run(ctx context.Context, config pgconn.Config, version []string, status string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	for _, v := range version {
		if _, err := strconv.Atoi(v); err != nil {
			return errors.Errorf("failed to parse %s: %w", v, ErrInvalidVersion)
		}
	}
	repairAll := len(version) == 0
	if repairAll {
		msg := "Do you want to repair the entire migration history table to match local migration files?"
		if shouldRepair, err := utils.NewConsole().PromptYesNo(ctx, msg, false); err != nil {
			return err
		} else if !shouldRepair {
			return errors.New(context.Canceled)
		}
		local, err := list.LoadLocalVersions(fsys)
		if err != nil {
			return err
		}
		version = append(version, local...)
	}
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// Update migration history
	if err = UpdateMigrationTable(ctx, conn, version, status, repairAll, fsys); err == nil {
		utils.CmdSuggestion = fmt.Sprintf("Run %s to show the updated migration history.", utils.Aqua("supabase migration list"))
	}
	return err
}

func UpdateMigrationTable(ctx context.Context, conn *pgx.Conn, version []string, status string, repairAll bool, fsys afero.Fs) error {
	if err := migration.CreateMigrationTable(ctx, conn); err != nil {
		return err
	}
	// Data statements don't mutate schemas, safe to use statement cache
	batch := &pgx.Batch{}
	if repairAll {
		batch.Queue(migration.TRUNCATE_VERSION_TABLE)
	}
	switch status {
	case Applied:
		for _, v := range version {
			f, err := NewMigrationFromVersion(v, fsys)
			if err != nil {
				return err
			}
			batch.Queue(migration.INSERT_MIGRATION_VERSION, f.Version, f.Name, f.Statements)
		}
	case Reverted:
		if !repairAll {
			batch.Queue(migration.DELETE_MIGRATION_VERSION, version)
		}
	}
	if err := conn.SendBatch(ctx, batch).Close(); err != nil {
		return errors.Errorf("failed to update migration table: %w", err)
	}
	if !repairAll {
		fmt.Fprintf(os.Stderr, "Repaired migration history: %v => %s\n", version, status)
	}
	return nil
}

func GetMigrationFile(version string, fsys afero.Fs) (string, error) {
	path := filepath.Join(utils.MigrationsDir, version+"_*.sql")
	matches, err := afero.Glob(fsys, path)
	if err != nil {
		return "", errors.Errorf("failed to glob migration files: %w", err)
	}
	if len(matches) == 0 {
		return "", errors.Errorf("glob %s: %w", path, os.ErrNotExist)
	}
	return matches[0], nil
}

func NewMigrationFromVersion(version string, fsys afero.Fs) (*migration.MigrationFile, error) {
	name, err := GetMigrationFile(version, fsys)
	if err != nil {
		return nil, err
	}
	return migration.NewMigrationFromFile(name, afero.NewIOFS(fsys))
}
