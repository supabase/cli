package create

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, params api.V1CreateProjectBody, fsys afero.Fs) error {
	if err := promptMissingParams(ctx, &params); err != nil {
		return err
	}

	resp, err := utils.GetSupabase().V1CreateAProjectWithResponse(ctx, params)
	if err != nil {
		return errors.Errorf("failed to create project: %w", err)
	}
	if resp.JSON201 == nil {
		return errors.New("Unexpected error creating project: " + string(resp.Body))
	}

	flags.ProjectRef = resp.JSON201.Id
	viper.Set("DB_PASSWORD", params.DbPass)
	if err := credentials.StoreProvider.Set(flags.ProjectRef, params.DbPass); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to save database password:", err)
	}

	projectUrl := fmt.Sprintf("%s/project/%s", utils.GetSupabaseDashboardURL(), resp.JSON201.Id)
	fmt.Fprintf(os.Stderr, "Created a new project %s at %s\n", utils.Aqua(resp.JSON201.Name), utils.Bold(projectUrl))
	switch utils.OutputFormat.Value {
	case utils.OutputPretty, utils.OutputEnv:
		return nil
	}

	return utils.EncodeOutput(utils.OutputFormat.Value, os.Stdout, resp.JSON201)
}

func printKeyValue(key, value string) string {
	indent := 20 - len(key)
	spaces := strings.Repeat(" ", indent)
	return key + ":" + spaces + value
}

func promptMissingParams(ctx context.Context, body *api.V1CreateProjectBody) error {
	var err error
	if len(body.Name) == 0 {
		if body.Name, err = promptProjectName(ctx); err != nil {
			return err
		}
	} else {
		fmt.Fprintln(os.Stderr, printKeyValue("Creating project", body.Name))
	}
	if len(body.OrganizationId) == 0 {
		if body.OrganizationId, err = promptOrgId(ctx); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, printKeyValue("Selected org-id", body.OrganizationId))
	}
	if len(body.Region) == 0 {
		if body.Region, err = promptProjectRegion(ctx); err != nil {
			return err
		}
		fmt.Fprintln(os.Stderr, printKeyValue("Selected region", string(body.Region)))
	}
	if len(body.DbPass) == 0 {
		body.DbPass = flags.PromptPassword(os.Stdin)
	}
	return nil
}

func promptProjectName(ctx context.Context) (string, error) {
	title := "Enter your project name: "
	if name, err := utils.NewConsole().PromptText(ctx, title); err != nil {
		return "", err
	} else if len(name) > 0 {
		return name, nil
	}
	return "", errors.New("project name cannot be empty")
}

func promptOrgId(ctx context.Context) (string, error) {
	title := "Which organisation do you want to create the project for?"
	resp, err := utils.GetSupabase().V1ListAllOrganizationsWithResponse(ctx)
	if err != nil {
		return "", err
	}
	if resp.JSON200 == nil {
		return "", errors.New("Unexpected error retrieving organizations: " + string(resp.Body))
	}
	items := make([]utils.PromptItem, len(*resp.JSON200))
	for i, org := range *resp.JSON200 {
		items[i] = utils.PromptItem{Summary: org.Name, Details: org.Id}
	}
	choice, err := utils.PromptChoice(ctx, title, items)
	if err != nil {
		return "", err
	}
	return choice.Details, nil
}

func promptProjectRegion(ctx context.Context) (api.V1CreateProjectBodyRegion, error) {
	title := "Which region do you want to host the project in?"
	items := make([]utils.PromptItem, len(utils.RegionMap))
	i := 0
	for k, v := range utils.RegionMap {
		items[i] = utils.PromptItem{Summary: k, Details: v}
		i++
	}
	choice, err := utils.PromptChoice(ctx, title, items)
	if err != nil {
		return "", err
	}
	return api.V1CreateProjectBodyRegion(choice.Summary), nil
}
