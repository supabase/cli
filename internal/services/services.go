package services

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/utils/tenant"
)

func Run(ctx context.Context, fsys afero.Fs) error {
	if err := flags.LoadProjectRef(fsys); err != nil && !errors.Is(err, utils.ErrNotLinked) {
		fmt.Fprintln(os.Stderr, err)
	}
	if err := flags.LoadConfig(fsys); err != nil {
		fmt.Fprintln(os.Stderr, err)
	}

	serviceImages := CheckVersions(ctx, fsys)
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

	return list.RenderTable(table)
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
	linked := make(map[string]string, 4)
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		if version, err := tenant.GetDatabaseVersion(ctx, projectRef); err == nil {
			linked[utils.Config.Db.Image] = version
		}
	}()
	keys, err := tenant.GetApiKeys(ctx, projectRef)
	if err != nil {
		wg.Wait()
		return linked
	}
	api := tenant.NewTenantAPI(ctx, projectRef, keys.Anon)
	wg.Add(2)
	go func() {
		defer wg.Done()
		if version, err := api.GetGotrueVersion(ctx); err == nil {
			linked[utils.Config.Auth.Image] = version
		}
	}()
	go func() {
		defer wg.Done()
		if version, err := api.GetPostgrestVersion(ctx); err == nil {
			linked[utils.Config.Api.Image] = version
		}
	}()
	wg.Wait()
	return linked
}

func suggestUpdateCmd(serviceImages map[string]string) string {
	cmd := fmt.Sprintln(utils.Yellow("WARNING:"), "You are running different service versions locally than your linked project:")
	for k, v := range serviceImages {
		cmd += fmt.Sprintf("%s => %s\n", k, v)
	}
	cmd += fmt.Sprintf("Run %s to update them.", utils.Aqua("supabase link"))
	return cmd
}
