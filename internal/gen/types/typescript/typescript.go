package typescript

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"

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
		fmt.Fprintln(os.Stderr, "Connecting to", escaped)

		out, err := utils.DockerRunOnce(ctx, utils.PgmetaImage, []string{
			"PG_META_DB_URL=" + escaped,
		}, []string{
			"node",
			"bin/src/server/app.js",
			"gen",
			"types",
			"typescript",
			"--include-schemas",
			strings.Join(coalesce(schemas, []string{"public"}), ","),
		})
		if err != nil {
			return err
		}

		fmt.Print(out)
		return nil
	}

	// only load config on `--local` or `--linked`
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}

	if useLocal {
		if err := utils.AssertSupabaseDbIsRunning(); err != nil {
			return err
		}

		out, err := utils.DockerExecOnce(ctx, utils.PgmetaId, []string{
			"PG_META_DB_HOST=" + utils.DbId,
		}, []string{
			"node",
			"bin/src/server/app.js",
			"gen",
			"types",
			"typescript",
			"--include-schemas",
			strings.Join(coalesce(schemas, utils.Config.Api.Schemas, []string{"public"}), ","),
		})
		if err != nil {
			return err
		}

		fmt.Print(out)
		return nil
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
