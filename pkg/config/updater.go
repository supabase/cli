package config

import (
	"context"
	"fmt"
	"os"

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
func (u *ConfigUpdater) UpdateRemoteConfigDryRun(ctx context.Context, remote baseConfig, filter ...func(string) bool) error {
	// Implement dry run logic for remote config updates
	if err := u.UpdateApiConfigDryRun(ctx, remote.ProjectId, remote.Api, filter...); err != nil {
		return err
	}
	if err := u.UpdateDbConfigDryRun(ctx, remote.ProjectId, remote.Db, filter...); err != nil {
		return err
	}
	if err := u.UpdateAuthConfigDryRun(ctx, remote.ProjectId, remote.Auth, filter...); err != nil {
		return err
	}
	if err := u.UpdateStorageConfigDryRun(ctx, remote.ProjectId, remote.Storage, filter...); err != nil {
		return err
	}
	if err := u.UpdateExperimentalConfigDryRun(ctx, remote.ProjectId, remote.Experimental, filter...); err != nil {
		return err
	}
	return nil
}

func (u *ConfigUpdater) UpdateApiConfigDryRun(ctx context.Context, projectRef string, c api, filter ...func(string) bool) error {
	apiDiff, err := u.GetApiConfigDiff(ctx, projectRef, c)
	if err != nil {
		return err
	} else if len(apiDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote API config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Would update API service with config:", string(apiDiff))
	return nil
}

func (u *ConfigUpdater) GetApiConfigDiff(ctx context.Context, projectRef string, c api) ([]byte, error) {
	apiConfig, err := u.client.V1GetPostgrestServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to read API config: %w", err)
	} else if apiConfig.JSON200 == nil {
		return nil, errors.Errorf("unexpected status %d: %s", apiConfig.StatusCode(), string(apiConfig.Body))
	}
	apiDiff, err := c.DiffWithRemote(*apiConfig.JSON200)
	if err != nil {
		return nil, err
	}
	return apiDiff, nil
}

func (u *ConfigUpdater) UpdateApiConfig(ctx context.Context, projectRef string, c api, filter ...func(string) bool) error {
	apiDiff, err := u.GetApiConfigDiff(ctx, projectRef, c)
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

func (u *ConfigUpdater) GetDBSettingsConfigDiff(ctx context.Context, projectRef string, s settings) ([]byte, error) {
	dbConfig, err := u.client.V1GetPostgresConfigWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to read DB config: %w", err)
	} else if dbConfig.JSON200 == nil {
		return nil, errors.Errorf("unexpected status %d: %s", dbConfig.StatusCode(), string(dbConfig.Body))
	}
	dbDiff, err := s.DiffWithRemote(*dbConfig.JSON200)
	if err != nil {
		return nil, err
	}
	return dbDiff, nil
}

func (u *ConfigUpdater) UpdateDbSettingsConfigDryRun(ctx context.Context, projectRef string, c settings, filter ...func(string) bool) error {
	apiDiff, err := u.GetDBSettingsConfigDiff(ctx, projectRef, c)
	if err != nil {
		return err
	} else if len(apiDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote API config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Would update API service with config:", string(apiDiff))
	return nil
}

func (u *ConfigUpdater) UpdateDbSettingsConfig(ctx context.Context, projectRef string, s settings, filter ...func(string) bool) error {
	dbDiff, err := u.GetDBSettingsConfigDiff(ctx, projectRef, s)
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

func (u *ConfigUpdater) UpdateDbConfigDryRun(ctx context.Context, projectRef string, c db, filter ...func(string) bool) error {
	if err := u.UpdateDbSettingsConfigDryRun(ctx, projectRef, c.Settings, filter...); err != nil {
		return err
	}
	if err := u.UpdateDbNetworkRestrictionsConfigDryRun(ctx, projectRef, c.NetworkRestrictions, filter...); err != nil {
		return err
	}
	return nil
}

func (u *ConfigUpdater) GetDBNetworkRestrictionsConfigDiff(ctx context.Context, projectRef string, n networkRestrictions) ([]byte, error) {
	networkRestrictionsConfig, err := u.client.V1GetNetworkRestrictionsWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to read network restrictions config: %w", err)
	} else if networkRestrictionsConfig.JSON200 == nil {
		return nil, errors.Errorf("unexpected status %d: %s", networkRestrictionsConfig.StatusCode(), string(networkRestrictionsConfig.Body))
	}
	networkRestrictionsDiff, err := n.DiffWithRemote(*networkRestrictionsConfig.JSON200)
	if err != nil {
		return nil, err
	}
	return networkRestrictionsDiff, nil
}

func (u *ConfigUpdater) UpdateDbNetworkRestrictionsConfigDryRun(ctx context.Context, projectRef string, n networkRestrictions, filter ...func(string) bool) error {
	networkRestrictionsDiff, err := u.GetDBNetworkRestrictionsConfigDiff(ctx, projectRef, n)
	if err != nil {
		return err
	} else if len(networkRestrictionsDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote DB Network restrictions config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Would update network restrictions with config:", string(networkRestrictionsDiff))
	return nil
}

func (u *ConfigUpdater) UpdateDbNetworkRestrictionsConfig(ctx context.Context, projectRef string, n networkRestrictions, filter ...func(string) bool) error {
	networkRestrictionsDiff, err := u.GetDBNetworkRestrictionsConfigDiff(ctx, projectRef, n)
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

func (u *ConfigUpdater) GetAuthConfigDiff(ctx context.Context, projectRef string, c auth) ([]byte, error) {
	authConfig, err := u.client.V1GetAuthServiceConfigWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to read Auth config: %w", err)
	} else if authConfig.JSON200 == nil {
		return nil, errors.Errorf("unexpected status %d: %s", authConfig.StatusCode(), string(authConfig.Body))
	}
	authDiff, err := c.DiffWithRemote(*authConfig.JSON200)
	if err != nil {
		return nil, err
	}
	return authDiff, nil
}

func (u *ConfigUpdater) UpdateAuthConfigDryRun(ctx context.Context, projectRef string, c auth, filter ...func(string) bool) error {
	authDiff, err := u.GetAuthConfigDiff(ctx, projectRef, c)
	if err != nil {
		return err
	} else if len(authDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote Auth config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Would update Auth service with config:", string(authDiff))
	return nil
}

func (u *ConfigUpdater) UpdateAuthConfig(ctx context.Context, projectRef string, c auth, filter ...func(string) bool) error {
	authDiff, err := u.GetAuthConfigDiff(ctx, projectRef, c)
	if err != nil {
		return err
	} else if len(authDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote Auth config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating Auth service with config:", string(authDiff))
	for _, keep := range filter {
		if !keep("auth") {
			return nil
		}
	}
	if resp, err := u.client.V1UpdateAuthServiceConfigWithResponse(ctx, projectRef, c.ToUpdateAuthConfigBody()); err != nil {
		return errors.Errorf("failed to update Auth config: %w", err)
	} else if status := resp.StatusCode(); status < 200 || status >= 300 {
		return errors.Errorf("unexpected status %d: %s", status, string(resp.Body))
	}
	return nil
}

func (u *ConfigUpdater) GetSigningKeysDiff(ctx context.Context, projectRef string, signingKeys []JWK) ([]JWK, error) {
	resp, err := u.client.V1GetProjectSigningKeysWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to fetch signing keys: %w", err)
	} else if resp.JSON200 == nil {
		return nil, errors.Errorf("unexpected status %d: %s", resp.StatusCode(), string(resp.Body))
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
	return toInsert, nil
}

func (u *ConfigUpdater) UpdateSigningKeysDryRun(ctx context.Context, projectRef string, signingKeys []JWK, filter ...func(string) bool) error {
	toInsert, err := u.GetSigningKeysDiff(ctx, projectRef, signingKeys)
	if err != nil {
		return err
	}
	if len(toInsert) == 0 {
		fmt.Fprintln(os.Stderr, "Remote JWT signing keys are up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "JWT signing keys to insert:")
	for _, k := range toInsert {
		fmt.Fprintln(os.Stderr, " -", k.KeyID)
	}
	return nil
}

func (u *ConfigUpdater) UpdateSigningKeys(ctx context.Context, projectRef string, signingKeys []JWK, filter ...func(string) bool) error {
	if len(signingKeys) == 0 {
		return nil
	}
	toInsert, err := u.GetSigningKeysDiff(ctx, projectRef, signingKeys)
	if err != nil {
		return err
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

func (u *ConfigUpdater) GetStorageConfigDiff(ctx context.Context, projectRef string, c storage) ([]byte, error) {
	if !c.Enabled {
		return nil, nil
	}
	storageConfig, err := u.client.V1GetStorageConfigWithResponse(ctx, projectRef)
	if err != nil {
		return nil, errors.Errorf("failed to read Storage config: %w", err)
	} else if storageConfig.JSON200 == nil {
		return nil, errors.Errorf("unexpected status %d: %s", storageConfig.StatusCode(), string(storageConfig.Body))
	}
	storageDiff, err := c.DiffWithRemote(*storageConfig.JSON200)
	if err != nil {
		return nil, err
	}
	return storageDiff, nil
}

func (u *ConfigUpdater) UpdateStorageConfigDryRun(ctx context.Context, projectRef string, c storage, filter ...func(string) bool) error {
	if !c.Enabled {
		return nil
	}
	diff, err := u.GetStorageConfigDiff(ctx, projectRef, c)
	if err != nil {
		return err
	} else if len(diff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote Storage config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Would update Storage service with config:", string(diff))
	return nil
}

func (u *ConfigUpdater) UpdateStorageConfig(ctx context.Context, projectRef string, c storage, filter ...func(string) bool) error {
	if !c.Enabled {
		return nil
	}
	storageDiff, err := u.GetStorageConfigDiff(ctx, projectRef, c)
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

func (u *ConfigUpdater) UpdateExperimentalConfigDryRun(ctx context.Context, projectRef string, exp experimental, filter ...func(string) bool) error {
	if exp.Webhooks != nil && exp.Webhooks.Enabled {
		fmt.Fprintln(os.Stderr, "Would enable webhooks for project:", projectRef)
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
