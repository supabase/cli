package version

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/tenant"
)

var (
	errDatabaseVersion = errors.New("Database version not found.")
	suggestLinkCommand = fmt.Sprintf("Run %s to sync your local image versions with the linked project.", utils.Aqua("supabase link"))
)

func Run(ctx context.Context, fsys afero.Fs) error {
	_ = utils.LoadConfigFS(fsys)
	serviceImages := []string{
		utils.Config.Db.Image,
		utils.Config.Auth.Image,
		utils.Config.Api.Image,
		utils.RealtimeImage,
		utils.StorageImage,
		utils.EdgeRuntimeImage,
		utils.StudioImage,
		utils.PgmetaImage,
		utils.LogflareImage,
		utils.PgbouncerImage,
		utils.ImageProxyImage,
	}

	linked := make(map[string]string)
	if projectRef, err := utils.LoadProjectRef(fsys); err == nil {
		var wg sync.WaitGroup
		wg.Add(3)
		go func() {
			defer wg.Done()
			if version, err := GetDatabaseVersion(ctx, projectRef); err == nil {
				linked[utils.Config.Db.Image] = version
			}
		}()
		go func() {
			defer wg.Done()
			if version, err := tenant.GetGotrueVersion(ctx, projectRef); err == nil {
				linked[utils.Config.Auth.Image] = version
			}
		}()
		go func() {
			defer wg.Done()
			if version, err := tenant.GetPostgrestVersion(ctx, projectRef); err == nil {
				linked[utils.Config.Api.Image] = version
			}
		}()
		wg.Wait()
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

func GetDatabaseVersion(ctx context.Context, projectRef string) (string, error) {
	resp, err := utils.GetSupabase().GetProjectsWithResponse(ctx)
	if err != nil {
		return "", err
	}
	if resp.JSON200 == nil {
		return "", errors.New("Unexpected error retrieving projects: " + string(resp.Body))
	}
	for _, project := range *resp.JSON200 {
		if project.Id == projectRef && len(project.Database.Version) > 0 {
			return project.Database.Version, nil
		}
	}
	return "", errDatabaseVersion
}
