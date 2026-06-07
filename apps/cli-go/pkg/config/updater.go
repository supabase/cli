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
	if c.SslEnforcement != nil {
		return u.UpdateSslEnforcement(ctx, projectRef, *c.SslEnforcement, filter...)
	}
	return nil
}

func (u *ConfigUpdater) UpdateDbNetworkRestrictionsConfig(ctx context.Context, projectRef string, n networkRestrictions, filter ...func(string) bool) error {
	if !n.Enabled {
		return nil
	}
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

func (u *ConfigUpdater) UpdateSslEnforcement(ctx context.Context, projectRef string, s sslEnforcement, filter ...func(string) bool) error {
	sslEnforcementConfig, err := u.client.V1GetSslEnforcementConfigWithResponse(ctx, projectRef)
	if err != nil {
		return errors.Errorf("failed to read SSL enforcement config: %w", err)
	} else if sslEnforcementConfig.JSON200 == nil {
		return errors.Errorf("unexpected status %d: %s", sslEnforcementConfig.StatusCode(), string(sslEnforcementConfig.Body))
	}
	sslEnforcementDiff, err := s.DiffWithRemote(*sslEnforcementConfig.JSON200)
	if err != nil {
		return err
	} else if len(sslEnforcementDiff) == 0 {
		fmt.Fprintln(os.Stderr, "Remote DB SSL enforcement config is up to date.")
		return nil
	}
	fmt.Fprintln(os.Stderr, "Updating SSL enforcement with config:", string(sslEnforcementDiff))
	for _, keep := range filter {
		if !keep("db") {
			return nil
		}
	}
	updateBody := s.ToUpdateSslEnforcementBody()
	if resp, err := u.client.V1UpdateSslEnforcementConfigWithResponse(ctx, projectRef, updateBody); err != nil {
		return errors.Errorf("failed to update SSL enforcement config: %w", err)
	} else if resp.JSON200 == nil {
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
	authDiff, err := c.DiffWithRemote(*authConfig.JSON200, filter...)
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
