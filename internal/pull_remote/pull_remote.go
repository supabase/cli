package pull_remote

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/go-errors/errors"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
	cliConfig "github.com/supabase/cli/pkg/config"
)

func Run(ctx context.Context, projectRef string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if err := checkRemoteProjectStatus(ctx, projectRef); err != nil {
		return err
	}

	client := utils.GetSupabase()

	newConfig := utils.Config.Clone()
	newConfig.ProjectId = projectRef
	updater := cliConfig.NewConfigUpdater(*client)
	if err := updater.UpdateLocalConfig(ctx, newConfig); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
		return err
	}
	return nil
}

var errProjectPaused = errors.New("project is paused")

func checkRemoteProjectStatus(ctx context.Context, projectRef string) error {
	resp, err := utils.GetSupabase().V1GetProjectWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to retrieve remote project status: %w", err)
	}
	switch resp.StatusCode() {
	case http.StatusNotFound:
		// Ignore not found error to support linking branch projects
		return nil
	case http.StatusOK:
		// resp.JSON200 is not nil, proceed
	default:
		return errors.New("Unexpected error retrieving remote project status: " + string(resp.Body))
	}

	switch resp.JSON200.Status {
	case api.V1ProjectResponseStatusINACTIVE:
		utils.CmdSuggestion = fmt.Sprintf("An admin must unpause it from the Supabase dashboard at %s", utils.Aqua(fmt.Sprintf("%s/project/%s", utils.GetSupabaseDashboardURL(), projectRef)))
		return errors.New(errProjectPaused)
	case api.V1ProjectResponseStatusACTIVEHEALTHY:
		// Project is in the desired state, do nothing
	default:
		fmt.Fprintf(os.Stderr, "%s: Project status is %s instead of Active Healthy. Some operations might fail.\n", utils.Yellow("WARNING"), resp.JSON200.Status)
	}

	return nil
}
