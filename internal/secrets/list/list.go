package list

import (
	"crypto/md5"
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

type Secret struct {
	Name  string
	Value string
}

func Run(fsys afero.Fs) error {
	// 1. Sanity checks.
	{
		if err := utils.AssertSupabaseCliIsSetUpFS(fsys); err != nil {
			return err
		}
		if err := utils.AssertIsLinkedFS(fsys); err != nil {
			return err
		}
	}

	// 2. Print secrets.
	{
		projectRefBytes, err := afero.ReadFile(fsys, utils.ProjectRefPath)
		if err != nil {
			return err
		}
		projectRef := string(projectRefBytes)

		accessToken, err := utils.LoadAccessTokenFS(fsys)
		if err != nil {
			return err
		}

		req, err := http.NewRequest("GET", utils.GetSupabaseAPIHost()+"/v1/projects/"+projectRef+"/secrets", nil)
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
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return fmt.Errorf("Unexpected error retrieving project secrets: %w", err)
			}

			return errors.New("Unexpected error retrieving project secrets: " + string(body))
		}

		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}

		var secrets []Secret
		if err := json.Unmarshal(body, &secrets); err != nil {
			return err
		}

		table := `|NAME|DIGEST|
|-|-|
`
		for _, secret := range secrets {
			table += fmt.Sprintf("|`%s`|`%x`|\n", strings.ReplaceAll(secret.Name, "|", "\\|"), md5.Sum([]byte(secret.Value)))
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
	}

	return nil
}
