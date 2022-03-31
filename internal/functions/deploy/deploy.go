package deploy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"

	"github.com/adrg/xdg"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
)

func Run(slug string, projectRefArg string) error {
	// 1. Sanity checks.
	{
		if _, err := utils.LoadAccessToken(); err != nil && strings.HasPrefix(err.Error(), "Access token not provided. Supply an access token by running") {
			if err := login.Run(); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if len(projectRefArg) == 0 {
			if err := utils.AssertIsLinked(); err != nil {
				return err
			}
		} else {
			matched, err := regexp.MatchString(`^[a-z]{20}$`, projectRefArg)
			if err != nil {
				return err
			}
			if !matched {
				return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
			}
		}
		if err := utils.InstallOrUpgradeDeno(); err != nil {
			return err
		}
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}

	// 2. Bundle Function.
	var newFunctionBody string
	{
		fmt.Println("Bundling " + utils.Bold(slug))

		denoPath, err := xdg.ConfigFile("supabase/deno")
		if err != nil {
			return err
		}

		functionPath := "supabase/functions/" + slug
		if _, err := os.Stat(functionPath); errors.Is(err, os.ErrNotExist) {
			// allow deploy from within supabase/
			functionPath = "functions/" + slug
			if _, err := os.Stat(functionPath); errors.Is(err, os.ErrNotExist) {
				// allow deploy from current directory
				functionPath = slug
			}
		}

		cmd := exec.Command(denoPath, "bundle", "--quiet", functionPath+"/index.ts")
		var outBuf, errBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &errBuf
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("Error bundling function: %w\n%v", err, errBuf.String())
		}

		newFunctionBody = outBuf.String()
	}

	// 3. Deploy new Function.
	var projectRef string
	{
		// --project-ref overrides value on disk
		if len(projectRefArg) == 0 {
			projectRefBytes, err := os.ReadFile("supabase/.temp/project-ref")
			if err != nil {
				return err
			}
			projectRef = string(projectRefBytes)
		} else {
			projectRef = projectRefArg
		}

		accessToken, err := utils.LoadAccessToken()
		if err != nil {
			return err
		}

		req, err := http.NewRequest("GET", "https://api.supabase.io/v1/projects/"+projectRef+"/functions/"+slug, nil)
		if err != nil {
			return err
		}
		req.Header.Add("Authorization", "Bearer "+string(accessToken))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return err
		}
		defer resp.Body.Close()

		if resp.StatusCode == 404 { // Function doesn't exist yet, so do a POST
			jsonBytes, err := json.Marshal(map[string]string{"slug": slug, "name": slug, "body": newFunctionBody})
			if err != nil {
				return err
			}

			req, err := http.NewRequest("POST", "https://api.supabase.io/v1/projects/"+projectRef+"/functions", bytes.NewReader(jsonBytes))
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
			if resp.StatusCode != 200 {
				body, err := io.ReadAll(resp.Body)
				if err != nil {
					return fmt.Errorf("Failed to create a new Function on the Supabase project: %w", err)
				}

				return errors.New("Failed to create a new Function on the Supabase project: " + string(body))
			}
		} else if resp.StatusCode == 200 { // Function already exists, so do a PATCH
			jsonBytes, err := json.Marshal(map[string]string{"body": newFunctionBody})
			if err != nil {
				return err
			}

			req, err := http.NewRequest("PATCH", "https://api.supabase.io/v1/projects/"+projectRef+"/functions/"+slug, bytes.NewReader(jsonBytes))
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
			if resp.StatusCode != 200 {
				body, err := io.ReadAll(resp.Body)
				if err != nil {
					return fmt.Errorf("Failed to update an existing Function's body on the Supabase project: %w", err)
				}

				return errors.New("Failed to update an existing Function's body on the Supabase project: " + string(body))
			}
		} else {
			return errors.New("Unexpected error deploying Function.")
		}
	}

	fmt.Println("Deployed Function " + utils.Aqua(slug) + " on project " + utils.Aqua(projectRef) + ".")
	return nil
}
