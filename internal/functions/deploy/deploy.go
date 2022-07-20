package deploy

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
)

func Run(slug string, projectRefArg string, verifyJWT bool) error {
	// 1. Sanity checks.
	{
		if _, err := utils.LoadAccessToken(); err != nil && strings.HasPrefix(err.Error(), "Access token not provided. Supply an access token by running") {
			if err := login.Run(os.Stdin, afero.NewOsFs()); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if len(projectRefArg) == 0 {
			if err := utils.AssertIsLinked(); err != nil && strings.HasPrefix(err.Error(), "Cannot find project ref. Have you run") {
				fmt.Print(`You can find your project ref from the project's dashboard home page, e.g. https://app.supabase.io/project/<project-ref>.
Enter your project ref: `)

				scanner := bufio.NewScanner(os.Stdin)
				if !scanner.Scan() {
					fmt.Println("Cancelled " + utils.Aqua("supabase functions deploy") + ".")
					return nil
				}

				projectRef := strings.TrimSpace(scanner.Text())

				if err := utils.MkdirIfNotExist("supabase/.temp"); err != nil {
					return err
				}
				if err := os.WriteFile("supabase/.temp/project-ref", []byte(projectRef), 0644); err != nil {
					return err
				}
			} else if err != nil {
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

		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		denoBinName := "deno"
		if runtime.GOOS == "windows" {
			denoBinName = "deno.exe"
		}
		denoPath := filepath.Join(home, ".supabase", denoBinName)

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
	var data struct {
		Id string `json:"id"`
	}
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

		switch resp.StatusCode {
		case http.StatusNotFound: // Function doesn't exist yet, so do a POST
			jsonBytes, err := json.Marshal(map[string]interface{}{"slug": slug, "name": slug, "body": newFunctionBody, "verify_jwt": verifyJWT})
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

			body, err := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK {
				if err != nil {
					return fmt.Errorf("Failed to create a new Function on the Supabase project: %w", err)
				}
				return errors.New("Failed to create a new Function on the Supabase project: " + string(body))
			}
			if err := json.Unmarshal(body, &data); err != nil {
				return fmt.Errorf("Failed to create a new Function on the Supabase project: %w", err)
			}
		case http.StatusOK: // Function already exists, so do a PATCH
			jsonBytes, err := json.Marshal(map[string]interface{}{"body": newFunctionBody, "verify_jwt": verifyJWT})
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
			body, err := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK {
				if err != nil {
					return fmt.Errorf("Failed to update an existing Function's body on the Supabase project: %w", err)
				}
				return errors.New("Failed to update an existing Function's body on the Supabase project: " + string(body))
			}
			if err := json.Unmarshal(body, &data); err != nil {
				return fmt.Errorf("Failed to update an existing Function's body on the Supabase project: %w", err)
			}
		default:
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return fmt.Errorf("Unexpected error deploying Function: %w", err)
			}
			return errors.New("Unexpected error deploying Function: " + string(body))
		}
	}

	fmt.Println("Deployed Function " + utils.Aqua(slug) + " on project " + utils.Aqua(projectRef))

	url := fmt.Sprintf("https://app.supabase.io/project/%v/functions/%v/details", projectRef, data.Id)
	fmt.Println("You can inspect your deployment in the Dashboard: " + url)

	return nil
}
