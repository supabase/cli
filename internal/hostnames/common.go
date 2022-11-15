package hostnames

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/api"
)

func GetCustomHostnameConfig(ctx context.Context, projectRef string) (*api.GetCustomHostnameConfigResponse, error) {
	resp, err := utils.GetSupabase().GetCustomHostnameConfigWithResponse(ctx, projectRef)
	if err != nil {
		return nil, err
	}
	if resp.JSON200 == nil {
		return nil, errors.New("failed to get custom hostname config; received: " + string(resp.Body))
	}
	return resp, nil
}

func VerifyCNAME(ctx context.Context, projectRef string, customHostname string) error {
	expectedEndpoint := fmt.Sprintf("%s.", utils.GetSupabaseHost(projectRef))
	cname, err := utils.ResolveCNAME(ctx, customHostname)
	if err != nil {
		return fmt.Errorf("expected custom hostname '%s' to have a CNAME record pointing to your project at '%s', but it failed to resolve: %w", customHostname, expectedEndpoint, err)
	}
	if cname != expectedEndpoint {
		return fmt.Errorf("expected custom hostname '%s' to have a CNAME record pointing to your project at '%s', but it is currently set to '%s'", customHostname, expectedEndpoint, cname)
	}
	return nil
}

type RawResponse struct {
	Result struct {
		CustomOriginServer    string `json:"custom_origin_server"`
		OwnershipVerification struct {
			Name  string
			Type  string
			Value string
		} `json:"ownership_verification"`
		Ssl struct {
			ValidationRecords []struct {
				Status   string `json:"status"`
				TxtName  string `json:"txt_name"`
				TxtValue string `json:"txt_value"`
			} `json:"validation_records"`
			ValidationErrors []struct {
				Message string `json:"message"`
			} `json:"validation_errors"`
			Status string `json:"status"`
		}
	} `json:"result"`
}

func serializeRawOutput(response *api.UpdateCustomHostnameResponse) (string, error) {
	output, err := json.MarshalIndent(response, "", "    ")
	if err != nil {
		return "", err
	}
	return string(output), nil
}

func appendRawOutputIfNeeded(status string, response *api.UpdateCustomHostnameResponse, includeRawOutput bool) string {
	if !includeRawOutput {
		return status
	}
	rawOutput, err := serializeRawOutput(response)
	if err != nil {
		return fmt.Sprintf("%s\nFailed to serialize raw output: %+v\n", status, err)
	}
	return fmt.Sprintf("%s\nRaw output follows:\n%s\n", status, rawOutput)
}

func TranslateStatus(response *api.UpdateCustomHostnameResponse, includeRawOutput bool) (string, error) {
	if response.Status == api.N5ServicesReconfigured {
		return appendRawOutputIfNeeded(fmt.Sprintf("Custom hostname setup completed. Project is now accessible at %s.", response.CustomHostname), response, includeRawOutput), nil
	}
	if response.Status == api.N4OriginSetupCompleted {
		var res RawResponse
		rawBody, err := json.Marshal(response.Data)
		if err != nil {
			return "", fmt.Errorf("failed to serialize body: %w", err)
		}
		err = json.Unmarshal(rawBody, &res)
		if err != nil {
			return "", fmt.Errorf("failed to deserialize body: %w", err)
		}
		return appendRawOutputIfNeeded(fmt.Sprintf(`Custom hostname configuration complete, and ready for activation.

Please ensure that your custom domain is set up as a CNAME record to your Supabase subdomain:
	%s CNAME -> %s`, response.CustomHostname, res.Result.CustomOriginServer), response, includeRawOutput), nil
	}
	if response.Status == api.N2Initiated {
		var res RawResponse
		rawBody, err := json.Marshal(response.Data)
		if err != nil {
			return "", fmt.Errorf("failed to serialize body: %w", err)
		}
		err = json.Unmarshal(rawBody, &res)
		if err != nil {
			return "", fmt.Errorf("failed to deserialize body: %w", err)
		}
		owner := res.Result.OwnershipVerification
		ssl := res.Result.Ssl.ValidationRecords
		if res.Result.Ssl.Status == "initializing" {
			return appendRawOutputIfNeeded("Custom hostname setup is being initialized; please request re-verification in a few seconds.\n", response, includeRawOutput), nil
		}
		if res.Result.Ssl.ValidationErrors != nil && len(res.Result.Ssl.ValidationErrors) > 0 {
			var errorMessages []string
			for _, valError := range res.Result.Ssl.ValidationErrors {
				if strings.Contains(valError.Message, "caa_error") {
					return appendRawOutputIfNeeded("CAA mismatch; please remove any existing CAA records on your domain, or add one for \"digicert.com\"\n", response, includeRawOutput), nil
				}
				errorMessages = append(errorMessages, valError.Message)
			}
			valErrors := strings.Join(errorMessages, "\n\t- ")
			return appendRawOutputIfNeeded(fmt.Sprintf("SSL validation errors: \n\t- %s\n", valErrors), response, includeRawOutput), nil
		}
		if len(ssl) != 1 {
			return "", fmt.Errorf("expected a single SSL verification record, received: %+v", ssl)
		}
		records := ""
		if owner.Name != "" {
			records = fmt.Sprintf("\n\t%s TXT -> %s", owner.Name, owner.Value)
		}
		if ssl[0].TxtName != "" {
			records = fmt.Sprintf("%s\n\t%s TXT -> %s (replace any existing CNAME records)", records, ssl[0].TxtName, ssl[0].TxtValue)
		}
		status := fmt.Sprintf("Custom hostname verification in-progress; please configure the appropriate DNS entries and request re-verification.\n"+
			"Required outstanding validation records: %s\n",
			records)
		return appendRawOutputIfNeeded(status, response, includeRawOutput), nil
	}
	return appendRawOutputIfNeeded("Custom hostname configuration not started.", response, includeRawOutput), nil
}
