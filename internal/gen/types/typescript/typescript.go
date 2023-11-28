package typescript

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, useLocal bool, useLinked bool, projectId string, dbUrl string, schemas []string, fsys afero.Fs) error {
	coalesce := func(args ...[]string) []string {
		for _, arg := range args {
			if len(arg) != 0 {
				return arg
			}
		}
		return []string{}
	}

	// Generating types on `projectId` and `dbUrl` should work without `supabase
	// init` - i.e. we shouldn't try to load the config for these cases.

	if projectId != "" {
		included := strings.Join(coalesce(schemas, []string{"public"}), ",")
		resp, err := utils.GetSupabase().GetTypescriptTypesWithResponse(ctx, projectId, &api.GetTypescriptTypesParams{
			IncludedSchemas: &included,
		})
		if err != nil {
			return err
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
			return errors.New("URL is not a valid Supabase connection string: " + err.Error())
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
					"PG_META_GENERATE_TYPES=typescript",
					"PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=" + strings.Join(coalesce(schemas, []string{"public"}), ","),
					// Can't detect the PostgREST version when using --db-url, so just default to `true`.
					"PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=true",
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

	// only load config on `--local` or `--linked`
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}

	if useLocal {
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}

		detectOneToOneRelationships := "true"
		if strings.Contains(utils.Config.Api.Image, "v9") {
			detectOneToOneRelationships = "false"
		}

		return utils.DockerRunOnceWithStream(
			ctx,
			utils.PgmetaImage,
			[]string{
				"PG_META_DB_HOST=" + utils.DbId,
				"PG_META_GENERATE_TYPES=typescript",
				"PG_META_GENERATE_TYPES_INCLUDED_SCHEMAS=" + strings.Join(coalesce(schemas, utils.Config.Api.Schemas, []string{"public"}), ","),
				"PG_META_GENERATE_TYPES_DETECT_ONE_TO_ONE_RELATIONSHIPS=" + detectOneToOneRelationships,
			},
			[]string{"node", "dist/server/server.js"},
			os.Stdout,
			os.Stderr,
		)
	}

	if useLinked {
		projectId, err := utils.LoadProjectRef(fsys)
		if err != nil {
			return err
		}

		included := strings.Join(coalesce(schemas, utils.Config.Api.Schemas, []string{"public"}), ",")
		resp, err := utils.GetSupabase().GetTypescriptTypesWithResponse(ctx, projectId, &api.GetTypescriptTypesParams{
			IncludedSchemas: &included,
		})
		if err != nil {
			return err
		}

		if resp.JSON200 == nil {
			return errors.New("failed to retrieve generated types: " + string(resp.Body))
		}

		fmt.Print(resp.JSON200.Types)
		return nil
	}

	return nil
}
