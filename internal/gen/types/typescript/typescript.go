package typescript

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/supabase/cli/internal/utils"
)

var ctx = context.Background()

func Run(isLocal bool, dbUrl string) error {
	if isLocal && dbUrl != "" {
		return errors.New("Cannot specify both --local and --db-url")
	}

	if isLocal {
		if err := utils.AssertSupabaseStartIsRunning(); err != nil {
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
					"node", "bin/src/server/app.js", "gen", "types", "typescript", "--exclude-schemas", "auth,extensions,graphql,graphql_public,realtime,storage,supabase_functions,supabase_migrations",
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

	// determine db url if in a linked project
	if dbUrl == "" {
		var accessToken string
		var projectRef string
		{
			if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
				return err
			}
			_accessToken, err := utils.LoadAccessToken()
			if err != nil {
				return err
			}
			if err := utils.AssertIsLinked(); err != nil {
				return err
			}
			projectRefBytes, err := os.ReadFile("supabase/.temp/project-ref")
			if err != nil {
				return err
			}
			_projectRef := string(projectRefBytes)

			accessToken = _accessToken
			projectRef = _projectRef
		}

		req, err := http.NewRequest("GET", "https://api.supabase.io/v1/projects", nil)
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return fmt.Errorf("Unexpected error retrieving projects: %w", err)
			}

			return errors.New("Unexpected error retrieving projects: " + string(body))
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}

		var projects []struct {
			Ref    string `json:"ref"`
			DbPass string `json:"db_pass"`
		}
		if err := json.Unmarshal(body, &projects); err != nil {
			return err
		}

		var dbPass string
		for _, project := range projects {
			if project.Ref == projectRef {
				dbPass = project.DbPass
			}
		}
		if dbPass == "" {
			return errors.New("Could not find the linked project for the logged-in user. Try running supabase link again")
		}

		dbUrl = "postgresql://postgres:" + url.QueryEscape(dbPass) + "@db." + projectRef + ".supabase.co:5432/postgres"
	}

	// run typegen on the dbUrl
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}

		defer utils.DockerRemoveAll()

		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.PgmetaImage); err != nil {
			fmt.Fprintln(os.Stderr, "Downloading type generator...")
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.PgmetaImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if _, err := io.ReadAll(out); err != nil {
				return err
			}
			if err := out.Close(); err != nil {
				return err
			}
			fmt.Fprintln(os.Stderr, "Done downloading type generator")
		}

		out, err := utils.DockerRun(
			ctx,
			"supabase_gen_types_typescript",
			&container.Config{
				Image: utils.PgmetaImage,
				Env: []string{
					"PG_META_DB_URL=" + dbUrl,
				},
				Cmd: []string{
					"node", "bin/src/server/app.js", "gen", "types", "typescript", "--exclude-schemas", "auth,extensions,graphql,graphql_public,realtime,storage,supabase_functions,supabase_migrations",
				},
			},
			&container.HostConfig{},
		)
		if err != nil {
			return err
		}
		var genBuf, errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(&genBuf, &errBuf, out); err != nil {
			return err
		}
		if errBuf.Len() > 0 {
			return errors.New(errBuf.String())
		}

		fmt.Print(genBuf.String())
	}

	return nil
}
