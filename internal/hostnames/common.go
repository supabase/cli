package hostnames

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/go-errors/errors"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func VerifyCNAME(ctx context.Context, projectRef string, customHostname string) error {
	expectedEndpoint := fmt.Sprintf("%s.", utils.GetSupabaseHost(projectRef))
	if cname, err := utils.ResolveCNAME(ctx, customHostname); err != nil {
		return errors.Errorf("expected custom hostname '%s' to have a CNAME record pointing to your project at '%s', but it failed to resolve: %w", customHostname, expectedEndpoint, err)
	} else if cname != expectedEndpoint {
		return errors.Errorf("expected custom hostname '%s' to have a CNAME record pointing to your project at '%s', but it is currently set to '%s'", customHostname, expectedEndpoint, cname)
	}
	return nil
}

func PrintStatus(response *api.UpdateCustomHostnameResponse, w io.Writer) {
	switch response.Status {
	case api.N5ServicesReconfigured:
		fmt.Fprintf(w, "Custom hostname setup completed. Project is now accessible at %s.", response.CustomHostname)
	case api.N4OriginSetupCompleted:
		fmt.Fprintf(w, `Custom hostname configuration complete, and ready for activation.

Please ensure that your custom domain is set up as a CNAME record to your Supabase subdomain:
%s CNAME -> %s`, response.CustomHostname, response.Data.Result.CustomOriginServer)
	case api.N3ChallengeVerified, api.N2Initiated:
		if ssl := response.Data.Result.Ssl; ssl.Status == "initializing" {
			fmt.Fprintln(w, "Custom hostname setup is being initialized; please request re-verification in a few seconds.")
		} else if errVal := response.Data.Result.Ssl.ValidationErrors; errVal != nil && len(*errVal) > 0 {
			var errorMessages []string
			for _, valError := range *errVal {
				if strings.Contains(valError.Message, "caa_error") {
					fmt.Fprintln(w, `CAA mismatch; please remove any existing CAA records on your domain, or add one for "digicert.com"`)
					return
				}
				errorMessages = append(errorMessages, valError.Message)
			}
			valErrors := strings.Join(errorMessages, "\n\t- ")
			fmt.Fprintf(w, "SSL validation errors: \n\t- %s\n", valErrors)
		} else if len(ssl.ValidationRecords) != 1 {
			fmt.Fprintf(w, "expected a single SSL verification record, received: %+v", ssl)
		} else {
			fmt.Fprintln(w, `Custom hostname verification in-progress; please configure the appropriate DNS entries and request re-verification.
Required outstanding validation records:`)
			if rec := ssl.ValidationRecords[0]; rec.TxtName != "" {
				fmt.Fprintf(w, "\t%s TXT -> %s", rec.TxtName, rec.TxtValue)
			}
		}
	case api.N1NotStarted:
		fmt.Fprintln(w, "Custom hostname configuration not started.")
	}
}
