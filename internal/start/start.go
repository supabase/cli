package start

import (
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/go-connections/nat"
	"github.com/fsnotify/fsnotify"
	"github.com/supabase/cli/internal/utils"
)

const (
	rolesSetupSql = `
BEGIN;

-- Developer roles
create role anon                nologin noinherit;
create role authenticated       nologin noinherit; -- "logged in" user: web_user, app_user, etc
create role service_role        nologin noinherit bypassrls; -- allow developers to create JWT's that bypass their policies

create user authenticator noinherit;
grant anon              to authenticator;
grant authenticated     to authenticator;
grant service_role      to authenticator;

END;
`
	pgbouncerConfigTemplate = `
[databases]
postgres = host=%s port=5432 user=postgres password=postgres dbname=%s

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_file = /etc/pgbouncer/userlist.txt
server_fast_close = 1
ignore_startup_parameters = extra_float_digits
`
	kongConfigTemplate = `
_format_version: '1.1'
services:
  - name: auth-v1-authorize
    _comment: 'GoTrue: /auth/v1/authorize* -> http://auth:9999/authorize*'
    url: http://supabase_auth_%[1]s:9999/authorize
    routes:
      - name: auth-v1-authorize
        strip_path: true
        paths:
          - /auth/v1/authorize
    plugins:
      - name: cors
  - name: auth-v1-callback
    _comment: 'GoTrue: /auth/v1/callback* -> http://auth:9999/callback*'
    url: http://supabase_auth_%[1]s:9999/callback
    routes:
      - name: auth-v1-callback
        strip_path: true
        paths:
          - /auth/v1/callback
    plugins:
      - name: cors
  - name: auth-v1-verify
    _comment: 'GoTrue: /auth/v1/verify* -> http://auth:9999/verify*'
    url: http://supabase_auth_%[1]s:9999/verify
    routes:
      - name: auth-v1-verify
        strip_path: true
        paths:
          - /auth/v1/verify
    plugins:
      - name: cors
  - name: auth-v1
    _comment: 'GoTrue: /auth/v1/* -> http://auth:9999/*'
    url: http://supabase_auth_%[1]s:9999/
    routes:
      - name: auth-v1
        strip_path: true
        paths:
          - /auth/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: true
  - name: realtime-v1
    _comment: 'Realtime: /realtime/v1/* -> ws://realtime:4000/socket/*'
    url: http://supabase_realtime_%[1]s:4000/socket/
    routes:
      - name: realtime-v1-all
        strip_path: true
        paths:
          - /realtime/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: true
  - name: rest-v1
    _comment: 'PostgREST: /rest/v1/* -> http://rest:3000/*'
    url: http://supabase_rest_%[1]s:3000/
    routes:
      - name: rest-v1-all
        strip_path: true
        paths:
          - /rest/v1/
    plugins:
      - name: cors
      - name: key-auth
        config:
          hide_credentials: true
consumers:
  - username: apikey
    keyauth_credentials:
      - key: eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTYwMzk2ODgzNCwiZXhwIjoyNTUwNjUzNjM0LCJyb2xlIjoiYW5vbiJ9.36fUebxgx1mcBo4s19v0SzqmzunP--hm_hep0uLX0ew
      - key: eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJzdXBhYmFzZSIsImlhdCI6MTYwMzk2ODgzNCwiZXhwIjoyNTUwNjUzNjM0LCJyb2xlIjoic2VydmljZV9yb2xlIn0.necIJaiP7X2T2QjGeV-FhpkizcNTX8HjDDBAxpgQTEI
`
)

var projectId = "TODO"

// TODO: Make the whole thing concurrent.
func Start() {
	if _, err := os.ReadDir("supabase"); os.IsNotExist(err) {
		log.Fatalln("Cannot find `supabase` in the current directory. Perhaps you meant to run `supabase init` first?")
	}

	// set up graceful termination

	termCh := make(chan os.Signal, 1)
	signal.Notify(termCh, syscall.SIGINT, syscall.SIGTERM)

	log.Println("Starting...")

	// set up watcher

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		panic(err)
	}
	defer watcher.Close()

	err = watcher.Add(".git/HEAD")
	if err != nil {
		panic(err)
	}

	branchCh := make(chan string)

	go func() {
		for {
			select {
			case _, ok := <-watcher.Events:
				if !ok {
					return
				}

				branch, err := utils.GetCurrentBranch()
				if err != nil {
					panic(err)
				}
				if branch != nil {
					branchCh <- *branch
				}
			case err, ok := <-watcher.Errors:
				if !ok {
					return
				}

				panic(err)
			}
		}
	}()

	// init branch name

	currBranchPtr, err := utils.GetCurrentBranch()
	if err != nil {
		panic(err)
	} else if currBranchPtr == nil {
		panic("You are currently in a detached HEAD. Checkout a local branch and try again.")
	}
	currBranch := *currBranchPtr

	// init watched dbs

	dbs := []string{currBranch}

	// init docker client

	docker, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		panic(err)
	}

	ctx := context.Background()

	// pull images

	log.Println("Pulling images...")

	readCloser, err := docker.ImagePull(ctx, "docker.io/supabase/postgres:0.14.0", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, readCloser)
	readCloser, err = docker.ImagePull(ctx, "docker.io/edoburu/pgbouncer:1.15.0", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, readCloser)
	readCloser, err = docker.ImagePull(ctx, "docker.io/library/kong:2.1", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, readCloser)
	readCloser, err = docker.ImagePull(ctx, "docker.io/supabase/gotrue:v1.8.1", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, readCloser)
	readCloser, err = docker.ImagePull(ctx, "docker.io/supabase/realtime:v0.15.0", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, readCloser)
	readCloser, err = docker.ImagePull(ctx, "docker.io/postgrest/postgrest:v7.0.1", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, readCloser)
	readCloser, err = docker.ImagePull(ctx, "docker.io/supabase/pgadmin-schema-diff:cli-0.0.2", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, readCloser)

	log.Println("Done pulling images.")
	log.Println("Starting containers...")

	// create network

	net, err := docker.NetworkCreate(ctx, fmt.Sprintf("supabase_network_%s", projectId), types.NetworkCreate{})
	defer docker.NetworkRemove(ctx, fmt.Sprintf("supabase_network_%s", projectId))

	// start postgres

	cwd, err := os.Getwd()
	if err != nil {
		panic(err)
	}

	hostConfig := &container.HostConfig{
		Binds: []string{fmt.Sprintf("%s/supabase/migrations:/docker-entrypoint-initdb.d", cwd)},
	}

	dbName := fmt.Sprintf("supabase_db_%s", projectId)
	db, err := docker.ContainerCreate(ctx, &container.Config{
		Image: "supabase/postgres:0.14.0",
		Env:   []string{"POSTGRES_PASSWORD=postgres", fmt.Sprintf("POSTGRES_DB=%s", currBranch)},
		Cmd: []string{
			"postgres", "-c", "wal_level=logical",
		},
	}, hostConfig, nil, nil, dbName)
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := docker.ContainerRemove(ctx, db.ID, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			panic(err)
		}
	}()

	if err := docker.NetworkConnect(ctx, net.ID, db.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := docker.ContainerStart(ctx, db.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	// start pgbouncer

	err = os.WriteFile("supabase/.temp/pgbouncer.ini", []byte(fmt.Sprintf(pgbouncerConfigTemplate, dbName, currBranch)), 0644)
	if err != nil {
		panic(err)
	}

	hostConfig = &container.HostConfig{
		Binds:        []string{fmt.Sprintf("%s/supabase/.temp/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro", cwd)},
		PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: "5432"}}},
	}

	pgbouncerName := fmt.Sprintf("supabase_pgbouncer_%s", projectId)
	pgbouncer, err := docker.ContainerCreate(ctx, &container.Config{
		Image: "edoburu/pgbouncer:1.15.0",
		Env:   []string{"DB_USER=postgres", "DB_PASSWORD=postgres"},
	}, hostConfig, nil, nil, pgbouncerName)
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := docker.ContainerRemove(ctx, pgbouncer.ID, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			panic(err)
		}
	}()

	if err := docker.NetworkConnect(ctx, net.ID, pgbouncer.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := docker.ContainerStart(ctx, pgbouncer.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	// start kong

	err = os.WriteFile("supabase/.temp/kong.yml", []byte(fmt.Sprintf(kongConfigTemplate, projectId)), 0644)
	if err != nil {
		panic(err)
	}

	hostConfig = &container.HostConfig{
		Binds:        []string{fmt.Sprintf("%s/supabase/.temp/kong.yml:/var/lib/kong/kong.yml:ro", cwd)},
		PortBindings: nat.PortMap{"8000/tcp": []nat.PortBinding{{HostPort: "8000"}}},
	}

	kong, err := docker.ContainerCreate(ctx, &container.Config{
		Image: "kong:2.1",
		Env: []string{
			"KONG_DATABASE=off",
			"KONG_PLUGINS=request-transformer,cors,key-auth,http-log",
			"KONG_DECLARATIVE_CONFIG=/var/lib/kong/kong.yml",
			"KONG_DNS_ORDER=LAST,A,CNAME",
		},
	}, hostConfig, nil, nil, fmt.Sprintf("supabase_kong_%s", projectId))
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := docker.ContainerRemove(ctx, kong.ID, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			panic(err)
		}
	}()

	if err := docker.NetworkConnect(ctx, net.ID, kong.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := docker.ContainerStart(ctx, kong.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	// start gotrue

	gotrueName := fmt.Sprintf("supabase_auth_%s", projectId)
	gotrue, err := docker.ContainerCreate(ctx, &container.Config{
		Image: "supabase/gotrue:v1.8.1",
		Env: []string{
			"GOTRUE_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			"GOTRUE_JWT_AUD=authenticated",
			"GOTRUE_JWT_EXP=3600",
			"GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated",
			"GOTRUE_DB_DRIVER=postgres",
			"DB_NAMESPACE=auth",
			"API_EXTERNAL_URL=http://localhost:8000",
			fmt.Sprintf("GOTRUE_API_HOST=%s", gotrueName),
			"PORT=9999",
			"GOTRUE_DISABLE_SIGNUP=false",
			"GOTRUE_SITE_URL=http://localhost:8000",
			// "GOTRUE_SMTP_HOST=mail",
			// "GOTRUE_SMTP_PORT=2500",
			// "GOTRUE_SMTP_USER=GOTRUE_SMTP_USER",
			// "GOTRUE_SMTP_PASS=GOTRUE_SMTP_PASS",
			// "GOTRUE_SMTP_ADMIN_EMAIL=admin@email.com",
			// "GOTRUE_MAILER_AUTOCONFIRM=false",
			// "GOTRUE_MAILER_SUBJECTS_CONFIRMATION=Confirm Your Signup",
			// "GOTRUE_MAILER_SUBJECTS_INVITE=You have been invited",
			// "GOTRUE_MAILER_SUBJECTS_MAGIC_LINK=Your Magic Link",
			// "GOTRUE_MAILER_SUBJECTS_RECOVERY=Reset Your Password",
			// "GOTRUE_MAILER_URLPATHS_CONFIRMATION=/auth/v1/verify",
			// "GOTRUE_MAILER_URLPATHS_INVITE=/auth/v1/verify",
			// "GOTRUE_MAILER_URLPATHS_RECOVERY=/auth/v1/verify",
			"GOTRUE_LOG_LEVEL=DEBUG",
			"GOTRUE_OPERATOR_TOKEN=super-secret-operator-token",
			fmt.Sprintf("DATABASE_URL=postgres://postgres:postgres@%s:5432/postgres?sslmode=disable", pgbouncerName),
		},
	}, &container.HostConfig{}, nil, nil, gotrueName)
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := docker.ContainerRemove(ctx, gotrue.ID, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			panic(err)
		}
	}()

	if err := docker.NetworkConnect(ctx, net.ID, gotrue.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := docker.ContainerStart(ctx, gotrue.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	// Start Realtime. It's handled differently since it doesn't work with pgbouncer for some reason.

	realtime, err := docker.ContainerCreate(ctx, &container.Config{
		Image: "supabase/realtime:v0.15.0",
		Env: []string{
			// connect to db directly instead of pgbouncer
			fmt.Sprintf("DB_HOST=%s", dbName),
			fmt.Sprintf("DB_NAME=%s", currBranch),
			"DB_USER=postgres",
			"DB_PASSWORD=postgres",
			"DB_PORT=5432",
			"SLOT_NAME=supabase_realtime",
			"PORT=4000",
			"HOSTNAME=localhost",
			"SECURE_CHANNELS=false",
			"JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
		},
	}, &container.HostConfig{}, nil, nil, fmt.Sprintf("supabase_realtime_%s", projectId))
	if err != nil {
		panic(err)
	}

	if err := docker.NetworkConnect(ctx, net.ID, realtime.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := docker.ContainerStart(ctx, realtime.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	// start postgrest

	postgrest, err := docker.ContainerCreate(ctx, &container.Config{
		Image: "postgrest/postgrest:v7.0.1",
		Env: []string{
			fmt.Sprintf("PGRST_DB_URI=postgres://postgres:postgres@%s:5432/postgres", pgbouncerName),
			"PGRST_DB_SCHEMA=public",
			"PGRST_DB_ANON_ROLE=postgres",
			"PGRST_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
		},
	}, &container.HostConfig{}, nil, nil, fmt.Sprintf("supabase_rest_%s", projectId))
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := docker.ContainerRemove(ctx, postgrest.ID, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			panic(err)
		}
	}()

	if err := docker.NetworkConnect(ctx, net.ID, postgrest.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := docker.ContainerStart(ctx, postgrest.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	// start differ

	differ, err := docker.ContainerCreate(ctx, &container.Config{
		Image:        "supabase/pgadmin-schema-diff",
		Entrypoint:   []string{"sleep", "infinity"},
	}, nil, nil, nil, fmt.Sprintf("supabase_differ_%s", projectId))
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := docker.ContainerRemove(ctx, differ.ID, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			panic(err)
		}
	}()

	if err := docker.NetworkConnect(ctx, fmt.Sprintf("supabase_network_%s", projectId), differ.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := docker.ContainerStart(ctx, differ.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	log.Println("Started.")

	// switch db on switch branch

	for {
		select {
		case <-termCh:
			log.Println("Shutting down...")
			if err := docker.ContainerRemove(ctx, fmt.Sprintf("supabase_realtime_%s", projectId), types.ContainerRemoveOptions{
				RemoveVolumes: true,
				Force:         true,
			}); err != nil {
				panic(err)
			}
			return
		case currBranch = <-branchCh:
		}

		log.Printf("Switched to branch: %s. Switching database...", currBranch)

		// if it's a new branch, create database with the same name as the branch

		isNewBranch := true
		for _, e := range dbs {
			if currBranch == e {
				isNewBranch = false
				break
			}
		}

		if isNewBranch {
			log.Println("New branch detected. Creating database...")

			dbs = append(dbs, currBranch)

			// create db

			exec, err := docker.ContainerExecCreate(ctx, db.ID, types.ExecConfig{
				Cmd: []string{
					"psql",
					"--username", "postgres",
					"--command", fmt.Sprintf(`CREATE DATABASE %s;`, currBranch),
				},
				AttachStderr: true,
				AttachStdout: true,
			})
			if err != nil {
				panic(err)
			}
			if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
				panic(err)
			}
			resp, err := docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
			if err != nil {
				panic(err)
			}
			io.Copy(os.Stdout, resp.Reader)

			// restore migrations

			migrations, err := os.ReadDir("supabase/migrations")
			if err != nil {
				panic(err)
			}

			for _, migration := range migrations {
				log.Printf("Applying migration %s...\n", migration.Name())
				exec, err = docker.ContainerExecCreate(ctx, db.ID, types.ExecConfig{
					Cmd: []string{
						"psql",
						"--username", "postgres",
						"--dbname", currBranch,
						"--file", fmt.Sprintf("/docker-entrypoint-initdb.d/%s", migration.Name()),
					},
					AttachStderr: true,
					AttachStdout: true,
				})
				if err != nil {
					panic(err)
				}
				if err := docker.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {

				}
				resp, err := docker.ContainerExecAttach(ctx, exec.ID, types.ExecStartCheck{})
				if err != nil {
					panic(err)
				}
				io.Copy(os.Stdout, resp.Reader)
			}

			log.Printf("Finished creating database %s.\n", currBranch)
		}

		// reload pgbouncer

		content := fmt.Sprintf(pgbouncerConfigTemplate, dbName, currBranch)
		os.WriteFile("supabase/.temp/pgbouncer.ini", []byte(content), 0644)

		if err := docker.ContainerKill(ctx, pgbouncer.ID, "SIGHUP"); err != nil {
			panic(err)
		}

		// restart realtime, since the current db changed and it doesn't use pgbouncer

		if err := docker.ContainerRemove(ctx, realtime.ID, types.ContainerRemoveOptions{
			RemoveVolumes: true,
			Force:         true,
		}); err != nil {
			panic(err)
		}

		realtime, err = docker.ContainerCreate(ctx, &container.Config{
			Image: "supabase/realtime:v0.15.0",
			Env: []string{
				// connect to db directly instead of pgbouncer, since realtime doesn't work with pgbouncer for some reason
				fmt.Sprintf("DB_HOST=%s", dbName),
				fmt.Sprintf("DB_NAME=%s", currBranch),
				"DB_USER=postgres",
				"DB_PASSWORD=postgres",
				"DB_PORT=5432",
				"SLOT_NAME=supabase_realtime",
				"PORT=4000",
				"HOSTNAME=localhost",
				"SECURE_CHANNELS=false",
				"JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
			},
		}, &container.HostConfig{}, nil, nil, fmt.Sprintf("supabase_realtime_%s", projectId))
		if err != nil {
			panic(err)
		}

		if err := docker.NetworkConnect(ctx, net.ID, realtime.ID, &network.EndpointSettings{}); err != nil {
			panic(err)
		}

		if err := docker.ContainerStart(ctx, realtime.ID, types.ContainerStartOptions{}); err != nil {
			panic(err)
		}

		log.Println("Finished switching database.")
	}
}
