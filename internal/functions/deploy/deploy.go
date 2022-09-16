package deploy

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, slug string, projectRefArg string, verifyJWT bool, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg
	{
		if _, err := utils.LoadAccessTokenFS(fsys); err != nil && strings.HasPrefix(err.Error(), "Access token not provided. Supply an access token by running") {
			if err := login.Run(os.Stdin, fsys); err != nil {
				return err
			}
		} else if err != nil {
			return err
		}
		if len(projectRefArg) == 0 {
			if err := utils.AssertIsLinkedFS(fsys); err != nil && strings.HasPrefix(err.Error(), "Cannot find project ref. Have you run") {
				fmt.Printf(`You can find your project ref from the project's dashboard home page, e.g. %s/project/<project-ref>.
Enter your project ref: `, utils.GetSupabaseDashboardURL())

				scanner := bufio.NewScanner(os.Stdin)
				if !scanner.Scan() {
					fmt.Println("Cancelled " + utils.Aqua("supabase functions deploy") + ".")
					return nil
				}

				projectRef = strings.TrimSpace(scanner.Text())
			} else if err != nil {
				return err
			}
		}
		if !utils.ProjectRefPattern.MatchString(projectRef) {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}
		if len(projectRefArg) == 0 {
			if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(utils.ProjectRefPath)); err != nil {
				return err
			}
			if err := afero.WriteFile(fsys, utils.ProjectRefPath, []byte(projectRef), 0644); err != nil {
				return err
			}
		}
		if err := utils.InstallOrUpgradeDeno(ctx, fsys); err != nil {
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
		denoPath, err := utils.GetDenoPath()
		if err != nil {
			return err
		}

		functionPath := filepath.Join(utils.FunctionsDir, slug)
		if _, err := fsys.Stat(functionPath); errors.Is(err, os.ErrNotExist) {
			// allow deploy from within supabase/
			functionPath = filepath.Join("functions", slug)
			if _, err := fsys.Stat(functionPath); errors.Is(err, os.ErrNotExist) {
				// allow deploy from current directory
				functionPath = slug
			}
		}

		args := []string{"bundle", "--no-check=remote", "--quiet", filepath.Join(functionPath, "index.ts")}
		cmd := exec.CommandContext(ctx, denoPath, args...)
		var outBuf, errBuf bytes.Buffer
		cmd.Stdout = &outBuf
		cmd.Stderr = &errBuf
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("Error bundling function: %w\n%v", err, errBuf.String())
		}

		newFunctionBody = outBuf.String()
	}

	// 3. Deploy new Function.
	var deployedFuncId string
	{
		resp, err := utils.GetSupabase().GetFunctionWithResponse(ctx, projectRef, slug, &api.GetFunctionParams{})
		if err != nil {
			return err
		}

		switch resp.StatusCode() {
		case http.StatusNotFound: // Function doesn't exist yet, so do a POST
			resp, err := utils.GetSupabase().CreateFunctionWithResponse(ctx, projectRef, api.CreateFunctionBody{
				Body:      newFunctionBody,
				Name:      slug,
				Slug:      slug,
				VerifyJwt: &verifyJWT,
			})
			if err != nil {
				return err
			}
			if resp.JSON201 == nil {
				return errors.New("Failed to create a new Function on the Supabase project: " + string(resp.Body))
			}
			deployedFuncId = resp.JSON201.Id
		case http.StatusOK: // Function already exists, so do a PATCH
			resp, err := utils.GetSupabase().UpdateFunctionWithResponse(ctx, projectRef, slug, api.UpdateFunctionBody{
				Body:      &newFunctionBody,
				VerifyJwt: &verifyJWT,
			})
			if err != nil {
				return err
			}
			if resp.JSON200 == nil {
				return errors.New("Failed to update an existing Function's body on the Supabase project: " + string(resp.Body))
			}
			deployedFuncId = resp.JSON200.Id
		default:
			return errors.New("Unexpected error deploying Function: " + string(resp.Body))
		}
	}

	fmt.Println("Deployed Function " + utils.Aqua(slug) + " on project " + utils.Aqua(projectRef))

	url := fmt.Sprintf("%s/project/%v/functions/%v/details", utils.GetSupabaseDashboardURL(), projectRef, deployedFuncId)
	fmt.Println("You can inspect your deployment in the Dashboard: " + url)

	return nil
}
