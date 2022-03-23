package list

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/adrg/xdg"
	"github.com/charmbracelet/glamour"
	"github.com/supabase/cli/internal/utils"
)

func Run() error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUp(); err != nil {
			return err
		}
		if err := utils.AssertIsLinked(); err != nil {
			return err
		}
	}

	// 2. Print secrets.
	{
		projectRefBytes, err := os.ReadFile("supabase/.temp/project-ref")
		if err != nil {
			return err
		}
		projectRef := string(projectRefBytes)

		accessTokenPath, err := xdg.ConfigFile("supabase/access-token")
		if err != nil {
			return err
		}
		accessToken, err := os.ReadFile(accessTokenPath)
		if err != nil {
			return err
		}

		req, err := http.NewRequest("GET", "https://api.supabase.io/v1/projects/"+projectRef+"/secrets", nil)
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode != 200 {
			return errors.New("Unexpected error retrieving project secrets.")
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}

		var secrets []struct {
			Key   string
			Value string
		}
		if err := json.Unmarshal(body, &secrets); err != nil {
			return err
		}

		table := `|NAME|VALUE|
|-|-|
`
		for _, secret := range secrets {
			table += "|" + secret.Key + "|" + secret.Value + "|\n"
		}

		out, err := glamour.Render(table, "auto")
		if err != nil {
			return err
		}
		fmt.Print(out)
	}

	return nil
}
