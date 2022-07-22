package list

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/supabase/cli/internal/utils"
)

func Run() error {
	accessToken, err := utils.LoadAccessToken()
	if err != nil {
		return err
	}

	req, err := http.NewRequest("GET", utils.GetSupabaseAPIHost()+"/v1/organizations", nil)
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
			return fmt.Errorf("Unexpected error retrieving organizations: %w", err)
		}

		return errors.New("Unexpected error retrieving organizations: " + string(body))
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	var orgs []struct {
		Id   string `json:"id"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(body, &orgs); err != nil {
		return err
	}

	table := `|ID|NAME|
|-|-|
`
	for _, org := range orgs {
		table += fmt.Sprintf("|`%s`|`%s`|\n", org.Id, strings.ReplaceAll(org.Name, "|", "\\|"))
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
