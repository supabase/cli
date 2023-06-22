package create

import (
	"context"
	"fmt"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, params api.CreateProjectBody, fsys afero.Fs) error {
	// TODO: Prompt missing args.
	{
	}

	resp, err := utils.GetSupabase().CreateProjectWithResponse(ctx, params)
	if err != nil {
		return utils.Red(err.Error())
	}

	if resp.JSON201 == nil {
		return utils.Red("Unexpected error creating project: " + string(resp.Body))
	}

	// TODO: Poll until PostgREST is reachable.
	{
	}

	fmt.Printf(
		"Created a new project %s at %s\n",
		utils.Aqua(resp.JSON201.Name),
		utils.Aqua(utils.GetSupabaseDashboardURL()+"/project/"+resp.JSON201.Id),
	)
	return nil
}
