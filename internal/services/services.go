package services

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/config"
	"github.com/supabase/cli/pkg/queue"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	if err := flags.LoadProjectRef(fsys); err != nil && !errors.Is(err, utils.ErrNotLinked) {
		fmt.Fprintln(os.Stderr, err)
	}
	if err := flags.LoadConfig(fsys); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}

	serviceImages := CheckVersions(ctx, fsys)
	switch utils.OutputFormat.Value {
	case utils.OutputPretty:
		table := `|SERVICE IMAGE|LOCAL|LINKED|
|-|-|-|
`
		for _, image := range serviceImages {
			remote := image.Remote
			if len(remote) == 0 {
				remote = "-"
			}
			table += fmt.Sprintf("|`%s`|`%s`|`%s`|\n", image.Name, image.Local, remote)
		}
		return utils.RenderTable(table)
	case utils.OutputToml:
		return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, struct {
			Services []imageVersion `toml:"services"`
		}{
			Services: serviceImages,
		})
	case utils.OutputEnv:
		return errors.New(utils.ErrEnvNotSupported)
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, serviceImages)
}

type imageVersion struct {
	Name   string `json:"name"`
	Local  string `json:"local"`
	Remote string `json:"remote"`
}

func CheckVersions(ctx context.Context, fsys afero.Fs) []imageVersion {
	var remote map[string]string
	if _, err := utils.LoadAccessTokenFS(fsys); err == nil && len(flags.ProjectRef) > 0 {
		remote = listRemoteImages(ctx, flags.ProjectRef)
	}
	var result []imageVersion
	for _, image := range utils.Config.GetServiceImages() {
		parts := strings.Split(image, ":")
		v := imageVersion{Name: parts[0], Local: parts[1]}
		if v.Remote = remote[image]; v.Remote == v.Local {
			delete(remote, image)
		}
		result = append(result, v)
	}
	if len(remote) > 0 {
		fmt.Fprintln(os.Stderr, suggestUpdateCmd(remote))
	}
	return result
}

func listRemoteImages(ctx context.Context, projectRef string) map[string]string {
	keys, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		return nil
	}
	linked := config.NewConfig()
	jq := queue.NewJobQueue(5)
	api := tenant.NewTenantAPI(ctx, projectRef, keys.ServiceRole)
	jobs := []func() error{
		func() error {
			version, err := tenant.GetDatabaseVersion(ctx, projectRef)
			if err == nil {
				linked.Db.Image = version
			}
			return nil
		},
		func() error {
			version, err := api.GetGotrueVersion(ctx)
			if err == nil {
				linked.Auth.Image = version
			}
			return nil
		},
		func() error {
			version, err := api.GetPostgrestVersion(ctx)
			if err == nil {
				linked.Api.Image = version
			}
			return nil
		},
		func() error {
			version, err := api.GetStorageVersion(ctx)
			if err == nil {
				linked.Storage.Image = version
			}
			return err
		},
	}
	// Ignore non-fatal errors linking services
	logger := utils.GetDebugLogger()
	for _, job := range jobs {
		if err := jq.Put(job); err != nil {
			fmt.Fprintln(logger, err)
		}
	}
	if err := jq.Collect(); err != nil {
		fmt.Fprintln(logger, err)
	}
	// Convert to map last to avoid race condition
	return map[string]string{
		utils.Config.Db.Image:      linked.Db.Image,
		utils.Config.Auth.Image:    linked.Auth.Image,
		utils.Config.Api.Image:     linked.Api.Image,
		utils.Config.Storage.Image: linked.Storage.Image,
	}
}

func suggestUpdateCmd(serviceImages map[string]string) string {
	cmd := fmt.Sprintln(utils.Yellow("WARNING:"), "You are running different service versions locally than your linked project:")
	for k, v := range serviceImages {
		cmd += fmt.Sprintf("%s => %s\n", k, v)
	}
	cmd += fmt.Sprintf("Run %s to update them.", utils.Aqua("supabase link"))
	return cmd
}
