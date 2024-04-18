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

func Run(ctx context.Context, params api.CreateProjectBody, fsys afero.Fs) error {
	if err := promptMissingParams(ctx, &params); err != nil {
		return err
	}

	resp, err := utils.GetSupabase().CreateProjectWithResponse(ctx, params)
	if err != nil {
		return errors.Errorf("failed to create project: %w", err)
	}
	if resp.JSON201 == nil {
		return errors.New("Unexpected error creating project: " + string(resp.Body))
	}

	flags.ProjectRef = resp.JSON201.Id
	viper.Set("DB_PASSWORD", params.DbPass)
	if err := credentials.Set(flags.ProjectRef, params.DbPass); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to save database password:", err)
	}

	projectUrl := fmt.Sprintf("%s/project/%s", utils.GetSupabaseDashboardURL(), resp.JSON201.Id)
	fmt.Printf("Created a new project %s at %s\n", utils.Aqua(resp.JSON201.Name), utils.Bold(projectUrl))
	return nil
}

func printKeyValue(key, value string) string {
	indent := 20 - len(key)
	spaces := strings.Repeat(" ", indent)
	return key + ":" + spaces + value
}

func promptMissingParams(ctx context.Context, body *api.CreateProjectBody) error {
	var err error
	if len(body.Name) == 0 {
		if body.Name, err = promptProjectName(); err != nil {
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

func promptProjectName() (string, error) {
	name, err := utils.NewConsole().PromptText("Enter your project name: ")
	if err != nil {
		return "", err
	}
	if len(name) == 0 {
		return "", errors.New("project name cannot be empty")
	}
	return name, nil
}

func promptOrgId(ctx context.Context) (string, error) {
	title := "Which organisation do you want to create the project for?"
	resp, err := utils.GetSupabase().GetOrganizationsWithResponse(ctx)
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

func promptProjectRegion(ctx context.Context) (api.CreateProjectBodyRegion, error) {
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
	return api.CreateProjectBodyRegion(choice.Summary), nil
}
