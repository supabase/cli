package utils

import (
	"context"
	"io"
	"os"
	"strings"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
)

func GetCurrentBranch() (*string, error) {
	content, err := os.ReadFile(".git/HEAD")
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

type DiffOptions struct {
	jsonDiff bool
}

func Diff(db1, db2 string, opts DiffOptions) {
	ctx := context.TODO()
	docker, err := client.NewEnvClient()
	if err != nil {
		panic(err)
	}

	readCloser, err := docker.ImagePull(ctx, "docker.io/supabase/pgadmin-schema-diff:cli-0.0.2", types.ImagePullOptions{})
	if err != nil {
		panic(err)
	}
	io.Copy(os.Stdout, readCloser)

	cmd := []string{db1, db2}
	if opts.jsonDiff {
		cmd = append(cmd, "--json-diff")
	}
	differ, err := docker.ContainerCreate(ctx, &container.Config{
		Image: "supabase/pgadmin-schema-diff",
		Cmd:   cmd,
	}, nil, nil, nil, "")
	if err != nil {
		panic(err)
	}
	defer func() {
		if err := docker.ContainerRemove(ctx, differ.ID, types.ContainerRemoveOptions{}); err != nil {
			panic(err)
		}
	}()

	if err := docker.NetworkConnect(ctx, "supabase_network_TODO", differ.ID, &network.EndpointSettings{}); err != nil {
		panic(err)
	}

	if err := docker.ContainerStart(ctx, differ.ID, types.ContainerStartOptions{}); err != nil {
		panic(err)
	}

	statusCh, errCh := docker.ContainerWait(ctx, differ.ID, container.WaitConditionNotRunning)
	select {
	case err := <-errCh:
		if err != nil {
			panic(err)
		}
	case <-statusCh:
	}

	out, err := docker.ContainerLogs(ctx, differ.ID, types.ContainerLogsOptions{ShowStdout: true})
	if err != nil {
		panic(err)
	}

	stdcopy.StdCopy(os.Stdout, os.Stderr, out)
}
