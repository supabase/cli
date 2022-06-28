package create

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"github.com/supabase/cli/internal/utils"
)

func Run(name string, orgId uint, dbPassword string, region string, plan string) error {
	accessToken, err := utils.LoadAccessToken()
	if err != nil {
		return err
	}

	// TODO: Prompt missing args.
	{
	}

	// POST request, check errors
	var project struct {
		Id     uint   `json:"id"`
		Ref    string `json:"ref"`
		Name   string `json:"name"`
		OrgId  uint   `json:"organization_id"`
		Region string `json:"region"`
	}
	{
		jsonBytes, err := json.Marshal(map[string]interface{}{
			"organization_id": orgId,
			"name":            name,
			"db_pass":         dbPassword,
			"region":          region,
			"plan":            plan,
		})
		if err != nil {
			return err
		}

		req, err := http.NewRequest("POST", "https://api.supabase.io/v1/projects", bytes.NewReader(jsonBytes))
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

		if resp.StatusCode != http.StatusOK {
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

	fmt.Printf("Created a new project %s at %s\n", utils.Aqua(project.Name), utils.Aqua("https://app.supabase.com/project/"+project.Ref))
	return nil
}
