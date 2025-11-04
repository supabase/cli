package main

import (
	"context"
	"io"
	"log"
	"os"
	"os/signal"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/compose-spec/compose-go/v2/types"
	"github.com/docker/cli/cli/command"
	"github.com/docker/cli/cli/flags"
	"github.com/docker/compose/v2/pkg/api"
	"github.com/docker/compose/v2/pkg/compose"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/client"
	"github.com/supabase/cli/internal/utils"
)

func main() {
	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt)
	if err := pullImages(ctx); err != nil {
		log.Fatalln(err)
	}
}

type RetryClient struct {
	*client.Client
}

// Used by unit tests
var timeUnit = time.Second

func (cli *RetryClient) ImagePull(ctx context.Context, refStr string, options image.PullOptions) (io.ReadCloser, error) {
	if len(options.RegistryAuth) == 0 {
		options.RegistryAuth = utils.GetRegistryAuth()
	}
	pull := func() (io.ReadCloser, error) {
		return cli.Client.ImagePull(ctx, refStr, options)
	}
	policy := utils.NewBackoffPolicy(ctx)
	return backoff.RetryWithData(pull, policy)
}

func pullImages(ctx context.Context) error {
	cli, err := command.NewDockerCli()
	if err != nil {
		return err
	}
	c, err := command.NewAPIClientFromFlags(&flags.ClientOptions{}, cli.ConfigFile())
	if err != nil {
		return err
	}
	opt := command.WithAPIClient(&RetryClient{Client: c.(*client.Client)})
	if err := cli.Initialize(&flags.ClientOptions{}, opt); err != nil {
		return err
	}
	service := compose.NewComposeService(cli)
	project := types.Project{
		Name: "supabase-cli",
		Services: map[string]types.ServiceConfig{
			"db": {
				Name:  "db",
				Image: utils.GetRegistryImageUrl(utils.Config.Db.Image),
			},
			"auth": {
				Name:  "auth",
				Image: utils.GetRegistryImageUrl(utils.Config.Auth.Image),
			},
			"api": {
				Name:  "api",
				Image: utils.GetRegistryImageUrl(utils.Config.Api.Image),
			},
			"realtime": {
				Name:  "realtime",
				Image: utils.GetRegistryImageUrl(utils.Config.Realtime.Image),
			},
			"storage": {
				Name:  "storage",
				Image: utils.GetRegistryImageUrl(utils.Config.Storage.Image),
			},
			"edgeRuntime": {
				Name:  "edgeRuntime",
				Image: utils.GetRegistryImageUrl(utils.Config.EdgeRuntime.Image),
			},
			"studio": {
				Name:  "studio",
				Image: utils.GetRegistryImageUrl(utils.Config.Studio.Image),
			},
			"pgmeta": {
				Name:  "pgmeta",
				Image: utils.GetRegistryImageUrl(utils.Config.Studio.PgmetaImage),
			},
			"analytics": {
				Name:  "analytics",
				Image: utils.GetRegistryImageUrl(utils.Config.Analytics.Image),
			},
		},
	}
	// return service.Up(ctx, &project, api.UpOptions{})
	return service.Pull(ctx, &project, api.PullOptions{})
}
