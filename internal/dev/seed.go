package dev

import (
	"context"
	"fmt"
	"os"
	"os/exec"

	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
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

// runInternalSeed uses the built-in SeedData from pkg/migration
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

	seeds, err := migration.GetPendingSeeds(
		s.ctx,
		utils.Config.Db.Seed.SqlPaths,
		conn,
		afero.NewIOFS(s.fsys),
	)
	if err != nil {
		return err
	}

	if len(seeds) == 0 {
		fmt.Fprintln(os.Stderr, "[dev] No pending seeds")
		return nil
	}

	return migration.SeedData(s.ctx, seeds, conn, afero.NewIOFS(s.fsys))
}
