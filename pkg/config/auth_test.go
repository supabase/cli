package config

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestToUpdateAuthConfigBody(t *testing.T) {
	t.Run("converts all fields correctly", func(t *testing.T) {
		auth := &auth{
			EnableSignup:               true,
			SiteUrl:                    "https://example.com",
			JwtExpiry:                  3600,
			EnableRefreshTokenRotation: true,
			RefreshTokenReuseInterval:  10,
			EnableManualLinking:        true,
			Email: email{
				EnableSignup:         true,
				DoubleConfirmChanges: true,
				EnableConfirmations:  true,
				SecurePasswordChange: true,
				Smtp: smtp{
					AdminEmail: "admin@example.com",
					Host:       "smtp.example.com",
					Port:       587,
					User:       "smtpuser",
					Pass:       "smtppass",
					SenderName: "Test Sender",
				},
				MaxFrequency: 60 * time.Second,
				OtpLength:    6,
				OtpExpiry:    3600,
			},
			Sms: sms{
				EnableSignup:        true,
				EnableConfirmations: true,
				Template:            "Your OTP is {{.otp}}",
				MaxFrequency:        60 * time.Second,
			},
			MFA: mfa{
				MaxEnrolledFactors: 3,
				TOTP: factorTypeConfiguration{
					EnrollEnabled: true,
					VerifyEnabled: true,
				},
				Phone: phoneFactorTypeConfiguration{
					factorTypeConfiguration: factorTypeConfiguration{
						EnrollEnabled: true,
						VerifyEnabled: true,
					},
					OtpLength:    6,
					Template:     "Your MFA code is {{.otp}}",
					MaxFrequency: 60 * time.Second,
				},
				WebAuthn: factorTypeConfiguration{
					EnrollEnabled: true,
					VerifyEnabled: true,
				},
			},
			EnableAnonymousSignIns: true,
			Sessions: sessions{
				Timebox:           3600 * time.Second,
				InactivityTimeout: 1800 * time.Second,
			},
		}

		body := auth.ToUpdateAuthConfigBody()

		assert.Equal(t, v1API.UpdateAuthConfigBody{
			DisableSignup:                          cast.Ptr(false),
			SiteUrl:                                cast.Ptr("https://example.com"),
			JwtExp:                                 cast.Ptr(3600),
			RefreshTokenRotationEnabled:            cast.Ptr(true),
			SecurityRefreshTokenReuseInterval:      cast.Ptr(10),
			SecurityManualLinkingEnabled:           cast.Ptr(true),
			SmtpAdminEmail:                         cast.Ptr("admin@example.com"),
			SmtpHost:                               cast.Ptr("smtp.example.com"),
			SmtpPass:                               cast.Ptr("smtppass"),
			SmtpPort:                               cast.Ptr("587"),
			SmtpUser:                               cast.Ptr("smtpuser"),
			SmtpSenderName:                         cast.Ptr("Test Sender"),
			SmtpMaxFrequency:                       cast.Ptr(60),
			MailerAutoconfirm:                      cast.Ptr(true),
			MailerSecureEmailChangeEnabled:         cast.Ptr(true),
			MailerOtpLength:                        cast.Ptr(6),
			MailerOtpExp:                           cast.Ptr(3600),
			SmsAutoconfirm:                         cast.Ptr(true),
			SmsTemplate:                            cast.Ptr("Your OTP is {{.otp}}"),
			SmsMaxFrequency:                        cast.Ptr(60),
			ExternalEmailEnabled:                   cast.Ptr(true),
			ExternalPhoneEnabled:                   cast.Ptr(true),
			ExternalAnonymousUsersEnabled:          cast.Ptr(true),
			MfaMaxEnrolledFactors:                  cast.Ptr(3),
			MfaTotpEnrollEnabled:                   cast.Ptr(true),
			MfaTotpVerifyEnabled:                   cast.Ptr(true),
			MfaPhoneEnrollEnabled:                  cast.Ptr(true),
			MfaPhoneVerifyEnabled:                  cast.Ptr(true),
			MfaPhoneOtpLength:                      cast.Ptr(6),
			MfaPhoneTemplate:                       cast.Ptr("Your MFA code is {{.otp}}"),
			MfaPhoneMaxFrequency:                   cast.Ptr(60),
			MfaWebAuthnEnrollEnabled:               cast.Ptr(true),
			MfaWebAuthnVerifyEnabled:               cast.Ptr(true),
			SessionsTimebox:                        cast.Ptr(3600),
			SessionsInactivityTimeout:              cast.Ptr(1800),
			HookCustomAccessTokenEnabled:           cast.Ptr(false),
			HookCustomAccessTokenSecrets:           cast.Ptr(""),
			HookCustomAccessTokenUri:               cast.Ptr(""),
			HookMfaVerificationAttemptEnabled:      cast.Ptr(false),
			HookMfaVerificationAttemptSecrets:      cast.Ptr(""),
			HookMfaVerificationAttemptUri:          cast.Ptr(""),
			HookPasswordVerificationAttemptEnabled: cast.Ptr(false),
			HookPasswordVerificationAttemptSecrets: cast.Ptr(""),
			HookPasswordVerificationAttemptUri:     cast.Ptr(""),
			HookSendEmailEnabled:                   cast.Ptr(false),
			HookSendEmailSecrets:                   cast.Ptr(""),
			HookSendEmailUri:                       cast.Ptr(""),
			HookSendSmsEnabled:                     cast.Ptr(false),
			HookSendSmsSecrets:                     cast.Ptr(""),
			HookSendSmsUri:                         cast.Ptr(""),
		}, body)
	})
}

func TestFromRemoteAuthConfig(t *testing.T) {
	t.Run("updates local config from remote", func(t *testing.T) {
		auth := &auth{}
		remoteConfig := v1API.AuthConfigResponse{
			DisableSignup:                  cast.Ptr(false),
			SiteUrl:                        cast.Ptr("https://example.com"),
			JwtExp:                         cast.Ptr(3600),
			MailerAutoconfirm:              cast.Ptr(true),
			MailerSecureEmailChangeEnabled: cast.Ptr(true),
			SmsAutoconfirm:                 cast.Ptr(true),
			SmsTemplate:                    cast.Ptr("Your OTP is {{.otp}}"),
			SmsMaxFrequency:                cast.Ptr(60),
			ExternalEmailEnabled:           cast.Ptr(true),
			ExternalPhoneEnabled:           cast.Ptr(true),
			ExternalAnonymousUsersEnabled:  cast.Ptr(true),
			SmtpMaxFrequency:               cast.Ptr(60),
		}

		updatedAuth := auth.fromRemoteAuthConfig(remoteConfig)

		assert.True(t, updatedAuth.EnableSignup)
		assert.Equal(t, "https://example.com", updatedAuth.SiteUrl)
		assert.Equal(t, uint(3600), updatedAuth.JwtExpiry)
		assert.True(t, updatedAuth.Email.EnableConfirmations)
		assert.True(t, updatedAuth.Email.SecurePasswordChange)
		assert.True(t, updatedAuth.Sms.EnableConfirmations)
		assert.Equal(t, "Your OTP is {{.otp}}", updatedAuth.Sms.Template)
		assert.Equal(t, 60*time.Second, updatedAuth.Sms.MaxFrequency)
		assert.True(t, updatedAuth.Email.EnableSignup)
		assert.True(t, updatedAuth.Sms.EnableSignup)
		assert.True(t, updatedAuth.EnableAnonymousSignIns)
		assert.Equal(t, 60*time.Second, updatedAuth.Email.MaxFrequency)
	})
}

func TestDiffWithRemote(t *testing.T) {
	t.Run("detects differences", func(t *testing.T) {
		auth := &auth{
			EnableSignup: true,
			SiteUrl:      "https://example.com",
			JwtExpiry:    3600,
			Email: email{
				EnableConfirmations: true,
			},
			Sms: sms{
				EnableConfirmations: true,
				Template:            "Your OTP is {{.otp}}",
				MaxFrequency:        60 * time.Second,
			},
		}

		remoteConfig := v1API.AuthConfigResponse{
			DisableSignup:     cast.Ptr(true),
			SiteUrl:           cast.Ptr("https://remote.com"),
			JwtExp:            cast.Ptr(7200),
			MailerAutoconfirm: cast.Ptr(false),
			SmsAutoconfirm:    cast.Ptr(false),
			SmsTemplate:       cast.Ptr("Different template"),
			SmsMaxFrequency:   cast.Ptr(120),
		}

		diff, err := auth.DiffWithRemote(remoteConfig)

		assert.NoError(t, err)
		assert.Contains(t, string(diff), "-site_url = \"https://remote.com\"")
		assert.Contains(t, string(diff), "+site_url = \"https://example.com\"")
		assert.Contains(t, string(diff), "-jwt_expiry = 7200")
		assert.Contains(t, string(diff), "+jwt_expiry = 3600")
		assert.Contains(t, string(diff), "-enable_signup = false")
		assert.Contains(t, string(diff), "+enable_signup = true")
		assert.Contains(t, string(diff), "-enable_confirmations = false")
		assert.Contains(t, string(diff), "+enable_confirmations = true")
		assert.Contains(t, string(diff), "-template = \"Different template\"")
		assert.Contains(t, string(diff), "+template = \"Your OTP is {{.otp}}\"")
		assert.Contains(t, string(diff), "-max_frequency = \"2m0s\"")
		assert.Contains(t, string(diff), "+max_frequency = \"1m0s\"")
	})

	t.Run("handles no differences", func(t *testing.T) {
		auth := &auth{
			EnableSignup: true,
			SiteUrl:      "https://example.com",
			JwtExpiry:    3600,
			Email: email{
				EnableConfirmations: true,
			},
			Sms: sms{
				EnableConfirmations: true,
				Template:            "Your OTP is {{.otp}}",
				MaxFrequency:        60 * time.Second,
			},
		}

		remoteConfig := v1API.AuthConfigResponse{
			DisableSignup:     cast.Ptr(false),
			SiteUrl:           cast.Ptr("https://example.com"),
			JwtExp:            cast.Ptr(3600),
			MailerAutoconfirm: cast.Ptr(true),
			SmsAutoconfirm:    cast.Ptr(true),
			SmsTemplate:       cast.Ptr("Your OTP is {{.otp}}"),
			SmsMaxFrequency:   cast.Ptr(60),
		}

		diff, err := auth.DiffWithRemote(remoteConfig)

		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("ensures sensitive fields aren't leaked", func(t *testing.T) {
		auth := &auth{
			Email: email{
				Smtp: smtp{
					AdminEmail: "admin@example.com",
					Host:       "smtp.example.com",
					Pass:       "secretpassword",
					User:       "smtpuser",
					SenderName: "Sender Name",
				},
			},
		}

		remoteConfig := v1API.AuthConfigResponse{
			SmtpAdminEmail: cast.Ptr("different@example.com"),
			SmtpHost:       cast.Ptr("smtp.different.com"),
			SmtpPass:       cast.Ptr("differentpassword"),
			SmtpUser:       cast.Ptr("differentuser"),
			SmtpSenderName: cast.Ptr("Different Sender"),
		}

		diff, err := auth.DiffWithRemote(remoteConfig)

		assert.NoError(t, err)
		assert.NotContains(t, string(diff), "secretpassword")
		assert.NotContains(t, string(diff), "differentpassword")
		assert.Contains(t, string(diff), "<original-sensitive-value-hidden>")
		assert.Contains(t, string(diff), "<original-sensitive-value-hidden>")
	})

	t.Run("ensures external providers are compared correctly", func(t *testing.T) {
		auth := &auth{
			External: map[string]provider{
				"google": {
					Enabled:     true,
					ClientId:    "local_client_id",
					Secret:      "local_secret",
					RedirectUri: "https://local.example.com/callback",
				},
				"github": {
					Enabled: false,
					Secret:  "github_secret",
				},
			},
		}

		remoteConfig := v1API.AuthConfigResponse{
			ExternalGoogleEnabled:  cast.Ptr(true),
			ExternalGoogleClientId: cast.Ptr("remote_client_id"),
			ExternalGoogleSecret:   cast.Ptr("remote_secret"),
			ExternalGithubEnabled:  cast.Ptr(true),
			ExternalGithubClientId: cast.Ptr("github_client_id"),
			ExternalGithubSecret:   cast.Ptr("github_secret"),
		}

		diff, err := auth.DiffWithRemote(remoteConfig)

		assert.NoError(t, err)
		assert.NotContains(t, string(diff), "local_secret")
		assert.NotContains(t, string(diff), "remote_secret")
		assert.NotContains(t, string(diff), "github_secret")
		assert.Contains(t, string(diff), "<changed-sensitive-value-hidden>")
		assert.Contains(t, string(diff), "<unchanged-sensitive-value-hidden>")
		assert.Contains(t, string(diff), "github")
	})

	t.Run("ensures SMS providers are compared correctly", func(t *testing.T) {
		auth := &auth{
			Sms: sms{
				Twilio: twilioConfig{
					Enabled:    true,
					AccountSid: "local_account_sid",
					AuthToken:  "local_auth_token",
				},
			},
		}

		remoteConfig := v1API.AuthConfigResponse{
			SmsTwilioAccountSid: cast.Ptr("remote_account_sid"),
			SmsTwilioAuthToken:  cast.Ptr("remote_auth_token"),
			SmsVonageApiKey:     cast.Ptr("vonage_api_key"),
			SmsVonageApiSecret:  cast.Ptr("vonage_api_secret"),
		}

		diff, err := auth.DiffWithRemote(remoteConfig)

		assert.NoError(t, err)
		assert.NotContains(t, string(diff), "local_auth_token")
		assert.NotContains(t, string(diff), "remote_auth_token")
		assert.NotContains(t, string(diff), "vonage_api_secret")
		assert.Contains(t, string(diff), "<changed-sensitive-value-hidden>")
		assert.Contains(t, string(diff), "<unchanged-sensitive-value-hidden>")
		assert.Contains(t, string(diff), "auth_token")
	})

	t.Run("ensures hooks are compared correctly", func(t *testing.T) {
		auth := &auth{
			Hook: hook{
				CustomAccessToken: hookConfig{
					Enabled: true,
					URI:     "https://local.example.com/custom-token",
					Secrets: "local_secrets",
				},
			},
		}
		remoteConfig := v1API.AuthConfigResponse{
			HookCustomAccessTokenEnabled:      cast.Ptr(true),
			HookCustomAccessTokenUri:          cast.Ptr("https://remote.example.com/custom-token"),
			HookCustomAccessTokenSecrets:      cast.Ptr("remote_secret"),
			HookMfaVerificationAttemptEnabled: cast.Ptr(true),
			HookMfaVerificationAttemptUri:     cast.Ptr("https://remote.example.com/mfa"),
		}

		diff, err := auth.DiffWithRemote(remoteConfig)

		assert.NoError(t, err)
		assert.NotContains(t, string(diff), "local_secret")
		assert.NotContains(t, string(diff), "remote_secret")
		assert.Contains(t, string(diff), "<changed-sensitive-value-hidden>")
		assert.Contains(t, string(diff), "<unchanged-sensitive-value-hidden>")
		assert.Contains(t, string(diff), "mfa_verification_attempt")
	})

	// TODO: Third parties are not included in AuthConfigReponse and need a dedicated logic
	// to be added/removed/updated
	// t.Run("ensures third-party providers are compared correctly", func(t *testing.T) {
	// 	auth := &auth{
	// 		ThirdParty: thirdParty{
	// 			Firebase: tpaFirebase{
	// 				Enabled:   true,
	// 				ProjectID: "local_project_id",
	// 			},
	// 		},
	// 	}

	// 	remoteConfig := v1API.AuthConfigResponse{
	// 		ThirdPartyFirebaseEnabled:  cast.Ptr(true),
	// 		ThirdPartyFirebaseProjectId: cast.Ptr("remote_project_id"),
	// 		ThirdPartyAuth0Enabled:     cast.Ptr(true),
	// 		ThirdPartyAuth0Tenant:      cast.Ptr("auth0_tenant"),
	// 	}

	// 	diff, err := auth.DiffWithRemote(remoteConfig)

	// assert.NoError(t, err)
	// 	assert.NotContains(t, string(diff), "local_project_id")
	// 	assert.NotContains(t, string(diff), "remote_project_id")
	// 	assert.NotContains(t, string(diff), "auth0_tenant")
	// 	assert.Contains(t, string(diff), "<changed-sensitive-value-hidden>")
	// 	assert.Contains(t, string(diff), "<unchanged-sensitive-value-hidden>")
	// 	assert.Contains(t, string(diff), "auth0")
	// })
}
