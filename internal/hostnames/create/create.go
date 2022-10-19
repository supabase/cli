package create

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/hostnames"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func Run(ctx context.Context, projectRefArg string, customHostname string, includeRawOutput bool, fsys afero.Fs) error {
	// 1. Sanity checks.
	projectRef := projectRefArg
	hostname := strings.TrimSpace(customHostname)
	{
		if len(projectRefArg) == 0 {
			ref, err := utils.LoadProjectRef(fsys)
			if err != nil {
				return err
			}
			projectRef = ref
		} else if !utils.ProjectRefPattern.MatchString(projectRef) {
			return errors.New("Invalid project ref format. Must be like `abcdefghijklmnopqrst`.")
		}
		if len(hostname) == 0 {
			return errors.New("non-empty custom hostname expected")
		}
		// we verify that a CNAME is set as it simplifies the checks used for verifying ownership
		err := hostnames.VerifyCNAME(ctx, projectRef, hostname)
		if err != nil {
			return err
		}
	}

	// 2. create custom hostname
	{
		resp, err := utils.GetSupabase().CreateCustomHostnameConfigWithResponse(ctx, projectRef, api.CreateCustomHostnameConfigJSONRequestBody{
			CustomHostname: hostname,
		})
		if err != nil {
			return err
		}
		if resp.JSON201 == nil {
			return errors.New("failed to create custom hostname config: " + string(resp.Body))
		}
		status, err := hostnames.TranslateStatus(resp.JSON201, includeRawOutput)
		if err != nil {
			return err
		}
		fmt.Println(status)
		return nil
	}
}
