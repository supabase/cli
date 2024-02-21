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
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectId string, dbConfig pgconn.Config, schemas []string, postgrestV9Compat bool, fsys afero.Fs) error {
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

	if utils.IsLocalDatabase(dbConfig) {
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}

		if strings.Contains(utils.Config.Api.Image, "v9") {
			postgrestV9Compat = true
		}
	} else {
		// Additional configs for pg-meta with enforce ssl
		if dbConfig.RuntimeParams == nil {
			dbConfig.RuntimeParams = make(map[string]string, 1)
		}
		dbConfig.RuntimeParams["sslmode"] = "prefer"
	}

	fmt.Fprintln(os.Stderr, "Connecting to", dbConfig.Host, dbConfig.Port)
	if len(dbConfig.Database) == 0 {
		dbConfig.Database = "postgres"
	}
	escaped := utils.ToPostgresURL(dbConfig)
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
			NetworkMode: container.NetworkMode("host"),
		},
		network.NetworkingConfig{},
		"",
		os.Stdout,
		os.Stderr,
	)
}
