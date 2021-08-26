package start

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"text/template"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/fsnotify/fsnotify"
	"github.com/supabase/cli/internal/utils"
)

var (
	//go:embed templates/pgbouncer_config
	pgbouncerConfigEmbed       string
	pgbouncerConfigTemplate, _ = template.New("pgbouncerConfig").Parse(pgbouncerConfigEmbed)
	//go:embed templates/pgbouncer_userlist
	pgbouncerUserlist []byte
	//go:embed templates/kong_config
	kongConfigEmbed       string
	kongConfigTemplate, _ = template.New("kongConfig").Parse(kongConfigEmbed)

	ctx = context.TODO()
)

// TODO: Make the whole thing concurrent.
func Start() error {
	// Sanity checks.
	{
		if _, err := os.ReadDir("supabase"); errors.Is(err, os.ErrNotExist) {
			return errors.New(
				"Cannot find `supabase` in the current directory. Perhaps you meant to run `supabase init` first?",
			)
		} else if err != nil {
			return err
		}

		utils.AssertDockerIsRunning()
		utils.LoadConfig()
	}

	_, _ = utils.Docker.NetworkCreate(ctx, utils.NetId, types.NetworkCreate{CheckDuplicate: true})
	defer utils.Docker.NetworkRemove(context.Background(), utils.NetId)

	defer utils.DockerRemoveAll()

	// Handle SIGINT/SIGTERM.
	termCh := make(chan os.Signal, 1)
	signal.Notify(termCh, syscall.SIGINT, syscall.SIGTERM)
	errCh := make(chan error)

	fmt.Println("Starting...")

	// Set up watcher.

	branchCh := make(chan string)

	{
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			return err
		}
		defer watcher.Close()

		if err := watcher.Add(".git/HEAD"); err != nil {
			return err
		}

		go func() {
			for {
				select {
				case _, ok := <-watcher.Events:
					if !ok {
						return
					}

					branch, err := utils.GetCurrentBranch()
					if err != nil {
						errCh <- errors.New("Error getting current branch name.")
						signal.Notify(termCh, syscall.SIGINT, syscall.SIGTERM)
						return
					}
					if branch != nil {
						branchCh <- *branch
					}
				case err, ok := <-watcher.Errors:
					if !ok {
						return
					}

					errCh <- err
					signal.Notify(termCh, syscall.SIGINT, syscall.SIGTERM)
					return
				}
			}
		}()
	}

	// init branch name

	var currBranch string
	if currBranchPtr, err := utils.GetCurrentBranch(); err != nil {
		return err
	} else if currBranchPtr == nil {
		return errors.New("You are currently in a detached HEAD. Checkout a local branch and try again.")
	} else {
		currBranch = *currBranchPtr
	}

	// init watched dbs

	initializedDbs := []string{currBranch}

	// pull images

	fmt.Println("Pulling images...")

	{
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.DbImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.DbImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.PgbouncerImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.PgbouncerImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.KongImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.KongImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.GotrueImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.GotrueImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.RealtimeImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.RealtimeImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.PostgrestImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.PostgrestImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.DifferImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.DifferImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.PgmetaImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.PgmetaImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			io.Copy(os.Stdout, out)
		}
	}

	fmt.Println("Done pulling images.")
	fmt.Println("Starting containers...")

	// start postgres

	{
		if err := utils.DockerRun(
			ctx,
			utils.DbId,
			&container.Config{
				Image: utils.DbImage,
				Env:   []string{"POSTGRES_PASSWORD=postgres", "POSTGRES_DB=" + currBranch},
				Cmd:   []string{"postgres", "-c", "wal_level=logical"},
			},
			&container.HostConfig{
				NetworkMode: container.NetworkMode(utils.NetId),
			},
		); err != nil {
			return err
		}

		globalsSql := utils.FallbackGlobalsSql
		if content, err := os.ReadFile("supabase/.globals.sql"); err == nil {
			globalsSql = content
		}

		out, err := utils.DockerExec(ctx, utils.DbId, []string{
			"sh", "-c", "until pg_isready --host $(hostname --ip-address); do sleep 0.1; done " +
				`&& psql --username postgres <<'EOSQL'
BEGIN;
` + string(globalsSql) + `
COMMIT;
EOSQL
`,
		})
		if err != nil {
			return err
		}
		stdcopy.StdCopy(os.Stdout, os.Stderr, out)
		var errBuf bytes.Buffer

		if errBuf.Len() > 0 {
			return errors.New("Error running globals.sql: " + errBuf.String())
		}

		migrations, err := os.ReadDir("supabase/migrations")
		if err != nil {
			return err
		}

		for _, migration := range migrations {
			fmt.Println("Applying migration " + migration.Name() + "...")

			content, err := os.ReadFile("supabase/migrations/" + migration.Name())
			if err != nil {
				return err
			}

			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"sh", "-c", "psql --username postgres --dbname '" + currBranch + `' <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
			})
			if err != nil {
				return err
			}
			stdcopy.StdCopy(os.Stdout, os.Stderr, out)
			var errBuf bytes.Buffer

			if errBuf.Len() > 0 {
				return errors.New(
					"Error running migration " + migration.Name() + ": " + errBuf.String(),
				)
			}
		}

		fmt.Println("Applying seed...")

		content, err := os.ReadFile("supabase/seed.sql")
		if errors.Is(err, os.ErrNotExist) {
			// skip
		} else if err != nil {
			return err
		} else {
			out, err := utils.DockerExec(ctx, utils.DbId, []string{
				"sh", "-c", "psql --username postgres --dbname '" + currBranch + `' <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
			})
			if err != nil {
				return err
			}
			stdcopy.StdCopy(os.Stdout, os.Stderr, out)
			var errBuf bytes.Buffer

			if errBuf.Len() > 0 {
				return errors.New("Error running seed: " + errBuf.String())
			}
		}
	}

	if err := os.Mkdir("supabase/.temp", 0755); err != nil {
		return err
	}
	defer os.RemoveAll("supabase/.temp")

	// start pgbouncer

	{
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		var pgbouncerConfigBuf bytes.Buffer
		if err := pgbouncerConfigTemplate.Execute(
			&pgbouncerConfigBuf,
			struct{ ProjectId, DbName string }{
				ProjectId: utils.ProjectId,
				DbName:    currBranch,
			},
		); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/pgbouncer.ini", pgbouncerConfigBuf.Bytes(), 0644); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/userlist.txt", pgbouncerUserlist, 0644); err != nil {
			return err
		}

		if err := utils.DockerRun(
			ctx,
			utils.PgbouncerId,
			&container.Config{
				Image: utils.PgbouncerImage,
				Env:   []string{"DB_USER=postgres", "DB_PASSWORD=postgres"},
			},
			&container.HostConfig{
				Binds: []string{
					cwd + "/supabase/.temp/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro",
					cwd + "/supabase/.temp/userlist.txt:/etc/pgbouncer/userlist.txt:ro",
				},
				PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: utils.DbPort}}},
				NetworkMode:  container.NetworkMode(utils.NetId),
			},
		); err != nil {
			return err
		}
	}

	// start kong

	{
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}

		var kongConfigBuf bytes.Buffer
		if err := kongConfigTemplate.Execute(&kongConfigBuf, struct{ ProjectId string }{ProjectId: utils.ProjectId}); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/kong.yml", kongConfigBuf.Bytes(), 0644); err != nil {
			return err
		}

		if err := utils.DockerRun(
			ctx,
			utils.KongId,
			&container.Config{
				Image: utils.KongImage,
				Env: []string{
					"KONG_DATABASE=off",
					"KONG_PLUGINS=request-transformer,cors,key-auth,http-log",
					"KONG_DECLARATIVE_CONFIG=/var/lib/kong/kong.yml",
					"KONG_DNS_ORDER=LAST,A,CNAME",
				},
			},
			&container.HostConfig{
				Binds:        []string{(cwd + "/supabase/.temp/kong.yml:/var/lib/kong/kong.yml:ro")},
				PortBindings: nat.PortMap{"8000/tcp": []nat.PortBinding{{HostPort: utils.ApiPort}}},
				NetworkMode:  container.NetworkMode(utils.NetId),
			},
		); err != nil {
			return err
		}
	}

	// start gotrue

	if err := utils.DockerRun(
		ctx,
		utils.GotrueId,
		&container.Config{
			Image: utils.GotrueImage,
			Env: []string{
				"GOTRUE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
				"GOTRUE_JWT_AUD=authenticated",
				"GOTRUE_JWT_EXP=3600",
				"GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
				"GOTRUE_DB_DRIVER=postgres",
				"DB_NAMESPACE=auth",
				"API_EXTERNAL_URL=http://localhost:" + utils.ApiPort,
				"GOTRUE_API_HOST=" + utils.GotrueId,
				"PORT=9999",
				"GOTRUE_DISABLE_SIGNUP=false",
				// TODO: Change dynamically.
				"GOTRUE_SITE_URL=http://localhost:8000",
				"GOTRUE_LOG_LEVEL=DEBUG",
				"GOTRUE_OPERATOR_TOKEN=super-secret-operator-token",
				"DATABASE_URL=postgres://supabase_auth_admin:postgres@" + utils.PgbouncerId + ":5432/postgres?sslmode=disable",
			},
		},
		&container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)},
	); err != nil {
		return err
	}

	// Start Realtime.

	if err := utils.DockerRun(ctx, utils.RealtimeId, &container.Config{
		Image: utils.RealtimeImage,
		Env: []string{
			// connect to db directly instead of pgbouncer, since realtime doesn't work with pgbouncer for some reason
			"DB_HOST=" + utils.DbId,
			"DB_NAME=" + currBranch,
			"DB_USER=postgres",
			"DB_PASSWORD=postgres",
			"DB_PORT=5432",
			"SLOT_NAME=supabase_realtime",
			"PORT=4000",
			"HOSTNAME=localhost",
			"SECURE_CHANNELS=false",
			"JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
		},
	}, &container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)}); err != nil {
		return err
	}

	// start postgrest

	if err := utils.DockerRun(
		ctx,
		utils.RestId,
		&container.Config{
			Image: utils.PostgrestImage,
			Env: []string{
				"PGRST_DB_URI=postgres://postgres:postgres@" + utils.PgbouncerId + ":5432/postgres",
				"PGRST_DB_SCHEMA=public",
				"PGRST_DB_ANON_ROLE=postgres",
				"PGRST_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			},
		},
		&container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)},
	); err != nil {
		return err
	}

	// start differ

	if err := utils.DockerRun(
		ctx,
		utils.DifferId,
		&container.Config{
			Image:      utils.DifferImage,
			Entrypoint: []string{"sleep", "infinity"},
		},
		&container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)},
	); err != nil {
		return err
	}

	fmt.Println("Started.")

	// Start pg-meta.

	if err := utils.DockerRun(
		ctx,
		utils.PgmetaId,
		&container.Config{
			Image: utils.PgmetaImage,
			Env: []string{
				"PG_META_PORT=8080",
				"PG_META_DB_HOST=" + utils.DbId,
			},
		},
		&container.HostConfig{
			PortBindings: nat.PortMap{"8080/tcp": []nat.PortBinding{{HostPort: utils.PgmetaPort}}},
			NetworkMode:  container.NetworkMode(utils.NetId),
		},
	); err != nil {
		return err
	}

	// switch db on switch branch

	for {
		select {
		case <-termCh:
			fmt.Println("Shutting down...")

			select {
			case err := <-errCh:
				return err
			default:
				return nil
			}
		case currBranch = <-branchCh:
		}

		fmt.Println("Switched to branch: " + currBranch + ". Switching database...")

		// if it's a new branch, create database with the same name as the branch

		isNewBranch := true
		for _, e := range initializedDbs {
			if currBranch == e {
				isNewBranch = false
				break
			}
		}

		if isNewBranch {
			fmt.Println("New branch detected. Creating database...")

			initializedDbs = append(initializedDbs, currBranch)

			// create db

			out, err := utils.DockerExec(
				ctx,
				utils.DbId,
				[]string{"createdb", "--username", "postgres", currBranch},
			)
			if err != nil {
				// return err
			}
			stdcopy.StdCopy(os.Stdout, os.Stderr, out)

			// restore migrations

			migrations, err := os.ReadDir("supabase/migrations")
			if err != nil {
				return err
			}

			for _, migration := range migrations {
				fmt.Println("Applying migration " + migration.Name() + "...")

				content, err := os.ReadFile("supabase/migrations/" + migration.Name())
				if err != nil {
					return err
				}

				out, err := utils.DockerExec(ctx, utils.DbId, []string{
					"sh", "-c", "psql --username postgres --dbname '" + currBranch + `' <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
				})
				if err != nil {
					return err
				}
				stdcopy.StdCopy(os.Stdout, os.Stderr, out)
				var errBuf bytes.Buffer

				if errBuf.Len() > 0 {
					return errors.New(
						"Error running migration " + migration.Name() + ": " + errBuf.String(),
					)
				}
			}

			fmt.Println("Applying seed...")

			if content, err := os.ReadFile("supabase/seed.sql"); errors.Is(err, os.ErrNotExist) {
				// skip
			} else if err != nil {
				return err
			} else {
				out, err := utils.DockerExec(ctx, utils.DbId, []string{
					"sh", "-c", "psql --username postgres --dbname '" + currBranch + `' <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
				})
				if err != nil {
					return err
				}
				stdcopy.StdCopy(os.Stdout, os.Stderr, out)
				var errBuf bytes.Buffer

				if errBuf.Len() > 0 {
					return errors.New("Error running seed: " + errBuf.String())
				}
			}

			fmt.Println("Finished creating database " + currBranch + ".")
		}

		// reload pgbouncer

		var pgbouncerConfigBuf bytes.Buffer
		if err := pgbouncerConfigTemplate.Execute(
			&pgbouncerConfigBuf,
			struct{ ProjectId, DbName string }{
				ProjectId: utils.ProjectId,
				DbName:    currBranch,
			},
		); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/.temp/pgbouncer.ini", pgbouncerConfigBuf.Bytes(), 0644); err != nil {
			return err
		}

		if err := utils.Docker.ContainerKill(ctx, utils.PgbouncerId, "SIGHUP"); err != nil {
			return err
		}

		// restart realtime, since the current db changed and it doesn't use pgbouncer

		if err := utils.Docker.ContainerRemove(ctx, utils.RealtimeId, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			return err
		}

		if err := utils.DockerRun(ctx, utils.RealtimeId, &container.Config{
			Image: utils.RealtimeImage,
			Env: []string{
				// connect to db directly instead of pgbouncer, since realtime doesn't work with pgbouncer for some reason
				"DB_HOST=" + utils.DbId,
				"DB_NAME=" + currBranch,
				"DB_USER=postgres",
				"DB_PASSWORD=postgres",
				"DB_PORT=5432",
				"SLOT_NAME=supabase_realtime",
				"PORT=4000",
				"HOSTNAME=localhost",
				"SECURE_CHANNELS=false",
				"JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			},
		}, &container.HostConfig{NetworkMode: container.NetworkMode(utils.NetId)}); err != nil {
			return err
		}

		fmt.Println("Finished switching database.")
	}
}
