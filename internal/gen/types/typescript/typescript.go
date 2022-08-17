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
	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run(useLocal bool, dbUrl string) error {
	if err := utils.LoadConfig(); err != nil {
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
					"node", "bin/src/server/app.js", "gen", "types", "typescript", "--include-schemas", strings.Join(append([]string{"public"}, utils.Config.Api.Schemas...), ","),
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

	// run typegen on the dbUrl
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}

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
			strings.Join(append(utils.Config.Api.Schemas, "public"), ","),
		})
		if err != nil {
			return err
		}

		fmt.Print(out)
	}

	return nil
}
