package typescript

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectId string, dbConfig pgconn.Config, schemas []string, postgrestV9Compat bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// Add default schemas if --schema flag is not specified
	if len(schemas) == 0 {
		schemas = utils.RemoveDuplicates(append([]string{"public"}, utils.Config.Api.Schemas...))
	}
	included := strings.Join(schemas, ",")

	if projectId != "" {
		resp, err := utils.GetSupabase().GetTypescriptTypesWithResponse(ctx, projectId, &api.GetTypescriptTypesParams{
			IncludedSchemas: &included,
		})
		if err != nil {
			return errors.Errorf("failed to get typescript types: %w", err)
		}

		if resp.JSON200 == nil {
			return errors.New("failed to retrieve generated types: " + string(resp.Body))
		}

		fmt.Print(resp.JSON200.Types)
		return nil
	}

	networkID := "host"
	if utils.IsLocalDatabase(dbConfig) {
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}

		if strings.Contains(utils.Config.Api.Image, "v9") {
			postgrestV9Compat = true
		}

		// Use custom network when connecting to local database
		networkID = utils.NetId
	}

	fmt.Fprintln(os.Stderr, "Connecting to", dbConfig.Host, dbConfig.Port)
	// pg-meta does not set username as the default database, ie. postgres
	if len(dbConfig.Database) == 0 {
		dbConfig.Database = "postgres"
	}
	escaped := utils.ToPostgresURL(dbConfig)
	if require, err := isRequireSSL(ctx, escaped, options...); err != nil {
		return err
	} else if require {
		// node-postgres does not support sslmode=prefer
		escaped += "&sslmode=require"
	}

	return utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: utils.PgmetaImage,
			Env: []string{
				"PG_META_DB_URL=" + escaped,
				"PG_META_GENERATE_TYPES=typescript",
				"PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=" + included,
				fmt.Sprintf("PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=%v", !postgrestV9Compat),
			},
			Cmd: []string{"node", "dist/server/server.js"},
		},
		container.HostConfig{
			NetworkMode: container.NetworkMode(networkID),
		},
		network.NetworkingConfig{},
		"",
		os.Stdout,
		os.Stderr,
	)
}

func isRequireSSL(ctx context.Context, dbUrl string, options ...func(*pgx.ConnConfig)) (bool, error) {
	conn, err := utils.ConnectByUrl(ctx, dbUrl+"&sslmode=require", options...)
	if err != nil {
		if strings.HasSuffix(err.Error(), "(server refused TLS connection)") {
			return false, nil
		}
		return false, err
	}
	return true, conn.Close(ctx)
}
