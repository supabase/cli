package telemetry

import (
	"encoding/json"
	"fmt"
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

// HasLinkedProject reports whether a cached linked-project.json exists.
func HasLinkedProject(fsys afero.Fs) bool {
	_, err := LoadLinkedProject(fsys)
	return err == nil
}

// CacheProjectAndIdentifyGroups writes project metadata to linked-project.json
// and fires GroupIdentify for the org and project so PostHog has group metadata.
// This matches the behavior of the `supabase link` flow.
//
// The caller is responsible for fetching the project from the API and checking
// auth — this function only handles caching and PostHog group identification.
//
// Best-effort: logs errors to debug output, never returns them.
func CacheProjectAndIdentifyGroups(project api.V1ProjectWithDatabaseResponse, service *Service, fsys afero.Fs) {
	if err := SaveLinkedProject(project, fsys); err != nil {
		fmt.Fprintln(utils.GetDebugLogger(), err)
	}
	if service == nil {
		return
	}
	if project.OrganizationId != "" {
		if err := service.GroupIdentify(GroupOrganization, project.OrganizationId, map[string]any{
			"organization_slug": project.OrganizationSlug,
		}); err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		}
	}
	if project.Ref != "" {
		if err := service.GroupIdentify(GroupProject, project.Ref, map[string]any{
			"name":              project.Name,
			"organization_slug": project.OrganizationSlug,
		}); err != nil {
			fmt.Fprintln(utils.GetDebugLogger(), err)
		}
	}
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
