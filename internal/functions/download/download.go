package download

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os/exec"
	"path/filepath"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

func Run(ctx context.Context, slug string, projectRefArg string, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg
	var scriptDirPath string
	{
		if len(projectRefArg) == 0 {
			ref, err := utils.LoadProjectRef(fsys)
			if err != nil {
				return err
			}
			projectRef = ref
		} else if !utils.ProjectRefPattern.MatchString(projectRefArg) {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}
		if err := utils.ValidateFunctionSlug(slug); err != nil {
			return err
		}
	}
	if err := utils.InstallOrUpgradeDeno(ctx, fsys); err != nil {
		return err
	}

	var err error
	scriptDirPath, err = utils.CopyDenoScripts(ctx, fsys)
	if err != nil {
		return err
	}

	// 2. Download Function.
	{
		fmt.Println("Downloading " + utils.Bold(slug))
		denoPath, err := utils.GetDenoPath()
		if err != nil {
			return err
		}

		resp, err := utils.GetSupabase().GetFunctionBodyWithResponse(ctx, projectRef, slug, func(ctx context.Context, req *http.Request) error {
			// set encoding header
			req.Header.Set("Accept-Encoding", "br")
			return nil
		})
		if err != nil {
			return err
		}

		switch resp.StatusCode() {
		case http.StatusNotFound: // Function doesn't exist
			return errors.New("Function " + utils.Aqua(slug) + " does not exist on the Supabase project.")
		case http.StatusOK: // Function exists
			resBuf := bytes.NewReader(resp.Body)

			extractScriptPath := filepath.Join(scriptDirPath, "extract.ts")
			funcDir := filepath.Join(utils.FunctionsDir, slug)
			var outBuf, errBuf bytes.Buffer
			args := []string{"run", "-A", extractScriptPath, funcDir}
			cmd := exec.CommandContext(ctx, denoPath, args...)
			cmd.Stdin = resBuf
			cmd.Stdout = &outBuf
			cmd.Stderr = &errBuf
			if err := cmd.Run(); err != nil {
				return fmt.Errorf("Error downloading function: %w\n%v", err, errBuf.String())
			}

			fmt.Println(outBuf.String())
		default:
			return errors.New("Unexpected error downloading Function: " + string(resp.Body))
		}
	}

	fmt.Println("Downloaded Function " + utils.Aqua(slug) + " from project " + utils.Aqua(projectRef) + ".")
	return nil
}
