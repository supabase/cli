package create

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/projects/list"
	"github.com/supabase/cli/internal/utils"
)

type RequestParam struct {
	OrgId  string `json:"organization_id"`
	Name   string `json:"name"`
	DbPass string `json:"db_pass"`
	Region string `json:"region"`
	Plan   string `json:"plan"`
}

func Run(params RequestParam, fsys afero.Fs) error {
	accessToken, err := utils.LoadAccessTokenFS(fsys)
	if err != nil {
		return err
	}

	// TODO: Prompt missing args.
	{
	}

	// POST request, check errors
	var project list.Project
	{
		jsonBytes, err := json.Marshal(params)
		if err != nil {
			return err
		}

		req, err := http.NewRequest("POST", utils.GetSupabaseAPIHost()+"/v1/projects", bytes.NewReader(jsonBytes))
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		req.Header.Add("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return fmt.Errorf("Unexpected error creating project: %w", err)
			}

			return errors.New("Unexpected error creating project: " + string(body))
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		if err := json.Unmarshal(body, &project); err != nil {
			return fmt.Errorf("Failed to create a new project: %w", err)
		}
	}

	// TODO: Poll until PostgREST is reachable.
	{
	}

	fmt.Printf("Created a new project %s at %s\n", utils.Aqua(project.Name), utils.Aqua(utils.GetSupabaseDashboardURL()+"/project/"+project.Id))
	return nil
}
