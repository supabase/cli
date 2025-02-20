package test

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	cliConfig "github.com/supabase/cli/pkg/config"
)

const (
	ENABLE_PGTAP  = "create extension if not exists pgtap with schema extensions"
	DISABLE_PGTAP = "drop extension if exists pgtap"
)

func Run(ctx context.Context, testFiles []string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Build test command
	cmd := []string{"pg_prove", "--ext", ".pg", "--ext", ".sql", "-r"}
	for _, fp := range testFiles {
		relPath, err := filepath.Rel(utils.DbTestsDir, fp)
		if err != nil {
			return errors.Errorf("failed to resolve relative path: %w", err)
		}
		cmd = append(cmd, relPath)
	}
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
	// Mount tests directory into container as working directory
	srcPath, err := filepath.Abs(utils.DbTestsDir)
	if err != nil {
		return errors.Errorf("failed to resolve absolute path: %w", err)
	}
	dstPath := "/tmp"
	binds := []string{fmt.Sprintf("%s:%s:ro", srcPath, dstPath)}
	// Enable pgTAP if not already exists
	alreadyExists := false
	options = append(options, func(cc *pgx.ConnConfig) {
		cc.OnNotice = func(pc *pgconn.PgConn, n *pgconn.Notice) {
			alreadyExists = n.Code == pgerrcode.DuplicateObject
		}
	})
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, ENABLE_PGTAP); err != nil {
		return errors.Errorf("failed to enable pgTAP: %w", err)
	}
	if !alreadyExists {
		defer func() {
			if _, err := conn.Exec(ctx, DISABLE_PGTAP); err != nil {
				fmt.Fprintln(os.Stderr, "failed to disable pgTAP:", err)
			}
		}()
	}
	// Use custom network when connecting to local database
	// disable selinux via security-opt to allow pg-tap to work properly
	hostConfig := container.HostConfig{Binds: binds, SecurityOpt: []string{"label:disable"}}
	if utils.IsLocalDatabase(config) {
		config.Host = utils.DbAliases[0]
		config.Port = 5432
	} else {
		hostConfig.NetworkMode = network.NetworkHost
	}
	// Run pg_prove on volume mount
	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: cliConfig.Images.PgProve,
			Env: []string{
				"PGHOST=" + config.Host,
				fmt.Sprintf("PGPORT=%d", config.Port),
				"PGUSER=" + config.User,
				"PGPASSWORD=" + config.Password,
				"PGDATABASE=" + config.Database,
			},
			Cmd:        cmd,
			WorkingDir: dstPath,
		},
		hostConfig,
		network.NetworkingConfig{},
		"",
		os.Stdout,
		os.Stderr,
	)
}
