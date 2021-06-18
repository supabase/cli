package cmd

import (
	"context"
	"fmt"
	"io"
	"io/ioutil"
	"log"
	"os"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"github.com/fsnotify/fsnotify"

	// pgx "github.com/jackc/pgx/v4"
	"github.com/spf13/cobra"
)

var startCmd = &cobra.Command{
	Use:   "start",
	Short: "TODO",
	Long:  `TODO`,
	Run: func(cmd *cobra.Command, args []string) {
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			log.Fatal(err)
		}
		defer watcher.Close()

		fileChangeCh := make(chan interface{})

		go func() {
			for {
				select {
				case _, ok := <-watcher.Events:
					if !ok {
						return
					}
					// log.Println("event:", event)
					fileChangeCh <- nil
				case err, ok := <-watcher.Errors:
					if !ok {
						return
					}
					log.Println("error:", err)
				}
			}
		}()

		err = watcher.Add(".git/HEAD")
		if err != nil {
			log.Fatal(err)
		}

		currBranchNamePtr, err := getCurrentBranchName()
		if err != nil {
			panic(err)
		} else if currBranchNamePtr == nil {
			panic("you're currently in a detached HEAD. checkout a local branch and try again.")
		}
		currBranchName := *currBranchNamePtr

		dbs := []string{currBranchName}

		// start postgres
		ctx := context.Background()
		cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
		if err != nil {
			panic(err)
		}

		_, err = cli.ImagePull(ctx, "postgres", types.ImagePullOptions{})
		if err != nil {
			panic(err)
		}

		cwd, err := os.Getwd()
		if err != nil {
			panic(err)
		}

		hostConfig := &container.HostConfig{
			Binds: []string{fmt.Sprintf("%s/dump.sql:/docker-entrypoint-initdb.d/dump.sql:ro", cwd)},
		}

		db, err := cli.ContainerCreate(ctx, &container.Config{
			Image: "postgres",
			Env:   []string{"POSTGRES_PASSWORD=postgres", fmt.Sprintf("POSTGRES_DB=%s", currBranchName)},
		}, hostConfig, nil, nil, "db")
		{
			if err != nil {
				panic(err)
			}
			defer func() {
				if err := cli.ContainerRemove(ctx, db.ID, types.ContainerRemoveOptions{}); err != nil {
					panic(err)
				}
			}()

			if err := cli.NetworkConnect(ctx, "cli_default", db.ID, &network.EndpointSettings{}); err != nil {
				panic(err)
			}

			if err := cli.ContainerStart(ctx, db.ID, types.ContainerStartOptions{}); err != nil {
				panic(err)
			}
		}

		err = ioutil.WriteFile("pgbouncer.ini", []byte(fmt.Sprintf(pgbouncerConfigTemplate, currBranchName)), 0644)
		if err != nil {
			panic(err)
		}

		hostConfig = &container.HostConfig{
			Binds:        []string{fmt.Sprintf("%s/pgbouncer.ini:/etc/pgbouncer/pgbouncer.ini:ro", cwd)},
			PortBindings: nat.PortMap{"5432/tcp": []nat.PortBinding{{HostPort: "5432"}}},
		}

		pgbouncer, err := cli.ContainerCreate(ctx, &container.Config{
			Image: "edoburu/pgbouncer",
			Env:   []string{"DB_USER=postgres", "DB_PASSWORD=postgres"},
		}, hostConfig, nil, nil, "pgbouncer")
		{
			if err != nil {
				panic(err)
			}
			defer func() {
				if err := cli.ContainerRemove(ctx, pgbouncer.ID, types.ContainerRemoveOptions{}); err != nil {
					panic(err)
				}
			}()

			if err := cli.NetworkConnect(ctx, "cli_default", pgbouncer.ID, &network.EndpointSettings{}); err != nil {
				panic(err)
			}

			if err := cli.ContainerStart(ctx, pgbouncer.ID, types.ContainerStartOptions{}); err != nil {
				panic(err)
			}
		}

		for range fileChangeCh {
			nextBranchNamePtr, err := getCurrentBranchName()
			if err != nil {
				panic(err)
			}
			if nextBranchNamePtr == nil {
				continue
			} else if nextBranchName := *nextBranchNamePtr; currBranchName == nextBranchName {
				continue
			} else {
				currBranchName = nextBranchName
			}

			log.Println("branch:", currBranchName)

			// create database with the same name as the branch (if it doesn't exist)
			{
				exists := func() bool {
					for _, e := range dbs {
						if currBranchName == e {
							return true
						}
					}
					return false
				}()

				if !exists {
					dbs = append(dbs, currBranchName)

					// conn, err := pgx.Connect(context.Background(), "postgres://postgres:postgres@localhost:5435/main")
					// if err != nil {
					// 	fmt.Fprintf(os.Stderr, "Unable to connect to database: %v\n", err)
					// 	os.Exit(1)
					// }
					// defer conn.Close(context.Background())

					// err = conn.QueryRow(context.Background(), "select 1;")
					// if err != nil {
					// 	fmt.Fprintf(os.Stderr, "QueryRow failed: %v\n", err)
					// 	os.Exit(1)
					// }

					// create db
					{
						exec, err := cli.ContainerExecCreate(ctx, db.ID, types.ExecConfig{
							Cmd: []string{
								"psql",
								"-U", "postgres",
								"-c", fmt.Sprintf(`CREATE DATABASE %s;`, currBranchName),
							},
						})
						if err != nil {
							panic(err)
						}
						if err := cli.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
							panic(err)
						}
					}

					// restore dump
					{
						content, err := ioutil.ReadFile("dump.sql") // the file is inside the local directory
						if err != nil {
							panic(err)
						}

						exec, err := cli.ContainerExecCreate(ctx, db.ID, types.ExecConfig{
							Cmd: []string{
								"psql",
								"-U", "postgres",
								"-d", currBranchName,
								"-c", string(content),
							},
						})
						if err != nil {
							panic(err)
						}
						if err := cli.ContainerExecStart(ctx, exec.ID, types.ExecStartCheck{}); err != nil {
							panic(err)
						}
					}
				}

				// reload pgbouncer
				{
					content := fmt.Sprintf(pgbouncerConfigTemplate, currBranchName)
					os.WriteFile("pgbouncer.ini", []byte(content), 0644)

					if err := cli.ContainerRestart(ctx, pgbouncer.ID, nil); err != nil {
						panic(err)
					}
				}

			}
		}
	},
}

func getCurrentBranchName() (*string, error) {
	content, err := ioutil.ReadFile(".git/HEAD") // the file is inside the local directory
	if err != nil {
		return nil, err
	}
	prefix := "ref: refs/heads/"
	if content := strings.TrimSpace(string(content)); strings.HasPrefix(content, prefix) {
		branchName := content[len(prefix):]
		return &branchName, nil
	}

	return nil, nil
}

var pgbouncerConfigTemplate = `[databases]
postgres = host=db port=5432 user=postgres password=postgres dbname=%s

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 5432
auth_file = /etc/pgbouncer/userlist.txt
`

func migrate() {
	ctx := context.Background()
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		panic(err)
	}

	reader, err := cli.ImagePull(ctx, "supabase/pgadmin-schema-diff", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, reader)

	resp, err := cli.ContainerCreate(ctx, &container.Config{
		Image: "supabase/pgadmin-schema-diff",
		Cmd:   []string{"postgres://postgres:postgres@db1/postgres", "postgres://postgres:postgres@db2/postgres"},
	}, nil, nil, nil, "")
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := cli.ContainerRemove(ctx, resp.ID, types.ContainerRemoveOptions{}); err != nil {
			panic(err)
		}
	}()

	if err := cli.NetworkConnect(ctx, "cli_default", resp.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := cli.ContainerStart(ctx, resp.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	statusCh, errCh := cli.ContainerWait(ctx, resp.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		if err != nil {
			panic(err)
		}
	case <-statusCh:
	}

	out, err := cli.ContainerLogs(ctx, resp.ID, types.ContainerLogsOptions{ShowStdout: true})
	if err != nil {
		panic(err)
	}

	stdcopy.StdCopy(os.Stdout, os.Stderr, out)
}

func init() {
	rootCmd.AddCommand(startCmd)

	// Here you will define your flags and configuration settings.

	// Cobra supports Persistent Flags which will work for this command
	// and all subcommands, e.g.:
	// startCmd.PersistentFlags().String("foo", "", "A help for foo")

	// Cobra supports local flags which will only run when this command
	// is called directly, e.g.:
	// startCmd.Flags().BoolP("toggle", "t", false, "Help message for toggle")
}
