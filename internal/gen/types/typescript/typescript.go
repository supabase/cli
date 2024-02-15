package typescript

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, useLocal bool, useLinked bool, projectId string, dbUrl string, schemas []string, postgrestV9Compat bool, fsys afero.Fs) error {
	// Generating types on `projectId` and `dbUrl` should work without `supabase init`
	// i.e. only load config on `--local` or `--linked` flags.
	if useLocal || useLinked {
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
	}
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

	if dbUrl != "" {
		config, err := pgconn.ParseConfig(dbUrl)
		if err != nil {
			return errors.Errorf("URL is not a valid Supabase connection string: %w", err)
		}
		escaped := fmt.Sprintf(
			"postgresql://%s@%s:%d/%s",
			url.UserPassword(config.User, config.Password),
			config.Host,
			config.Port,
			url.PathEscape(config.Database),
		)
		fmt.Fprintln(os.Stderr, "Connecting to", config.Host)

		return utils.DockerRunOnceWithConfig(
			ctx,
			container.Config{
				Image: utils.PgmetaImage,
				Env: []string{
					"PG_META_DB_URL=" + escaped,
					"PG_META_DB_SSL_MODE=prefer",
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

	if useLocal {
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}

		if strings.Contains(utils.Config.Api.Image, "v9") {
			postgrestV9Compat = true
		}

		return utils.DockerRunOnceWithStream(
			ctx,
			utils.PgmetaImage,
			[]string{
				"PG_META_DB_HOST=" + utils.DbId,
				"PG_META_GENERATE_TYPES=typescript",
				"PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=" + included,
				fmt.Sprintf("PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=%v", !postgrestV9Compat),
			},
			[]string{"node", "dist/server/server.js"},
			os.Stdout,
			os.Stderr,
		)
	}

	if useLinked {
		projectId, err := flags.LoadProjectRef(fsys)
		if err != nil {
			return err
		}

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

	return nil
}
