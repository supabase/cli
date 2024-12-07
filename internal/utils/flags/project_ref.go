package flags

import (
	"bytes"
	"context"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/term"
)

var ProjectRef string

func ParseProjectRef(ctx context.Context, fsys afero.Fs) error {
	if err := LoadProjectRef(fsys); !errors.Is(err, utils.ErrNotLinked) {
		return err
	}
	// Prompt as the last resort
	if term.IsTerminal(int(os.Stdin.Fd())) {
		return PromptProjectRef(ctx, "Select a project:")
	}
	return errors.New(utils.ErrNotLinked)
}

func PromptProjectRef(ctx context.Context, title string, opts ...tea.ProgramOption) error {
	resp, err := utils.GetSupabase().V1ListAllProjectsWithResponse(ctx)
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
	choice, err := utils.PromptChoice(ctx, title, items, opts...)
	if err != nil {
		return err
	}
	ProjectRef = choice.Summary
	fmt.Fprintln(os.Stderr, "Selected project:", ProjectRef)
	return nil
}

func LoadProjectRef(fsys afero.Fs) error {
	// Flag takes highest precedence
	if len(ProjectRef) > 0 {
		return utils.AssertProjectRefIsValid(ProjectRef)
	}
	// Env var takes precedence over ref file
	if ProjectRef = viper.GetString("PROJECT_ID"); len(ProjectRef) > 0 {
		return utils.AssertProjectRefIsValid(ProjectRef)
	}
	// Load from local file last
	projectRefBytes, err := afero.ReadFile(fsys, utils.ProjectRefPath)
	if errors.Is(err, os.ErrNotExist) {
		return errors.New(utils.ErrNotLinked)
	} else if err != nil {
		return errors.Errorf("failed to load project ref: %w", err)
	}
	ProjectRef = string(bytes.TrimSpace(projectRefBytes))
	return utils.AssertProjectRefIsValid(ProjectRef)
}
