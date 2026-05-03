package test

import (
	"context"
	_ "embed"
	"fmt"
	"os"
	"path"
	"path/filepath"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgerrcode"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
	cliConfig "github.com/supabase/cli/pkg/config"
)

const (
	ENABLE_PGTAP  = "create extension if not exists pgtap with schema extensions"
	DISABLE_PGTAP = "drop extension if exists pgtap"
)

func Run(ctx context.Context, testFiles []string, config pgconn.Config, useShadowDb bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Create and migrate shadow database if requested
	if useShadowDb {
		fmt.Fprintln(os.Stderr, "Creating shadow database for testing...")
		shadow, err := diff.CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
		if err != nil {
			return err
		}
		defer utils.DockerRemove(shadow)
		if err := start.WaitForHealthyService(ctx, utils.Config.Db.HealthTimeout, shadow); err != nil {
			return err
		}
		if err := diff.MigrateShadowDatabase(ctx, shadow, fsys, options...); err != nil {
			return err
		}
		// Override config to point at shadow DB
		config = pgconn.Config{
			Host:     utils.Config.Hostname,
			Port:     utils.Config.Db.ShadowPort,
			User:     "postgres",
			Password: utils.Config.Db.Password,
			Database: "postgres",
		}
		fmt.Fprintln(os.Stderr, "Shadow database ready. Running tests...")
	}
	// Build test command
	if len(testFiles) == 0 {
		absTestsDir, err := filepath.Abs(utils.DbTestsDir)
		if err != nil {
			return errors.Errorf("failed to resolve tests dir: %w", err)
		}
		testFiles = append(testFiles, absTestsDir)
	}
	binds := make([]string, len(testFiles))
	cmd := []string{"pg_prove", "--ext", ".pg", "--ext", ".sql", "-r"}
	var workingDir string
	for i, fp := range testFiles {
		if !filepath.IsAbs(fp) {
			fp = filepath.Join(utils.CurrentDirAbs, fp)
		}
		dockerPath := utils.ToDockerPath(fp)
		cmd = append(cmd, dockerPath)
		binds[i] = fmt.Sprintf("%s:%s:ro", fp, dockerPath)
		if workingDir == "" {
			workingDir = dockerPath
			if path.Ext(dockerPath) != "" {
				workingDir = path.Dir(dockerPath)
			}
		}
	}
	if viper.GetBool("DEBUG") {
		cmd = append(cmd, "--verbose")
	}
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
	if useShadowDb {
		// Shadow container has no Docker DNS alias; use host networking
		// so pg_prove reaches it via 127.0.0.1:<ShadowPort>
		hostConfig.NetworkMode = network.NetworkHost
	} else if utils.IsLocalDatabase(config) {
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
			WorkingDir: workingDir,
		},
		hostConfig,
		network.NetworkingConfig{},
		"",
		os.Stdout,
		os.Stderr,
	)
}
