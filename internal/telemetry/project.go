package telemetry

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

type LinkedProject struct {
	Ref              string `json:"ref"`
	Name             string `json:"name"`
	OrganizationID   string `json:"organization_id"`
	OrganizationSlug string `json:"organization_slug"`
}

func linkedProjectPath() string {
	return filepath.Join(utils.TempDir, "linked-project.json")
}

func SaveLinkedProject(project api.V1ProjectWithDatabaseResponse, fsys afero.Fs) error {
	linked := LinkedProject{
		Ref:              project.Ref,
		Name:             project.Name,
		OrganizationID:   project.OrganizationId,
		OrganizationSlug: project.OrganizationSlug,
	}
	contents, err := json.Marshal(linked)
	if err != nil {
		return errors.Errorf("failed to encode linked project: %w", err)
	}
	return utils.WriteFile(linkedProjectPath(), contents, fsys)
}

func LoadLinkedProject(fsys afero.Fs) (LinkedProject, error) {
	contents, err := afero.ReadFile(fsys, linkedProjectPath())
	if err != nil {
		return LinkedProject{}, err
	}
	var linked LinkedProject
	if err := json.Unmarshal(contents, &linked); err != nil {
		return LinkedProject{}, errors.Errorf("failed to parse linked project: %w", err)
	}
	return linked, nil
}

func linkedProjectGroups(fsys afero.Fs) map[string]string {
	linked, err := LoadLinkedProject(fsys)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return nil
	}
	groups := make(map[string]string, 2)
	if linked.OrganizationID != "" {
		groups[GroupOrganization] = linked.OrganizationID
	}
	if linked.Ref != "" {
		groups[GroupProject] = linked.Ref
	}
	if len(groups) == 0 {
		return nil
	}
	return groups
}
