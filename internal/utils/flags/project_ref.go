package flags

import (
	"bytes"
	"context"
	"fmt"
	"os"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/term"
)

var ProjectRef string

func ParseProjectRef(ctx context.Context, fsys afero.Fs) error {
	// Flag takes highest precedence
	if len(ProjectRef) == 0 {
		ProjectRef = viper.GetString("PROJECT_ID")
	}
	if len(ProjectRef) > 0 {
		return utils.AssertProjectRefIsValid(ProjectRef)
	}
	// Followed by linked ref file
	if _, err := LoadProjectRef(fsys); !errors.Is(err, utils.ErrNotLinked) {
		return err
	}
	// Prompt as the last resort
	if term.IsTerminal(int(os.Stdin.Fd())) {
		return PromptProjectRef(ctx, "Select a project:")
	}
	return errors.New(utils.ErrNotLinked)
}

func PromptProjectRef(ctx context.Context, title string) error {
	resp, err := utils.GetSupabase().GetProjectsWithResponse(ctx)
	if err != nil {
		return errors.Errorf("failed to retrieve projects: %w", err)
	}
	if resp.JSON200 == nil {
		return errors.New("Unexpected error retrieving projects: " + string(resp.Body))
	}
	items := make([]utils.PromptItem, len(*resp.JSON200))
	for i, project := range *resp.JSON200 {
		items[i] = utils.PromptItem{
			Summary: project.Id,
			Details: fmt.Sprintf("name: %s, org: %s, region: %s", project.Name, project.OrganizationId, project.Region),
		}
	}
	choice, err := utils.PromptChoice(ctx, title, items)
	if err != nil {
		return err
	}
	ProjectRef = choice.Summary
	fmt.Fprintln(os.Stderr, "Selected project:", ProjectRef)
	return nil
}

func LoadProjectRef(fsys afero.Fs) (string, error) {
	projectRefBytes, err := afero.ReadFile(fsys, utils.ProjectRefPath)
	if errors.Is(err, os.ErrNotExist) {
		return "", errors.New(utils.ErrNotLinked)
	} else if err != nil {
		return "", errors.Errorf("failed to load project ref: %w", err)
	}
	ProjectRef = string(bytes.TrimSpace(projectRefBytes))
	if err := utils.AssertProjectRefIsValid(ProjectRef); err != nil {
		return "", err
	}
	return ProjectRef, nil
}
