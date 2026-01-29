package dev

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/parser"
)

// runSeed executes seeding based on configuration
func (s *Session) runSeed() error {
	seedConfig := &utils.Config.Dev.Seed

	if !seedConfig.IsEnabled() {
		return nil
	}

	// Custom command takes precedence
	if seedConfig.OnChange != "" {
		return s.runCustomSeed(seedConfig.OnChange)
	}

	// Internal seeding using [db.seed] config
	return s.runInternalSeed()
}

// runCustomSeed executes a custom seed command
func (s *Session) runCustomSeed(command string) error {
	fmt.Fprintf(os.Stderr, "[dev] Running seed: %s\n", utils.Aqua(command))

	cmd := exec.CommandContext(s.ctx, "sh", "-c", command)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Dir = utils.CurrentDirAbs

	return cmd.Run()
}

// runInternalSeed always executes seed files in dev mode.
// Unlike pkg/migration.SeedData which skips already-applied seeds (only updating the hash),
// this function always re-executes the SQL. This is the expected behavior for dev mode
// where users want their seed changes to be applied immediately.
func (s *Session) runInternalSeed() error {
	// Check if base seed config is enabled
	if !utils.Config.Db.Seed.Enabled {
		return nil
	}

	// Check if there are any seed paths configured
	if len(utils.Config.Db.Seed.SqlPaths) == 0 {
		return nil
	}

	config := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.Port,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}

	conn, err := utils.ConnectLocalPostgres(s.ctx, config)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	// Create seed table if needed (for hash tracking)
	if err := migration.CreateSeedTable(s.ctx, conn); err != nil {
		return err
	}

	// Get seed file paths from config
	seedPaths, err := utils.Config.Db.Seed.SqlPaths.Files(afero.NewIOFS(s.fsys))
	if err != nil {
		fmt.Fprintln(os.Stderr, "WARN:", err)
	}

	if len(seedPaths) == 0 {
		fmt.Fprintln(os.Stderr, "[dev] No seed files found")
		return nil
	}

	// For dev mode: always execute all seed files (don't use GetPendingSeeds)
	for _, seedPath := range seedPaths {
		fmt.Fprintf(os.Stderr, "Seeding data from %s...\n", seedPath)

		// Create seed file with hash
		seed, err := migration.NewSeedFile(seedPath, afero.NewIOFS(s.fsys))
		if err != nil {
			return err
		}

		// Always execute the seed SQL (not just update hash like SeedData does for dirty seeds)
		if err := executeSeedForDev(s.ctx, conn, seed, s.fsys); err != nil {
			return err
		}
	}

	return nil
}

// executeSeedForDev always executes the seed SQL and updates the hash.
// This differs from SeedFile.ExecBatchWithCache which skips SQL execution for "dirty" seeds.
func executeSeedForDev(ctx context.Context, conn *pgx.Conn, seed *migration.SeedFile, fsys afero.Fs) error {
	// Open and parse the seed file
	f, err := fsys.Open(seed.Path)
	if err != nil {
		return errors.Errorf("failed to open seed file: %w", err)
	}
	defer f.Close()

	lines, err := parser.SplitAndTrim(f)
	if err != nil {
		return errors.Errorf("failed to parse seed file: %w", err)
	}

	// Build batch: all SQL statements + hash update
	batch := pgx.Batch{}
	for _, line := range lines {
		batch.Queue(line)
	}
	// Update hash in seed_files table
	batch.Queue(migration.UPSERT_SEED_FILE, seed.Path, seed.Hash)

	if err := conn.SendBatch(ctx, &batch).Close(); err != nil {
		return errors.Errorf("failed to execute seed: %w", err)
	}

	return nil
}
