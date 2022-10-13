package typescript

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/pkg/stdcopy"
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
		matches := utils.PostgresUrlPattern.FindStringSubmatch(dbUrl)
		if len(matches) != 3 {
			return errors.New("URL is not a valid Supabase connection string.")
		}
		escaped := fmt.Sprintf(
			"postgresql://postgres:%s@%s/postgres",
			url.QueryEscape(matches[1]),
			matches[2],
		)

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

		exec, err := utils.Docker.ContainerExecCreate(
			ctx,
			utils.PgmetaId,
			types.ExecConfig{
				Env: []string{
					"PG_META_DB_HOST=" + utils.DbId,
				},
				Cmd: []string{
					"node",
					"bin/src/server/app.js",
					"gen",
					"types",
					"typescript",
					"--include-schemas",
					strings.Join(coalesce(schemas, utils.Config.Api.Schemas, []string{"public"}), ","),
				},
				AttachStderr: true,
				AttachStdout: true,
			},
		)
		if err != nil {
			return err
		}

		resp, err := utils.Docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
		if err != nil {
			return err
		}
		var genBuf, errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(&genBuf, &errBuf, resp.Reader); err != nil {
			return err
		}
		if errBuf.Len() > 0 {
			return errors.New(errBuf.String())
		}

		fmt.Print(genBuf.String())
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
