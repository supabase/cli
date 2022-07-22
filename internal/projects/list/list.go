package list

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type Project struct {
	OrgId     string `json:"organization_id"`
	Id        string `json:"id"`
	Name      string `json:"name"`
	Region    string `json:"region"`
	CreatedAt string `json:"created_at"`
}

func Run(fsys afero.Fs) error {
	accessToken, err := utils.LoadAccessTokenFS(fsys)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("GET", utils.GetSupabaseAPIHost()+"/v1/projects", nil)
	if err != nil {
		return err
	}
	req.Header.Add("Authorization", "Bearer "+string(accessToken))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return fmt.Errorf("Unexpected error retrieving projects: %w", err)
		}

		return errors.New("Unexpected error retrieving projects: " + string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var projects []Project
	if err := json.Unmarshal(body, &projects); err != nil {
		return err
	}

	// TODO: Add CREATED AT
	table := `|ORG ID|ID|NAME|REGION|
|-|-|-|-|
`
	for _, project := range projects {
		table += fmt.Sprintf("|`%s`|`%s`|`%s`|`%s`|\n", project.OrgId, project.Id, strings.ReplaceAll(project.Name, "|", "\\|"), utils.RegionMap[project.Region])
	}

	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return err
	}
	out, err := r.Render(table)
	if err != nil {
		return err
	}
	fmt.Print(out)

	return nil
}
