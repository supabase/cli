package config

import (
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/go-errors/errors"
	v1API "github.com/supabase/cli/pkg/api"
)

type ConfigUpdater struct {
	client v1API.ClientWithResponses
}

func NewConfigUpdater(client v1API.ClientWithResponses) ConfigUpdater {
	return ConfigUpdater{client: client}
}

func (u *ConfigUpdater) UpdateRemoteConfig(ctx context.Context, remote baseConfig, filter ...func(string) bool) error {
	if err := u.UpdateApiConfig(ctx, remote.ProjectId, remote.Api, filter...); err != nil {
		return err
	}
	if err := u.UpdateDbConfig(ctx, remote.ProjectId, remote.Db, filter...); err != nil {
		return err
	}
	if err := u.UpdateAuthConfig(ctx, remote.ProjectId, remote.Auth, filter...); err != nil {
		return err
	}
	if err := u.UpdateStorageConfig(ctx, remote.ProjectId, remote.Storage, filter...); err != nil {
		return err
	}
	if err := u.UpdateExperimentalConfig(ctx, remote.ProjectId, remote.Experimental, filter...); err != nil {
		return err
	}
	return nil
}

func (u *ConfigUpdater) UpdateApiConfig(ctx context.Context, projectRef string, c api, filter ...func(string) bool) error {
	apiConfig, err := u.client.V1GetPostgrestServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read API config: %w", err)
	} else if apiConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", apiConfig.StatusCode(), string(apiConfig.Body))
	}
	apiDiff, err := c.DiffWithRemote(*apiConfig.JSON200)
	if err != nil {
		return err
	} else if len(apiDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote API config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating API service with config:", string(apiDiff))
	for _, keep := range filter {
		if !keep("api") {
			return nil
		}
	}
	if resp, err := u.client.V1UpdatePostgrestServiceConfigWithResponse(ctx, projectRef, c.ToUpdatePostgrestConfigBody()); err != nil {
		return errors.Errorf("failed to update API config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return nil
}

func (u *ConfigUpdater) UpdateDbSettingsConfig(ctx context.Context, projectRef string, s settings, filter ...func(string) bool) error {
	dbConfig, err := u.client.V1GetPostgresConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read DB config: %w", err)
	} else if dbConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", dbConfig.StatusCode(), string(dbConfig.Body))
	}
	dbDiff, err := s.DiffWithRemote(*dbConfig.JSON200)
	if err != nil {
		return err
	} else if len(dbDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote DB config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating DB service with config:", string(dbDiff))
	for _, keep := range filter {
		if !keep("db") {
			return nil
		}
	}
	updateBody := s.ToUpdatePostgresConfigBody()
	if resp, err := u.client.V1UpdatePostgresConfigWithResponse(ctx, projectRef, updateBody); err != nil {
		return errors.Errorf("failed to update DB config: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return nil
}

func (u *ConfigUpdater) UpdateDbConfig(ctx context.Context, projectRef string, c db, filter ...func(string) bool) error {
	if err := u.UpdateDbSettingsConfig(ctx, projectRef, c.Settings, filter...); err != nil {
		return err
	}
	if err := u.UpdateDbNetworkRestrictionsConfig(ctx, projectRef, c.NetworkRestrictions, filter...); err != nil {
		return err
	}
	return nil
}

func (u *ConfigUpdater) UpdateDbNetworkRestrictionsConfig(ctx context.Context, projectRef string, n networkRestrictions, filter ...func(string) bool) error {
	networkRestrictionsConfig, err := u.client.V1GetNetworkRestrictionsWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read network restrictions config: %w", err)
	} else if networkRestrictionsConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", networkRestrictionsConfig.StatusCode(), string(networkRestrictionsConfig.Body))
	}
	networkRestrictionsDiff, err := n.DiffWithRemote(*networkRestrictionsConfig.JSON200)
	if err != nil {
		return err
	} else if len(networkRestrictionsDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote DB Network restrictions config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating network restrictions with config:", string(networkRestrictionsDiff))
	for _, keep := range filter {
		if !keep("db") {
			return nil
		}
	}
	updateBody := n.ToUpdateNetworkRestrictionsBody()
	if resp, err := u.client.V1UpdateNetworkRestrictionsWithResponse(ctx, projectRef, updateBody); err != nil {
		return errors.Errorf("failed to update network restrictions config: %w", err)
	} else if resp.JSON201 == nil {
		return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	return nil
}

func (u *ConfigUpdater) UpdateAuthConfig(ctx context.Context, projectRef string, c auth, filter ...func(string) bool) error {
	if !c.Enabled {
		return nil
	}
	authConfig, err := u.client.V1GetAuthServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read Auth config: %w", err)
	} else if authConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", authConfig.StatusCode(), string(authConfig.Body))
	}

	// Check if we need to update third-party auth configuration
	tpaNeedsUpdate, tpaChanges, err := u.checkThirdPartyAuthChanges(ctx, projectRef, c.ThirdParty, filter...)
	if err != nil {
		return errors.Errorf("failed to check third-party auth changes: %w", err)
	}

	authDiff, err := c.DiffWithRemote(*authConfig.JSON200, filter...)
	if err != nil {
		return err
	}

	// If neither auth config nor TPA needs updates, we're done
	if len(authDiff) == 0 && !tpaNeedsUpdate {
		fmt.Fprintln(os.Stderr, "Remote Auth config is up to date.")
		return nil
	}

	// Show what changes will be made
	if len(authDiff) > 0 {
		fmt.Fprintln(os.Stderr, "Updating Auth service with config:", string(authDiff))
	}
	if tpaNeedsUpdate && len(tpaChanges) > 0 {
		fmt.Fprintln(os.Stderr, "Third-party auth changes:")
		for _, change := range tpaChanges {
			fmt.Fprintln(os.Stderr, " -", change)
		}
	}

	for _, keep := range filter {
		if !keep("auth") {
			return nil
		}
	}

	// Update regular auth configuration
	if len(authDiff) > 0 {
		if resp, err := u.client.V1UpdateAuthServiceConfigWithResponse(ctx, projectRef, c.ToUpdateAuthConfigBody()); err != nil {
			return errors.Errorf("failed to update Auth config: %w", err)
		} else if status := resp.StatusCode(); status < 200 || status >= 300 {
			return errors.Errorf("unexpected status %d: %s", status, string(resp.Body))
		}
	}

	// Update third-party auth configuration
	if tpaNeedsUpdate {
		if err := u.updateThirdPartyAuthConfig(ctx, projectRef, c.ThirdParty, filter...); err != nil {
			return errors.Errorf("failed to update third-party auth config: %w", err)
		}
	}

	return nil
}

func (u *ConfigUpdater) UpdateSigningKeys(ctx context.Context, projectRef string, signingKeys []JWK, filter ...func(string) bool) error {
	if len(signingKeys) == 0 {
		return nil
	}
	resp, err := u.client.V1GetProjectSigningKeysWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to fetch signing keys: %w", err)
	} else if resp.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
	}
	exists := map[string]struct{}{}
	for _, k := range resp.JSON200.Keys {
		if k.PublicJwk != nil {
			exists[k.Id.String()] = struct{}{}
		}
	}
	var toInsert []JWK
	for _, k := range signingKeys {
		if _, ok := exists[k.KeyID]; !ok {
			toInsert = append(toInsert, k)
		}
	}
	if len(toInsert) == 0 {
		fmt.Fprintln(os.Stderr, "Remote JWT signing keys are up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "JWT signing keys to insert:")
	for _, k := range toInsert {
		fmt.Fprintln(os.Stderr, " -", k.KeyID)
	}
	for _, keep := range filter {
		if !keep("signing keys") {
			return nil
		}
	}
	for _, k := range toInsert {
		body := v1API.CreateSigningKeyBody{
			Algorithm:  v1API.CreateSigningKeyBodyAlgorithm(k.Algorithm),
			PrivateJwk: &v1API.CreateSigningKeyBody_PrivateJwk{},
		}
		switch k.Algorithm {
		case AlgRS256:
			body.PrivateJwk.FromCreateSigningKeyBodyPrivateJwk0(v1API.CreateSigningKeyBodyPrivateJwk0{
				D:   k.PrivateExponent,
				Dp:  k.FirstFactorCRTExponent,
				Dq:  k.SecondFactorCRTExponent,
				E:   v1API.CreateSigningKeyBodyPrivateJwk0E(k.Exponent),
				Kty: v1API.CreateSigningKeyBodyPrivateJwk0Kty(k.KeyType),
				N:   k.Modulus,
				P:   k.FirstPrimeFactor,
				Q:   k.SecondPrimeFactor,
				Qi:  k.FirstCRTCoefficient,
			})
		case AlgES256:
			body.PrivateJwk.FromCreateSigningKeyBodyPrivateJwk1(v1API.CreateSigningKeyBodyPrivateJwk1{
				Crv: v1API.CreateSigningKeyBodyPrivateJwk1Crv(k.Curve),
				D:   k.PrivateExponent,
				Kty: v1API.CreateSigningKeyBodyPrivateJwk1Kty(k.KeyType),
				X:   k.X,
				Y:   k.Y,
			})
		}
		if resp, err := u.client.V1CreateProjectSigningKeyWithResponse(ctx, projectRef, body); err != nil {
			return errors.Errorf("failed to add signing key: %w", err)
		} else if status := resp.StatusCode(); status < 200 || status >= 300 {
			return errors.Errorf("unexpected status %d: %s", status, string(resp.Body))
		}
	}
	return nil
}

func (u *ConfigUpdater) UpdateStorageConfig(ctx context.Context, projectRef string, c storage, filter ...func(string) bool) error {
	if !c.Enabled {
		return nil
	}
	storageConfig, err := u.client.V1GetStorageConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read Storage config: %w", err)
	} else if storageConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", storageConfig.StatusCode(), string(storageConfig.Body))
	}
	storageDiff, err := c.DiffWithRemote(*storageConfig.JSON200)
	if err != nil {
		return err
	} else if len(storageDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote Storage config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating Storage service with config:", string(storageDiff))
	for _, keep := range filter {
		if !keep("storage") {
			return nil
		}
	}
	if resp, err := u.client.V1UpdateStorageConfigWithResponse(ctx, projectRef, c.ToUpdateStorageConfigBody()); err != nil {
		return errors.Errorf("failed to update Storage config: %w", err)
	} else if status := resp.StatusCode(); status < 200 || status >= 300 {
		return errors.Errorf("unexpected status %d: %s", status, string(resp.Body))
	}
	return nil
}

func (u *ConfigUpdater) UpdateExperimentalConfig(ctx context.Context, projectRef string, exp experimental, filter ...func(string) bool) error {
	if exp.Webhooks != nil && exp.Webhooks.Enabled {
		fmt.Fprintln(os.Stderr, "Enabling webhooks for project:", projectRef)
		for _, keep := range filter {
			if !keep("webhooks") {
				return nil
			}
		}
		if resp, err := u.client.V1EnableDatabaseWebhookWithResponse(ctx, projectRef); err != nil {
			return errors.Errorf("failed to enable webhooks: %w", err)
		} else if status := resp.StatusCode(); status < 200 || status >= 300 {
			return errors.Errorf("unexpected enable webhook status %d: %s", status, string(resp.Body))
		}
	}
	return nil
}

func (u *ConfigUpdater) checkThirdPartyAuthChanges(ctx context.Context, projectRef string, tpa thirdParty, filter ...func(string) bool) (bool, []string, error) {
	// Validate the third-party auth configuration first
	if err := tpa.validate(); err != nil {
		return false, nil, errors.Errorf("invalid third-party auth configuration: %w", err)
	}

	// Get current third-party auth integrations
	remoteTPAs, err := u.client.V1ListProjectTpaIntegrationsWithResponse(ctx, projectRef)
	if err != nil {
		return false, nil, errors.Errorf("failed to read third-party auth config: %w", err)
	} else if remoteTPAs.JSON200 == nil {
		return false, nil, errors.Errorf("unexpected status %d: %s", remoteTPAs.StatusCode(), string(remoteTPAs.Body))
	}

	// Determine which TPA should be enabled based on local config
	var enabledTPA *tpaConfig
	var issuerURL string
	var tpaType string

	if tpa.Firebase.Enabled {
		issuerURL = tpa.Firebase.issuerURL()
		tpaType = "firebase"
	} else if tpa.Auth0.Enabled {
		issuerURL = tpa.Auth0.issuerURL()
		tpaType = "auth0"
	} else if tpa.Cognito.Enabled {
		issuerURL = tpa.Cognito.issuerURL()
		tpaType = "cognito"
	} else if tpa.Clerk.Enabled {
		issuerURL = tpa.Clerk.issuerURL()
		// Determine if it's development or production based on domain pattern
		if clerkDomainPattern.MatchString(tpa.Clerk.Domain) && strings.Contains(tpa.Clerk.Domain, ".clerk.accounts.dev") {
			tpaType = "clerk-development"
		} else {
			tpaType = "clerk-production"
		}
	} else if tpa.WorkOs.Enabled {
		issuerURL = tpa.WorkOs.issuerURL()
		tpaType = "workos"
	}

	if issuerURL != "" && tpaType != "" {
		enabledTPA = &tpaConfig{Type: tpaType, IssuerURL: issuerURL}
	}

	// Check if we need to make any changes
	needsUpdate := false
	var changes []string

	if enabledTPA != nil {
		// Check if the desired TPA is already configured with the correct issuer URL
		found := false
		for _, remoteTPA := range *remoteTPAs.JSON200 {
			if remoteTPA.Type == enabledTPA.Type {
				found = true
				// Check if issuer URL matches
				if issuerURL, err := remoteTPA.OidcIssuerUrl.Get(); err == nil && issuerURL == enabledTPA.IssuerURL {
					// Perfect match, no update needed
					break
				} else {
					// Type matches but issuer URL is different
					changes = append(changes, fmt.Sprintf("updating %s issuer URL", enabledTPA.Type))
					needsUpdate = true
					break
				}
			}
		}
		if !found {
			changes = append(changes, fmt.Sprintf("enabling %s", enabledTPA.Type))
			needsUpdate = true
		}
	}

	// Check if we need to remove existing TPAs
	if enabledTPA != nil {
		for _, remoteTPA := range *remoteTPAs.JSON200 {
			if remoteTPA.Type != enabledTPA.Type {
				changes = append(changes, fmt.Sprintf("removing %s", remoteTPA.Type))
				needsUpdate = true
			}
		}
	} else if len(*remoteTPAs.JSON200) > 0 {
		// No TPA should be enabled but there are remote TPAs
		for _, remoteTPA := range *remoteTPAs.JSON200 {
			changes = append(changes, fmt.Sprintf("removing %s", remoteTPA.Type))
		}
		needsUpdate = true
	}

	// Apply filter
	for _, keep := range filter {
		if !keep("third_party_auth") {
			return false, nil, nil
		}
	}

	return needsUpdate, changes, nil
}

func (u *ConfigUpdater) updateThirdPartyAuthConfig(ctx context.Context, projectRef string, tpa thirdParty, filter ...func(string) bool) error {
	// Get current third-party auth integrations
	remoteTPAs, err := u.client.V1ListProjectTpaIntegrationsWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read third-party auth config: %w", err)
	} else if remoteTPAs.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", remoteTPAs.StatusCode(), string(remoteTPAs.Body))
	}

	// Determine which TPA should be enabled based on local config
	var enabledTPA *tpaConfig
	var issuerURL string
	var tpaType string

	if tpa.Firebase.Enabled {
		issuerURL = tpa.Firebase.issuerURL()
		tpaType = "firebase"
	} else if tpa.Auth0.Enabled {
		issuerURL = tpa.Auth0.issuerURL()
		tpaType = "auth0"
	} else if tpa.Cognito.Enabled {
		issuerURL = tpa.Cognito.issuerURL()
		tpaType = "cognito"
	} else if tpa.Clerk.Enabled {
		issuerURL = tpa.Clerk.issuerURL()
		// Determine if it's development or production based on domain pattern
		if clerkDomainPattern.MatchString(tpa.Clerk.Domain) && strings.Contains(tpa.Clerk.Domain, ".clerk.accounts.dev") {
			tpaType = "clerk-development"
		} else {
			tpaType = "clerk-production"
		}
	} else if tpa.WorkOs.Enabled {
		issuerURL = tpa.WorkOs.issuerURL()
		tpaType = "workos"
	}

	if issuerURL != "" && tpaType != "" {
		enabledTPA = &tpaConfig{Type: tpaType, IssuerURL: issuerURL}
	}

	// Delete existing TPAs that don't match the desired configuration
	for _, remoteTPA := range *remoteTPAs.JSON200 {
		if enabledTPA == nil || remoteTPA.Type != enabledTPA.Type {
			fmt.Fprintln(os.Stderr, "Deleting existing third-party auth integration:", remoteTPA.Type)
			if resp, err := u.client.V1DeleteProjectTpaIntegrationWithResponse(ctx, projectRef, remoteTPA.Id); err != nil {
				return errors.Errorf("failed to delete third-party auth integration %s: %w", remoteTPA.Type, err)
			} else if status := resp.StatusCode(); status < 200 || status >= 300 {
				return errors.Errorf("unexpected delete status %d for %s: %s", status, remoteTPA.Type, string(resp.Body))
			}
		}
	}

	// Create new TPA if one should be enabled
	if enabledTPA != nil {
		// Check if we need to create a new one (not just update existing)
		needsCreate := true
		for _, remoteTPA := range *remoteTPAs.JSON200 {
			if remoteTPA.Type == enabledTPA.Type {
				needsCreate = false
				break
			}
		}

		if needsCreate {
			fmt.Fprintln(os.Stderr, "Creating third-party auth integration:", enabledTPA.Type)
			createBody := v1API.CreateThirdPartyAuthBody{
				OidcIssuerUrl: &enabledTPA.IssuerURL,
			}
			if resp, err := u.client.V1CreateProjectTpaIntegrationWithResponse(ctx, projectRef, createBody); err != nil {
				return errors.Errorf("failed to create third-party auth integration %s: %w", enabledTPA.Type, err)
			} else if status := resp.StatusCode(); status < 200 || status >= 300 {
				return errors.Errorf("unexpected create status %d for %s: %s", status, enabledTPA.Type, string(resp.Body))
			}
		}
	}

	return nil
}

type tpaConfig struct {
	Type      string
	IssuerURL string
}
