package config

import (
	"reflect"
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
			},
			EnableAnonymousSignIns: true,
			Sessions: sessions{
				Timebox:           3600 * time.Second,
				InactivityTimeout: 1800 * time.Second,
			},
		}

		body := auth.ToUpdateAuthConfigBody()

		// Use helper function to safely check pointer values
		assertPtrEqual := func(t *testing.T, expected interface{}, actual interface{}, fieldName string) {
			t.Helper()
			if actual == nil {
				t.Errorf("Expected %s to be %v, but it was nil", fieldName, expected)
				return
			}
			assert.Equal(t, expected, reflect.ValueOf(actual).Elem().Interface(), fieldName)
		}

		assertPtrEqual(t, false, body.DisableSignup, "DisableSignup")
		assertPtrEqual(t, "https://example.com", body.SiteUrl, "SiteUrl")
		assertPtrEqual(t, float32(3600), body.JwtExp, "JwtExp")
		assertPtrEqual(t, true, body.RefreshTokenRotationEnabled, "RefreshTokenRotationEnabled")
		assertPtrEqual(t, float32(10), body.SecurityRefreshTokenReuseInterval, "SecurityRefreshTokenReuseInterval")
		assertPtrEqual(t, true, body.SecurityManualLinkingEnabled, "SecurityManualLinkingEnabled")
		assertPtrEqual(t, "admin@example.com", body.SmtpAdminEmail, "SmtpAdminEmail")
		assertPtrEqual(t, "smtp.example.com", body.SmtpHost, "SmtpHost")
		assertPtrEqual(t, "smtppass", body.SmtpPass, "SmtpPass")
		assertPtrEqual(t, "587", body.SmtpPort, "SmtpPort")
		assertPtrEqual(t, "smtpuser", body.SmtpUser, "SmtpUser")
		assertPtrEqual(t, "Test Sender", body.SmtpSenderName, "SmtpSenderName")
		assertPtrEqual(t, float32(60), body.SmtpMaxFrequency, "SmtpMaxFrequency")
		assertPtrEqual(t, true, body.MailerAutoconfirm, "MailerAutoconfirm")
		assertPtrEqual(t, true, body.MailerSecureEmailChangeEnabled, "MailerSecureEmailChangeEnabled")
		assertPtrEqual(t, true, body.SmsAutoconfirm, "SmsAutoconfirm")
		assertPtrEqual(t, "Your OTP is {{.otp}}", body.SmsTemplate, "SmsTemplate")
		assertPtrEqual(t, float32(60), body.SmsMaxFrequency, "SmsMaxFrequency")
		assertPtrEqual(t, true, body.ExternalEmailEnabled, "ExternalEmailEnabled")
		assertPtrEqual(t, true, body.ExternalPhoneEnabled, "ExternalPhoneEnabled")
		assertPtrEqual(t, true, body.ExternalAnonymousUsersEnabled, "ExternalAnonymousUsersEnabled")
		assertPtrEqual(t, float32(3), body.MfaMaxEnrolledFactors, "MfaMaxEnrolledFactors")
		assertPtrEqual(t, true, body.MfaTotpEnrollEnabled, "MfaTotpEnrollEnabled")
		assertPtrEqual(t, true, body.MfaTotpVerifyEnabled, "MfaTotpVerifyEnabled")
		assertPtrEqual(t, true, body.MfaPhoneEnrollEnabled, "MfaPhoneEnrollEnabled")
		assertPtrEqual(t, true, body.MfaPhoneVerifyEnabled, "MfaPhoneVerifyEnabled")
		assertPtrEqual(t, float32(6), body.MfaPhoneOtpLength, "MfaPhoneOtpLength")
		assertPtrEqual(t, "Your MFA code is {{.otp}}", body.MfaPhoneTemplate, "MfaPhoneTemplate")
		assertPtrEqual(t, float32(60), body.MfaPhoneMaxFrequency, "MfaPhoneMaxFrequency")
		assertPtrEqual(t, float32(3600), body.SessionsTimebox, "SessionsTimebox")
		assertPtrEqual(t, float32(1800), body.SessionsInactivityTimeout, "SessionsInactivityTimeout")
	})
}

func TestFromRemoteAuthConfig(t *testing.T) {
	t.Run("updates local config from remote", func(t *testing.T) {
		auth := &auth{}
		remoteConfig := v1API.AuthConfigResponse{
			DisableSignup:                  cast.Ptr(false),
			SiteUrl:                        cast.Ptr("https://example.com"),
			JwtExp:                         cast.Ptr(float32(3600)),
			MailerAutoconfirm:              cast.Ptr(true),
			MailerSecureEmailChangeEnabled: cast.Ptr(true),
			SmsAutoconfirm:                 cast.Ptr(true),
			SmsTemplate:                    cast.Ptr("Your OTP is {{.otp}}"),
			SmsMaxFrequency:                cast.Ptr(float32(60)),
			ExternalEmailEnabled:           cast.Ptr(true),
			ExternalPhoneEnabled:           cast.Ptr(true),
			ExternalAnonymousUsersEnabled:  cast.Ptr(true),
			SmtpMaxFrequency:               cast.Ptr(float32(60)),
		}

		updatedAuth := auth.fromRemoteAuthConfig(remoteConfig)

		assert.True(t, updatedAuth.EnableSignup)
		assert.Equal(t, "https://example.com", updatedAuth.SiteUrl)
		assert.Equal(t, uint(time.Duration(*remoteConfig.JwtExp)), updatedAuth.JwtExpiry)
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
			JwtExp:            cast.Ptr(float32(7200)),
			MailerAutoconfirm: cast.Ptr(false),
			SmsAutoconfirm:    cast.Ptr(false),
			SmsTemplate:       cast.Ptr("Different template"),
			SmsMaxFrequency:   cast.Ptr(float32(120)),
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
			JwtExp:            cast.Ptr(float32(3600)),
			MailerAutoconfirm: cast.Ptr(true),
			SmsAutoconfirm:    cast.Ptr(true),
			SmsTemplate:       cast.Ptr("Your OTP is {{.otp}}"),
			SmsMaxFrequency:   cast.Ptr(float32(60)),
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
		assert.NotContains(t, string(diff), "admin@example.com")
		assert.NotContains(t, string(diff), "smtp.example.com")
		assert.NotContains(t, string(diff), "secretpassword")
		assert.NotContains(t, string(diff), "smtpuser")
		assert.NotContains(t, string(diff), "Sender Name")

		assert.NotContains(t, string(diff), "different@example.com")
		assert.NotContains(t, string(diff), "smtp.different.com")
		assert.NotContains(t, string(diff), "differentpassword")
		assert.NotContains(t, string(diff), "differentuser")
		assert.NotContains(t, string(diff), "Different Sender")

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
		assert.NotContains(t, string(diff), "local_client_id")
		assert.NotContains(t, string(diff), "local_secret")
		assert.NotContains(t, string(diff), "remote_client_id")
		assert.NotContains(t, string(diff), "remote_secret")
		assert.NotContains(t, string(diff), "github_client_id")
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
		assert.NotContains(t, string(diff), "local_account_sid")
		assert.NotContains(t, string(diff), "local_auth_token")
		assert.NotContains(t, string(diff), "remote_account_sid")
		assert.NotContains(t, string(diff), "remote_auth_token")
		assert.NotContains(t, string(diff), "vonage_api_key")
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
					Secrets: "local_secrest",
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
