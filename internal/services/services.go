package services

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/utils/tenant"
)

var suggestLinkCommand = fmt.Sprintf("Run %s to sync your local image versions with the linked project.", utils.Aqua("supabase link"))

func Run(ctx context.Context, fsys afero.Fs) error {
	_ = utils.LoadConfigFS(fsys)
	serviceImages := GetServiceImages()

	var linked map[string]string
	if projectRef, err := flags.LoadProjectRef(fsys); err == nil {
		linked = GetRemoteImages(ctx, projectRef)
	}

	table := `|SERVICE IMAGE|LOCAL|LINKED|
|-|-|-|
`
	for _, image := range serviceImages {
		parts := strings.Split(image, ":")
		version, ok := linked[image]
		if !ok {
			version = "-"
		} else if parts[1] != version && image != utils.Config.Db.Image {
			utils.CmdSuggestion = suggestLinkCommand
		}
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|\n", parts[0], parts[1], version)
	}

	return list.RenderTable(table)
}

func GetServiceImages() []string {
	return []string{
		utils.Config.Db.Image,
		utils.Config.Auth.Image,
		utils.Config.Api.Image,
		utils.RealtimeImage,
		utils.Config.Storage.Image,
		utils.EdgeRuntimeImage,
		utils.StudioImage,
		utils.PgmetaImage,
		utils.LogflareImage,
		utils.PgbouncerImage,
		utils.ImageProxyImage,
	}
}

func GetRemoteImages(ctx context.Context, projectRef string) map[string]string {
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
	wg.Add(3)
	go func() {
		defer wg.Done()
		if version, err := tenant.GetGotrueVersion(ctx, api); err == nil {
			linked[utils.Config.Auth.Image] = version
		}
	}()
	go func() {
		defer wg.Done()
		if version, err := tenant.GetPostgrestVersion(ctx, api); err == nil {
			linked[utils.Config.Api.Image] = version
		}
	}()
	go func() {
		defer wg.Done()
		if version, err := tenant.GetStorageVersion(ctx, api); err == nil {
			linked[utils.Config.Storage.Image] = version
		}
	}()
	wg.Wait()
	return linked
}
