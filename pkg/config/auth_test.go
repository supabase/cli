package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/go-errors/errors"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func newWithDefaults() auth {
	return auth{
		EnableSignup:           true,
		AdditionalRedirectUrls: []string{},
		Email: email{
			EnableConfirmations: true,
		},
		Sms: sms{
			TestOTP: map[string]string{},
		},
	}
}

func assertSnapshotEqual(t *testing.T, actual []byte) {
	snapshot := filepath.Join("testdata", filepath.FromSlash(t.Name())) + ".diff"
	expected, err := os.ReadFile(snapshot)
	if errors.Is(err, os.ErrNotExist) {
		assert.NoError(t, os.MkdirAll(filepath.Dir(snapshot), 0755))
		assert.NoError(t, os.WriteFile(snapshot, actual, 0600))
	}
	assert.Equal(t, string(expected), string(actual))
}

func TestAuthDiff(t *testing.T) {
	t.Run("local and remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.SiteUrl = "http://127.0.0.1:3000"
		c.AdditionalRedirectUrls = []string{"https://127.0.0.1:3000"}
		c.JwtExpiry = 3600
		c.EnableRefreshTokenRotation = true
		c.RefreshTokenReuseInterval = 10
		c.EnableManualLinking = true
		c.EnableSignup = true
		c.EnableAnonymousSignIns = true
		c.MinimumPasswordLength = 6
		c.PasswordRequirements = LettersDigits
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			SiteUrl:                           nullable.NewNullableWithValue("http://127.0.0.1:3000"),
			UriAllowList:                      nullable.NewNullableWithValue("https://127.0.0.1:3000"),
			JwtExp:                            nullable.NewNullableWithValue(3600),
			RefreshTokenRotationEnabled:       nullable.NewNullableWithValue(true),
			SecurityRefreshTokenReuseInterval: nullable.NewNullableWithValue(10),
			SecurityManualLinkingEnabled:      nullable.NewNullableWithValue(true),
			DisableSignup:                     nullable.NewNullableWithValue(false),
			ExternalAnonymousUsersEnabled:     nullable.NewNullableWithValue(true),
			PasswordMinLength:                 nullable.NewNullableWithValue(6),
			PasswordRequiredCharacters:        nullable.NewNullableWithValue(v1API.AuthConfigResponsePasswordRequiredCharactersAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local enabled and disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.SiteUrl = "http://127.0.0.1:3000"
		c.AdditionalRedirectUrls = []string{"https://127.0.0.1:3000"}
		c.JwtExpiry = 3600
		c.EnableRefreshTokenRotation = false
		c.RefreshTokenReuseInterval = 10
		c.EnableManualLinking = false
		c.EnableSignup = false
		c.EnableAnonymousSignIns = false
		c.MinimumPasswordLength = 6
		c.PasswordRequirements = LowerUpperLettersDigitsSymbols
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			SiteUrl:                           nullable.NewNullableWithValue(""),
			UriAllowList:                      nullable.NewNullableWithValue("https://127.0.0.1:3000,https://ref.supabase.co"),
			JwtExp:                            nullable.NewNullableWithValue(0),
			RefreshTokenRotationEnabled:       nullable.NewNullableWithValue(true),
			SecurityRefreshTokenReuseInterval: nullable.NewNullableWithValue(0),
			SecurityManualLinkingEnabled:      nullable.NewNullableWithValue(true),
			DisableSignup:                     nullable.NewNullableWithValue(false),
			ExternalAnonymousUsersEnabled:     nullable.NewNullableWithValue(true),
			PasswordMinLength:                 nullable.NewNullableWithValue(8),
			PasswordRequiredCharacters:        nullable.NewNullableWithValue(v1API.AuthConfigResponsePasswordRequiredCharactersAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local and remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.EnableSignup = false
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			SiteUrl:                           nullable.NewNullableWithValue(""),
			UriAllowList:                      nullable.NewNullableWithValue(""),
			JwtExp:                            nullable.NewNullableWithValue(0),
			RefreshTokenRotationEnabled:       nullable.NewNullableWithValue(false),
			SecurityRefreshTokenReuseInterval: nullable.NewNullableWithValue(0),
			SecurityManualLinkingEnabled:      nullable.NewNullableWithValue(false),
			DisableSignup:                     nullable.NewNullableWithValue(true),
			ExternalAnonymousUsersEnabled:     nullable.NewNullableWithValue(false),
			PasswordMinLength:                 nullable.NewNullableWithValue(0),
			PasswordRequiredCharacters:        nullable.NewNullableWithValue(v1API.AuthConfigResponsePasswordRequiredCharactersEmpty),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}

func TestCaptchaDiff(t *testing.T) {
	t.Run("local and remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Captcha = &captcha{
			Enabled:  true,
			Provider: HCaptchaProvider,
			Secret: Secret{
				Value:  "test-secret",
				SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
			},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			SecurityCaptchaEnabled:  nullable.NewNullableWithValue(true),
			SecurityCaptchaProvider: nullable.NewNullableWithValue(v1API.AuthConfigResponseSecurityCaptchaProviderHcaptcha),
			SecurityCaptchaSecret:   nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local disabled remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Captcha = &captcha{
			Enabled:  false,
			Provider: TurnstileProvider,
			Secret: Secret{
				Value:  "test-key",
				SHA256: "ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e",
			},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			SecurityCaptchaEnabled:  nullable.NewNullableWithValue(true),
			SecurityCaptchaProvider: nullable.NewNullableWithValue(v1API.AuthConfigResponseSecurityCaptchaProviderHcaptcha),
			SecurityCaptchaSecret:   nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local enabled remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Captcha = &captcha{
			Enabled:  true,
			Provider: TurnstileProvider,
			Secret: Secret{
				Value:  "test-key",
				SHA256: "ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e",
			},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			SecurityCaptchaEnabled:  nullable.NewNullableWithValue(false),
			SecurityCaptchaProvider: nullable.NewNullableWithValue(v1API.AuthConfigResponseSecurityCaptchaProviderHcaptcha),
			SecurityCaptchaSecret:   nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local and remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Captcha = &captcha{
			Enabled: false,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			SecurityCaptchaEnabled: nullable.NewNullableWithValue(false),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("ignores undefined config", func(t *testing.T) {
		c := newWithDefaults()
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			SecurityCaptchaEnabled:  nullable.NewNullableWithValue(true),
			SecurityCaptchaProvider: nullable.NewNullableWithValue(v1API.AuthConfigResponseSecurityCaptchaProviderHcaptcha),
			SecurityCaptchaSecret:   nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}

func TestHookDiff(t *testing.T) {
	t.Run("local and remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Hook = hook{
			BeforeUserCreated: &hookConfig{
				Enabled: true,
				URI:     "http://example.com",
				Secrets: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			CustomAccessToken: &hookConfig{
				Enabled: true,
				URI:     "http://example.com",
				Secrets: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			SendSMS: &hookConfig{
				Enabled: true,
				URI:     "http://example.com",
				Secrets: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			SendEmail: &hookConfig{
				Enabled: true,
				URI:     "https://example.com",
				Secrets: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			MFAVerificationAttempt: &hookConfig{
				Enabled: true,
				URI:     "https://example.com",
				Secrets: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			PasswordVerificationAttempt: &hookConfig{
				Enabled: true,
				URI:     "pg-functions://verifyPassword",
			},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			HookBeforeUserCreatedEnabled:           nullable.NewNullableWithValue(true),
			HookBeforeUserCreatedUri:               nullable.NewNullableWithValue("http://example.com"),
			HookBeforeUserCreatedSecrets:           nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookCustomAccessTokenEnabled:           nullable.NewNullableWithValue(true),
			HookCustomAccessTokenUri:               nullable.NewNullableWithValue("http://example.com"),
			HookCustomAccessTokenSecrets:           nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookSendSmsEnabled:                     nullable.NewNullableWithValue(true),
			HookSendSmsUri:                         nullable.NewNullableWithValue("http://example.com"),
			HookSendSmsSecrets:                     nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookSendEmailEnabled:                   nullable.NewNullableWithValue(true),
			HookSendEmailUri:                       nullable.NewNullableWithValue("https://example.com"),
			HookSendEmailSecrets:                   nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookMfaVerificationAttemptEnabled:      nullable.NewNullableWithValue(true),
			HookMfaVerificationAttemptUri:          nullable.NewNullableWithValue("https://example.com"),
			HookMfaVerificationAttemptSecrets:      nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookPasswordVerificationAttemptEnabled: nullable.NewNullableWithValue(true),
			HookPasswordVerificationAttemptUri:     nullable.NewNullableWithValue("pg-functions://verifyPassword"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local disabled remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Hook = hook{
			BeforeUserCreated: &hookConfig{
				Enabled: false,
			},
			CustomAccessToken: &hookConfig{
				Enabled: false,
			},
			SendSMS: &hookConfig{
				Enabled: false,
				URI:     "https://example.com",
				Secrets: Secret{Value: "test-secret"},
			},
			SendEmail: &hookConfig{
				Enabled: false,
			},
			MFAVerificationAttempt: &hookConfig{
				Enabled: false,
				URI:     "pg-functions://postgres/public/verifyMFA",
			},
			PasswordVerificationAttempt: nil,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			HookBeforeUserCreatedEnabled:           nullable.NewNullableWithValue(true),
			HookBeforeUserCreatedUri:               nullable.NewNullableWithValue("http://example.com"),
			HookBeforeUserCreatedSecrets:           nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookCustomAccessTokenEnabled:           nullable.NewNullableWithValue(true),
			HookCustomAccessTokenUri:               nullable.NewNullableWithValue("http://example.com"),
			HookCustomAccessTokenSecrets:           nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookSendSmsEnabled:                     nullable.NewNullableWithValue(true),
			HookSendSmsUri:                         nullable.NewNullableWithValue("https://example.com"),
			HookSendSmsSecrets:                     nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookSendEmailEnabled:                   nullable.NewNullableWithValue(true),
			HookSendEmailUri:                       nullable.NewNullableWithValue("pg-functions://postgres/public/sendEmail"),
			HookMfaVerificationAttemptEnabled:      nullable.NewNullableWithValue(true),
			HookMfaVerificationAttemptUri:          nullable.NewNullableWithValue("pg-functions://postgres/public/verifyMFA"),
			HookPasswordVerificationAttemptEnabled: nullable.NewNullableWithValue(true),
			HookPasswordVerificationAttemptUri:     nullable.NewNullableWithValue("https://example.com"),
			HookPasswordVerificationAttemptSecrets: nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local enabled remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Hook = hook{
			BeforeUserCreated: &hookConfig{
				Enabled: true,
				URI:     "http://example.com",
				Secrets: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			CustomAccessToken: &hookConfig{
				Enabled: true,
				URI:     "http://example.com",
				Secrets: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			SendSMS: &hookConfig{
				Enabled: true,
				URI:     "https://example.com",
				Secrets: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			SendEmail: &hookConfig{
				Enabled: true,
				URI:     "pg-functions://postgres/public/sendEmail",
			},
			MFAVerificationAttempt: &hookConfig{
				Enabled: true,
				URI:     "pg-functions://postgres/public/verifyMFA",
			},
			PasswordVerificationAttempt: nil,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			HookBeforeUserCreatedEnabled:           nullable.NewNullableWithValue(false),
			HookBeforeUserCreatedUri:               nullable.NewNullableWithValue("pg-functions://postgres/public/beforeUserCreated"),
			HookCustomAccessTokenEnabled:           nullable.NewNullableWithValue(false),
			HookCustomAccessTokenUri:               nullable.NewNullableWithValue("pg-functions://postgres/public/customToken"),
			HookSendSmsEnabled:                     nullable.NewNullableWithValue(false),
			HookSendSmsUri:                         nullable.NewNullableWithValue("https://example.com"),
			HookSendSmsSecrets:                     nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookSendEmailEnabled:                   nullable.NewNullableWithValue(false),
			HookSendEmailUri:                       nullable.NewNullableWithValue("https://example.com"),
			HookSendEmailSecrets:                   nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			HookMfaVerificationAttemptEnabled:      nullable.NewNullableWithValue(false),
			HookMfaVerificationAttemptUri:          nullable.NewNullableWithValue("pg-functions://postgres/public/verifyMFA"),
			HookPasswordVerificationAttemptEnabled: nullable.NewNullableWithValue(false),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local and remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Hook = hook{
			BeforeUserCreated:           &hookConfig{Enabled: false},
			CustomAccessToken:           &hookConfig{Enabled: false},
			SendSMS:                     &hookConfig{Enabled: false},
			SendEmail:                   &hookConfig{Enabled: false},
			MFAVerificationAttempt:      &hookConfig{Enabled: false},
			PasswordVerificationAttempt: &hookConfig{Enabled: false},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			HookBeforeUserCreatedEnabled:           nullable.NewNullableWithValue(false),
			HookCustomAccessTokenEnabled:           nullable.NewNullableWithValue(false),
			HookSendSmsEnabled:                     nullable.NewNullableWithValue(false),
			HookSendEmailEnabled:                   nullable.NewNullableWithValue(false),
			HookMfaVerificationAttemptEnabled:      nullable.NewNullableWithValue(false),
			HookPasswordVerificationAttemptEnabled: nullable.NewNullableWithValue(false),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}

func TestMfaDiff(t *testing.T) {
	t.Run("local and remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.MFA = mfa{
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
				Template:     "Your code is {{ .Code }}",
				MaxFrequency: 5 * time.Second,
			},
			WebAuthn: factorTypeConfiguration{
				EnrollEnabled: true,
				VerifyEnabled: true,
			},
			MaxEnrolledFactors: 10,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			MfaMaxEnrolledFactors:    nullable.NewNullableWithValue(10),
			MfaTotpEnrollEnabled:     nullable.NewNullableWithValue(true),
			MfaTotpVerifyEnabled:     nullable.NewNullableWithValue(true),
			MfaPhoneEnrollEnabled:    nullable.NewNullableWithValue(true),
			MfaPhoneVerifyEnabled:    nullable.NewNullableWithValue(true),
			MfaPhoneOtpLength:        6,
			MfaPhoneTemplate:         nullable.NewNullableWithValue("Your code is {{ .Code }}"),
			MfaPhoneMaxFrequency:     nullable.NewNullableWithValue(5),
			MfaWebAuthnEnrollEnabled: nullable.NewNullableWithValue(true),
			MfaWebAuthnVerifyEnabled: nullable.NewNullableWithValue(true),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local enabled and disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.MFA = mfa{
			TOTP: factorTypeConfiguration{
				EnrollEnabled: false,
				VerifyEnabled: false,
			},
			Phone: phoneFactorTypeConfiguration{
				factorTypeConfiguration: factorTypeConfiguration{
					EnrollEnabled: true,
					VerifyEnabled: true,
				},
			},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			MfaMaxEnrolledFactors:    nullable.NewNullableWithValue(10),
			MfaTotpEnrollEnabled:     nullable.NewNullableWithValue(false),
			MfaTotpVerifyEnabled:     nullable.NewNullableWithValue(false),
			MfaPhoneEnrollEnabled:    nullable.NewNullableWithValue(false),
			MfaPhoneVerifyEnabled:    nullable.NewNullableWithValue(false),
			MfaPhoneOtpLength:        6,
			MfaPhoneTemplate:         nullable.NewNullableWithValue("Your code is {{ .Code }}"),
			MfaPhoneMaxFrequency:     nullable.NewNullableWithValue(5),
			MfaWebAuthnEnrollEnabled: nullable.NewNullableWithValue(false),
			MfaWebAuthnVerifyEnabled: nullable.NewNullableWithValue(false),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local and remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.MFA = mfa{
			MaxEnrolledFactors: 10,
			Phone: phoneFactorTypeConfiguration{
				OtpLength:    6,
				Template:     "Your code is {{ .Code }}",
				MaxFrequency: 5 * time.Second,
			},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			MfaMaxEnrolledFactors:    nullable.NewNullableWithValue(10),
			MfaTotpEnrollEnabled:     nullable.NewNullableWithValue(false),
			MfaTotpVerifyEnabled:     nullable.NewNullableWithValue(false),
			MfaPhoneEnrollEnabled:    nullable.NewNullableWithValue(false),
			MfaPhoneVerifyEnabled:    nullable.NewNullableWithValue(false),
			MfaPhoneOtpLength:        6,
			MfaPhoneTemplate:         nullable.NewNullableWithValue("Your code is {{ .Code }}"),
			MfaPhoneMaxFrequency:     nullable.NewNullableWithValue(5),
			MfaWebAuthnEnrollEnabled: nullable.NewNullableWithValue(false),
			MfaWebAuthnVerifyEnabled: nullable.NewNullableWithValue(false),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}

func TestEmailDiff(t *testing.T) {
	t.Run("local enabled remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Email = email{
			EnableSignup:         true,
			DoubleConfirmChanges: true,
			EnableConfirmations:  true,
			SecurePasswordChange: true,
			Template: map[string]emailTemplate{
				"invite": {
					Subject: cast.Ptr("invite-subject"),
					Content: cast.Ptr("invite-content"),
				},
				"confirmation": {
					Subject: cast.Ptr("confirmation-subject"),
					Content: cast.Ptr("confirmation-content"),
				},
				"recovery": {
					Subject: cast.Ptr("recovery-subject"),
					Content: cast.Ptr("recovery-content"),
				},
				"magic_link": {
					Subject: cast.Ptr("magic-link-subject"),
					Content: cast.Ptr("magic-link-content"),
				},
				"email_change": {
					Subject: cast.Ptr("email-change-subject"),
					Content: cast.Ptr("email-change-content"),
				},
				"reauthentication": {
					Subject: cast.Ptr("reauthentication-subject"),
					Content: cast.Ptr("reauthentication-content"),
				},
			},
			Smtp: &smtp{
				Enabled: true,
				Host:    "smtp.sendgrid.net",
				Port:    587,
				User:    "apikey",
				Pass: Secret{
					Value:  "test-key",
					SHA256: "ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e",
				},
				AdminEmail: openapi_types.Email("admin@email.com"),
				SenderName: "Admin",
			},
			MaxFrequency: time.Second,
			OtpLength:    6,
			OtpExpiry:    3600,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalEmailEnabled:           nullable.NewNullableWithValue(true),
			MailerSecureEmailChangeEnabled: nullable.NewNullableWithValue(true),
			MailerAutoconfirm:              nullable.NewNullableWithValue(false),
			MailerOtpLength:                nullable.NewNullableWithValue(6),
			MailerOtpExp:                   3600,
			SecurityUpdatePasswordRequireReauthentication: nullable.NewNullableWithValue(true),
			SmtpHost:         nullable.NewNullableWithValue("smtp.sendgrid.net"),
			SmtpPort:         nullable.NewNullableWithValue("587"),
			SmtpUser:         nullable.NewNullableWithValue("apikey"),
			SmtpPass:         nullable.NewNullableWithValue("ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e"),
			SmtpAdminEmail:   nullable.NewNullableWithValue(openapi_types.Email("admin@email.com")),
			SmtpSenderName:   nullable.NewNullableWithValue("Admin"),
			SmtpMaxFrequency: nullable.NewNullableWithValue(1),
			// Custom templates
			MailerSubjectsInvite:                   nullable.NewNullableWithValue("invite-subject"),
			MailerTemplatesInviteContent:           nullable.NewNullableWithValue("invite-content"),
			MailerSubjectsConfirmation:             nullable.NewNullableWithValue("confirmation-subject"),
			MailerTemplatesConfirmationContent:     nullable.NewNullableWithValue("confirmation-content"),
			MailerSubjectsRecovery:                 nullable.NewNullableWithValue("recovery-subject"),
			MailerTemplatesRecoveryContent:         nullable.NewNullableWithValue("recovery-content"),
			MailerSubjectsMagicLink:                nullable.NewNullableWithValue("magic-link-subject"),
			MailerTemplatesMagicLinkContent:        nullable.NewNullableWithValue("magic-link-content"),
			MailerSubjectsEmailChange:              nullable.NewNullableWithValue("email-change-subject"),
			MailerTemplatesEmailChangeContent:      nullable.NewNullableWithValue("email-change-content"),
			MailerSubjectsReauthentication:         nullable.NewNullableWithValue("reauthentication-subject"),
			MailerTemplatesReauthenticationContent: nullable.NewNullableWithValue("reauthentication-content"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local enabled remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Email = email{
			EnableSignup:         true,
			DoubleConfirmChanges: true,
			EnableConfirmations:  true,
			SecurePasswordChange: true,
			Template: map[string]emailTemplate{
				"invite": {
					Subject: cast.Ptr("invite-subject"),
					Content: cast.Ptr("invite-content"),
				},
				"confirmation": {
					Subject: cast.Ptr("confirmation-subject"),
				},
				"recovery": {
					Content: cast.Ptr("recovery-content"),
				},
				"magic_link": {
					Subject: cast.Ptr("magic-link-subject"),
					Content: cast.Ptr("magic-link-content"),
				},
				"email_change": {
					Subject: cast.Ptr("email-change-subject"),
					Content: cast.Ptr("email-change-content"),
				},
				"reauthentication": {
					Subject: cast.Ptr(""),
					Content: cast.Ptr(""),
				},
			},
			Smtp: &smtp{
				Enabled: true,
				Host:    "smtp.sendgrid.net",
				Port:    587,
				User:    "apikey",
				Pass: Secret{
					Value:  "test-key",
					SHA256: "ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e",
				},
				AdminEmail: openapi_types.Email("admin@email.com"),
				SenderName: "Admin",
			},
			MaxFrequency: time.Second,
			OtpLength:    8,
			OtpExpiry:    86400,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalEmailEnabled:           nullable.NewNullableWithValue(false),
			MailerSecureEmailChangeEnabled: nullable.NewNullableWithValue(false),
			MailerAutoconfirm:              nullable.NewNullableWithValue(true),
			MailerOtpLength:                nullable.NewNullableWithValue(6),
			MailerOtpExp:                   3600,
			SecurityUpdatePasswordRequireReauthentication: nullable.NewNullableWithValue(false),
			SmtpMaxFrequency: nullable.NewNullableWithValue(60),
			// Custom templates
			MailerTemplatesConfirmationContent: nullable.NewNullableWithValue("confirmation-content"),
			MailerSubjectsRecovery:             nullable.NewNullableWithValue("recovery-subject"),
			MailerSubjectsMagicLink:            nullable.NewNullableWithValue("magic-link-subject"),
			MailerTemplatesEmailChangeContent:  nullable.NewNullableWithValue("email-change-content"),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local disabled remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Email = email{
			EnableConfirmations: false,
			Template: map[string]emailTemplate{
				"invite":           {},
				"confirmation":     {},
				"recovery":         {},
				"magic_link":       {},
				"email_change":     {},
				"reauthentication": {},
			},
			MaxFrequency: time.Minute,
			OtpLength:    8,
			OtpExpiry:    86400,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalEmailEnabled:           nullable.NewNullableWithValue(true),
			MailerSecureEmailChangeEnabled: nullable.NewNullableWithValue(true),
			MailerAutoconfirm:              nullable.NewNullableWithValue(false),
			MailerOtpLength:                nullable.NewNullableWithValue(6),
			MailerOtpExp:                   3600,
			SecurityUpdatePasswordRequireReauthentication: nullable.NewNullableWithValue(true),
			SmtpHost:         nullable.NewNullableWithValue("smtp.sendgrid.net"),
			SmtpPort:         nullable.NewNullableWithValue("587"),
			SmtpUser:         nullable.NewNullableWithValue("apikey"),
			SmtpPass:         nullable.NewNullableWithValue("ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e"),
			SmtpAdminEmail:   nullable.NewNullableWithValue(openapi_types.Email("admin@email.com")),
			SmtpSenderName:   nullable.NewNullableWithValue("Admin"),
			SmtpMaxFrequency: nullable.NewNullableWithValue(1),
			// Custom templates
			MailerSubjectsInvite:                   nullable.NewNullableWithValue("invite-subject"),
			MailerTemplatesInviteContent:           nullable.NewNullableWithValue("invite-content"),
			MailerSubjectsConfirmation:             nullable.NewNullableWithValue("confirmation-subject"),
			MailerTemplatesConfirmationContent:     nullable.NewNullableWithValue("confirmation-content"),
			MailerSubjectsRecovery:                 nullable.NewNullableWithValue("recovery-subject"),
			MailerTemplatesRecoveryContent:         nullable.NewNullableWithValue("recovery-content"),
			MailerSubjectsMagicLink:                nullable.NewNullableWithValue("magic-link-subject"),
			MailerTemplatesMagicLinkContent:        nullable.NewNullableWithValue("magic-link-content"),
			MailerSubjectsEmailChange:              nullable.NewNullableWithValue("email-change-subject"),
			MailerTemplatesEmailChangeContent:      nullable.NewNullableWithValue("email-change-content"),
			MailerSubjectsReauthentication:         nullable.NewNullableWithValue("reauthentication-subject"),
			MailerTemplatesReauthenticationContent: nullable.NewNullableWithValue("reauthentication-content"),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local disabled remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Email = email{
			EnableConfirmations: false,
			Template: map[string]emailTemplate{
				"invite":           {},
				"confirmation":     {},
				"recovery":         {},
				"magic_link":       {},
				"email_change":     {},
				"reauthentication": {},
			},
			Smtp: &smtp{
				Enabled: false,
				Host:    "smtp.sendgrid.net",
				Port:    587,
				User:    "apikey",
				Pass: Secret{
					Value:  "test-key",
					SHA256: "ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e",
				},
				AdminEmail: openapi_types.Email("admin@email.com"),
				SenderName: "Admin",
			},
			MaxFrequency: time.Minute,
			OtpLength:    6,
			OtpExpiry:    3600,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalEmailEnabled:           nullable.NewNullableWithValue(false),
			MailerSecureEmailChangeEnabled: nullable.NewNullableWithValue(false),
			MailerAutoconfirm:              nullable.NewNullableWithValue(true),
			MailerOtpLength:                nullable.NewNullableWithValue(6),
			MailerOtpExp:                   3600,
			SecurityUpdatePasswordRequireReauthentication: nullable.NewNullableWithValue(false),
			SmtpMaxFrequency: nullable.NewNullableWithValue(60),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}

func TestSmsDiff(t *testing.T) {
	t.Run("local enabled remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Sms = sms{
			EnableSignup:        true,
			EnableConfirmations: true,
			Template:            "Your code is {{ .Code }}",
			TestOTP:             map[string]string{"123": "456"},
			MaxFrequency:        time.Minute,
			Twilio: twilioConfig{
				Enabled:           true,
				AccountSid:        "test-account",
				MessageServiceSid: "test-service",
				AuthToken: Secret{
					Value:  "test-token",
					SHA256: "c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88",
				},
			},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalPhoneEnabled:       nullable.NewNullableWithValue(true),
			SmsAutoconfirm:             nullable.NewNullableWithValue(true),
			SmsMaxFrequency:            nullable.NewNullableWithValue(60),
			SmsOtpExp:                  nullable.NewNullableWithValue(3600),
			SmsOtpLength:               6,
			SmsProvider:                nullable.NewNullableWithValue(v1API.AuthConfigResponseSmsProviderTwilio),
			SmsTemplate:                nullable.NewNullableWithValue("Your code is {{ .Code }}"),
			SmsTestOtp:                 nullable.NewNullableWithValue("123=456"),
			SmsTestOtpValidUntil:       nullable.NewNullableWithValue(time.Date(2050, 1, 1, 1, 0, 0, 0, time.UTC)),
			SmsTwilioAccountSid:        nullable.NewNullableWithValue("test-account"),
			SmsTwilioAuthToken:         nullable.NewNullableWithValue("c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88"),
			SmsTwilioContentSid:        nullable.NewNullableWithValue("test-content"),
			SmsTwilioMessageServiceSid: nullable.NewNullableWithValue("test-service"),
			// Extra configs returned from api can be ignored
			SmsMessagebirdAccessKey:          nullable.NewNullableWithValue("test-messagebird-key"),
			SmsMessagebirdOriginator:         nullable.NewNullableWithValue("test-messagebird-originator"),
			SmsTextlocalApiKey:               nullable.NewNullableWithValue("test-textlocal-key"),
			SmsTextlocalSender:               nullable.NewNullableWithValue("test-textlocal-sencer"),
			SmsTwilioVerifyAccountSid:        nullable.NewNullableWithValue("test-verify-account"),
			SmsTwilioVerifyAuthToken:         nullable.NewNullableWithValue("test-verify-token"),
			SmsTwilioVerifyMessageServiceSid: nullable.NewNullableWithValue("test-verify-service"),
			SmsVonageApiKey:                  nullable.NewNullableWithValue("test-vonage-key"),
			SmsVonageApiSecret:               nullable.NewNullableWithValue("test-vonage-secret"),
			SmsVonageFrom:                    nullable.NewNullableWithValue("test-vonage-from"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local disabled remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalPhoneEnabled:       nullable.NewNullableWithValue(true),
			SmsAutoconfirm:             nullable.NewNullableWithValue(true),
			SmsMaxFrequency:            nullable.NewNullableWithValue(60),
			SmsOtpExp:                  nullable.NewNullableWithValue(3600),
			SmsOtpLength:               6,
			SmsProvider:                nullable.NewNullableWithValue(v1API.AuthConfigResponseSmsProviderTwilio),
			SmsTemplate:                nullable.NewNullableWithValue("Your code is {{ .Code }}"),
			SmsTestOtp:                 nullable.NewNullableWithValue("123=456,456=123"),
			SmsTestOtpValidUntil:       nullable.NewNullableWithValue(time.Date(2050, 1, 1, 1, 0, 0, 0, time.UTC)),
			SmsTwilioAccountSid:        nullable.NewNullableWithValue("test-account"),
			SmsTwilioAuthToken:         nullable.NewNullableWithValue("c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88"),
			SmsTwilioContentSid:        nullable.NewNullableWithValue("test-content"),
			SmsTwilioMessageServiceSid: nullable.NewNullableWithValue("test-service"),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local enabled remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Sms = sms{
			EnableSignup:        true,
			EnableConfirmations: true,
			Template:            "Your code is {{ .Code }}",
			TestOTP:             map[string]string{"123": "456"},
			MaxFrequency:        time.Minute,
			Messagebird: messagebirdConfig{
				Enabled:    true,
				Originator: "test-originator",
				AccessKey: Secret{
					Value:  "test-access-key",
					SHA256: "ab60d03fc809fb02dae838582f3ddc13d1d6cb32ffba77c4b969dd3caa496f13",
				},
			},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalPhoneEnabled:       nullable.NewNullableWithValue(false),
			SmsAutoconfirm:             nullable.NewNullableWithValue(false),
			SmsMaxFrequency:            nullable.NewNullableWithValue(0),
			SmsOtpExp:                  nullable.NewNullableWithValue(3600),
			SmsOtpLength:               6,
			SmsProvider:                nullable.NewNullableWithValue(v1API.AuthConfigResponseSmsProviderTwilio),
			SmsTemplate:                nullable.NewNullableWithValue(""),
			SmsTwilioAccountSid:        nullable.NewNullableWithValue("test-account"),
			SmsTwilioAuthToken:         nullable.NewNullableWithValue("c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88"),
			SmsTwilioContentSid:        nullable.NewNullableWithValue("test-content"),
			SmsTwilioMessageServiceSid: nullable.NewNullableWithValue("test-service"),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local disabled remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Sms = sms{
			EnableSignup:        false,
			EnableConfirmations: true,
			Template:            "Your code is {{ .Code }}",
			TestOTP:             map[string]string{"123": "456"},
			MaxFrequency:        time.Minute,
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalPhoneEnabled:     nullable.NewNullableWithValue(false),
			SmsAutoconfirm:           nullable.NewNullableWithValue(true),
			SmsMaxFrequency:          nullable.NewNullableWithValue(60),
			SmsOtpExp:                nullable.NewNullableWithValue(3600),
			SmsOtpLength:             6,
			SmsTemplate:              nullable.NewNullableWithValue("Your code is {{ .Code }}"),
			SmsTestOtp:               nullable.NewNullableWithValue("123=456"),
			SmsTestOtpValidUntil:     nullable.NewNullableWithValue(time.Date(2050, 1, 1, 1, 0, 0, 0, time.UTC)),
			SmsProvider:              nullable.NewNullableWithValue(v1API.AuthConfigResponseSmsProviderMessagebird),
			SmsMessagebirdAccessKey:  nullable.NewNullableWithValue("test-messagebird-key"),
			SmsMessagebirdOriginator: nullable.NewNullableWithValue("test-messagebird-originator"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("enable sign up without provider", func(t *testing.T) {
		// This is not a valid config because platform requires a SMS provider.
		// For consistency, we handle this in config.Load and emit a warning.
		c := newWithDefaults()
		c.Sms.EnableSignup = true
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalPhoneEnabled: nullable.NewNullableWithValue(false),
			SmsProvider:          nullable.NewNullableWithValue(v1API.AuthConfigResponseSmsProviderTwilio),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("enable provider without sign up", func(t *testing.T) {
		c := newWithDefaults()
		c.Sms.Messagebird.Enabled = true
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalPhoneEnabled:    nullable.NewNullableWithValue(false),
			SmsProvider:             nullable.NewNullableWithValue(v1API.AuthConfigResponseSmsProviderMessagebird),
			SmsMessagebirdAccessKey: nullable.NewNullableWithValue(""),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}

func TestExternalDiff(t *testing.T) {
	t.Run("local and remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.External = map[string]provider{
			"apple":         {Enabled: true},
			"azure":         {Enabled: true},
			"bitbucket":     {Enabled: true},
			"discord":       {Enabled: true},
			"facebook":      {Enabled: true},
			"figma":         {Enabled: true},
			"github":        {Enabled: true},
			"gitlab":        {Enabled: true},
			"google":        {Enabled: true},
			"kakao":         {Enabled: true},
			"keycloak":      {Enabled: true},
			"linkedin_oidc": {Enabled: true},
			"notion":        {Enabled: true},
			"slack_oidc":    {Enabled: true},
			"spotify":       {Enabled: true},
			"twitch":        {Enabled: true},
			"twitter":       {Enabled: true},
			"workos":        {Enabled: true},
			"zoom":          {Enabled: true},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalAppleAdditionalClientIds:  nullable.NewNullableWithValue(""),
			ExternalAppleClientId:             nullable.NewNullableWithValue(""),
			ExternalAppleEnabled:              nullable.NewNullableWithValue(true),
			ExternalAppleSecret:               nullable.NewNullableWithValue(""),
			ExternalAzureClientId:             nullable.NewNullableWithValue(""),
			ExternalAzureEnabled:              nullable.NewNullableWithValue(true),
			ExternalAzureSecret:               nullable.NewNullableWithValue(""),
			ExternalAzureUrl:                  nullable.NewNullableWithValue(""),
			ExternalBitbucketClientId:         nullable.NewNullableWithValue(""),
			ExternalBitbucketEnabled:          nullable.NewNullableWithValue(true),
			ExternalBitbucketSecret:           nullable.NewNullableWithValue(""),
			ExternalDiscordClientId:           nullable.NewNullableWithValue(""),
			ExternalDiscordEnabled:            nullable.NewNullableWithValue(true),
			ExternalDiscordSecret:             nullable.NewNullableWithValue(""),
			ExternalFacebookClientId:          nullable.NewNullableWithValue(""),
			ExternalFacebookEnabled:           nullable.NewNullableWithValue(true),
			ExternalFacebookSecret:            nullable.NewNullableWithValue(""),
			ExternalFigmaClientId:             nullable.NewNullableWithValue(""),
			ExternalFigmaEnabled:              nullable.NewNullableWithValue(true),
			ExternalFigmaSecret:               nullable.NewNullableWithValue(""),
			ExternalGithubClientId:            nullable.NewNullableWithValue(""),
			ExternalGithubEnabled:             nullable.NewNullableWithValue(true),
			ExternalGithubSecret:              nullable.NewNullableWithValue(""),
			ExternalGitlabClientId:            nullable.NewNullableWithValue(""),
			ExternalGitlabEnabled:             nullable.NewNullableWithValue(true),
			ExternalGitlabSecret:              nullable.NewNullableWithValue(""),
			ExternalGitlabUrl:                 nullable.NewNullableWithValue(""),
			ExternalGoogleAdditionalClientIds: nullable.NewNullableWithValue(""),
			ExternalGoogleClientId:            nullable.NewNullableWithValue(""),
			ExternalGoogleEnabled:             nullable.NewNullableWithValue(true),
			ExternalGoogleSecret:              nullable.NewNullableWithValue(""),
			ExternalGoogleSkipNonceCheck:      nullable.NewNullableWithValue(false),
			ExternalKakaoClientId:             nullable.NewNullableWithValue(""),
			ExternalKakaoEnabled:              nullable.NewNullableWithValue(true),
			ExternalKakaoSecret:               nullable.NewNullableWithValue(""),
			ExternalKeycloakClientId:          nullable.NewNullableWithValue(""),
			ExternalKeycloakEnabled:           nullable.NewNullableWithValue(true),
			ExternalKeycloakSecret:            nullable.NewNullableWithValue(""),
			ExternalKeycloakUrl:               nullable.NewNullableWithValue(""),
			ExternalLinkedinOidcClientId:      nullable.NewNullableWithValue(""),
			ExternalLinkedinOidcEnabled:       nullable.NewNullableWithValue(true),
			ExternalLinkedinOidcSecret:        nullable.NewNullableWithValue(""),
			ExternalNotionClientId:            nullable.NewNullableWithValue(""),
			ExternalNotionEnabled:             nullable.NewNullableWithValue(true),
			ExternalNotionSecret:              nullable.NewNullableWithValue(""),
			ExternalSlackOidcClientId:         nullable.NewNullableWithValue(""),
			ExternalSlackOidcEnabled:          nullable.NewNullableWithValue(true),
			ExternalSlackOidcSecret:           nullable.NewNullableWithValue(""),
			ExternalSpotifyClientId:           nullable.NewNullableWithValue(""),
			ExternalSpotifyEnabled:            nullable.NewNullableWithValue(true),
			ExternalSpotifySecret:             nullable.NewNullableWithValue(""),
			ExternalTwitchClientId:            nullable.NewNullableWithValue(""),
			ExternalTwitchEnabled:             nullable.NewNullableWithValue(true),
			ExternalTwitchSecret:              nullable.NewNullableWithValue(""),
			ExternalTwitterClientId:           nullable.NewNullableWithValue(""),
			ExternalTwitterEnabled:            nullable.NewNullableWithValue(true),
			ExternalTwitterSecret:             nullable.NewNullableWithValue(""),
			ExternalWorkosClientId:            nullable.NewNullableWithValue(""),
			ExternalWorkosEnabled:             nullable.NewNullableWithValue(true),
			ExternalWorkosSecret:              nullable.NewNullableWithValue(""),
			ExternalWorkosUrl:                 nullable.NewNullableWithValue(""),
			ExternalZoomClientId:              nullable.NewNullableWithValue(""),
			ExternalZoomEnabled:               nullable.NewNullableWithValue(true),
			ExternalZoomSecret:                nullable.NewNullableWithValue(""),
			// Deprecated fields should be ignored
			ExternalSlackClientId: nullable.NewNullableWithValue(""),
			ExternalSlackEnabled:  nullable.NewNullableWithValue(true),
			ExternalSlackSecret:   nullable.NewNullableWithValue(""),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local enabled and disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.External = map[string]provider{
			"apple": {
				Enabled:  true,
				ClientId: "test-client-1,test-client-2",
				Secret: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			"azure": {
				Enabled:  true,
				ClientId: "test-client-1",
				Secret: Secret{
					Value:  "test-secret",
					SHA256: "ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252",
				},
			},
			"bitbucket": {},
			"discord":   {},
			"facebook":  {},
			"figma":     {},
			"github":    {},
			"gitlab":    {},
			"google": {
				Enabled:        false,
				ClientId:       "test-client-2",
				Secret:         Secret{Value: "env(test_secret)"},
				SkipNonceCheck: false,
			},
			// "kakao":         {},
			"keycloak":      {},
			"linkedin_oidc": {},
			"notion":        {},
			"slack_oidc":    {},
			"spotify":       {},
			"twitch":        {},
			"twitter":       {},
			"workos":        {},
			"zoom":          {},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalAppleAdditionalClientIds:  nullable.NewNullableWithValue("test-client-2"),
			ExternalAppleClientId:             nullable.NewNullableWithValue("test-client-1"),
			ExternalAppleEnabled:              nullable.NewNullableWithValue(false),
			ExternalAppleSecret:               nullable.NewNullableWithValue("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			ExternalGoogleAdditionalClientIds: nullable.NewNullableWithValue("test-client-2"),
			ExternalGoogleClientId:            nullable.NewNullableWithValue("test-client-1"),
			ExternalGoogleEnabled:             nullable.NewNullableWithValue(true),
			ExternalGoogleSecret:              nullable.NewNullableWithValue("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalGoogleSkipNonceCheck:      nullable.NewNullableWithValue(true),
			ExternalKakaoClientId:             nullable.NewNullableWithValue("test-client-2"),
			ExternalKakaoEnabled:              nullable.NewNullableWithValue(true),
			ExternalKakaoSecret:               nullable.NewNullableWithValue("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
		})
		// Check error
		assert.NoError(t, err)
		assertSnapshotEqual(t, diff)
	})

	t.Run("local and remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.External = map[string]provider{
			"apple":         {},
			"azure":         {},
			"bitbucket":     {},
			"discord":       {},
			"facebook":      {},
			"figma":         {},
			"github":        {},
			"gitlab":        {},
			"google":        {},
			"kakao":         {},
			"keycloak":      {},
			"linkedin_oidc": {},
			"notion":        {},
			"slack_oidc":    {},
			"spotify":       {},
			"twitch":        {},
			"twitter":       {},
			"workos":        {},
			"zoom":          {},
		}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			ExternalAppleEnabled:         nullable.NewNullableWithValue(false),
			ExternalAzureEnabled:         nullable.NewNullableWithValue(false),
			ExternalBitbucketEnabled:     nullable.NewNullableWithValue(false),
			ExternalDiscordEnabled:       nullable.NewNullableWithValue(false),
			ExternalFacebookEnabled:      nullable.NewNullableWithValue(false),
			ExternalFigmaEnabled:         nullable.NewNullableWithValue(false),
			ExternalGithubEnabled:        nullable.NewNullableWithValue(false),
			ExternalGitlabEnabled:        nullable.NewNullableWithValue(false),
			ExternalGoogleEnabled:        nullable.NewNullableWithValue(false),
			ExternalGoogleSkipNonceCheck: nullable.NewNullableWithValue(false),
			ExternalKakaoEnabled:         nullable.NewNullableWithValue(false),
			ExternalKeycloakEnabled:      nullable.NewNullableWithValue(false),
			ExternalLinkedinOidcEnabled:  nullable.NewNullableWithValue(false),
			ExternalNotionEnabled:        nullable.NewNullableWithValue(false),
			ExternalSlackOidcEnabled:     nullable.NewNullableWithValue(false),
			ExternalSpotifyEnabled:       nullable.NewNullableWithValue(false),
			ExternalTwitchEnabled:        nullable.NewNullableWithValue(false),
			ExternalTwitterEnabled:       nullable.NewNullableWithValue(false),
			ExternalWorkosEnabled:        nullable.NewNullableWithValue(false),
			ExternalZoomEnabled:          nullable.NewNullableWithValue(false),
			// Deprecated fields should be ignored
			ExternalSlackEnabled: nullable.NewNullableWithValue(false),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}

func TestRateLimitsDiff(t *testing.T) {
	t.Run("local and remote rate limits match", func(t *testing.T) {
		// Setup auth with rate limits
		c := newWithDefaults()
		c.RateLimit.AnonymousUsers = 20
		c.RateLimit.TokenRefresh = 30
		c.RateLimit.SignInSignUps = 40
		c.RateLimit.TokenVerifications = 50
		c.RateLimit.EmailSent = 25
		c.RateLimit.SmsSent = 35
		c.Email.Smtp = &smtp{Enabled: true}
		// Run test
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			RateLimitAnonymousUsers: nullable.NewNullableWithValue(20),
			RateLimitTokenRefresh:   nullable.NewNullableWithValue(30),
			RateLimitOtp:            nullable.NewNullableWithValue(40),
			RateLimitVerify:         nullable.NewNullableWithValue(50),
			RateLimitEmailSent:      nullable.NewNullableWithValue(25),
			RateLimitSmsSent:        nullable.NewNullableWithValue(35),
			SmtpHost:                nullable.NewNullableWithValue(""),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local and remote rate limits differ", func(t *testing.T) {
		// Setup auth with rate limits
		c := newWithDefaults()
		c.RateLimit.AnonymousUsers = 20
		c.RateLimit.TokenRefresh = 30
		c.RateLimit.SignInSignUps = 40
		c.RateLimit.TokenVerifications = 50
		c.RateLimit.EmailSent = 25
		c.RateLimit.SmsSent = 35
		c.Email.Smtp = &smtp{Enabled: true}
		// Run test with different remote values
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			RateLimitAnonymousUsers: nullable.NewNullableWithValue(10), // Different value
			RateLimitTokenRefresh:   nullable.NewNullableWithValue(30),
			RateLimitOtp:            nullable.NewNullableWithValue(45), // Different value
			RateLimitVerify:         nullable.NewNullableWithValue(50),
			RateLimitEmailSent:      nullable.NewNullableWithValue(15), // Different value
			RateLimitSmsSent:        nullable.NewNullableWithValue(55), // Different value
			SmtpHost:                nullable.NewNullableWithValue(""),
		})
		// Check error
		assert.NoError(t, err)
		// Compare with snapshot
		assertSnapshotEqual(t, diff)
	})

	t.Run("ignores email rate limit when smtp is disabled", func(t *testing.T) {
		// Setup auth without rate limits
		c := newWithDefaults()
		c.RateLimit.EmailSent = 25
		// Run test with remote rate limits
		diff, err := c.DiffWithRemote(v1API.AuthConfigResponse{
			RateLimitEmailSent: nullable.NewNullableWithValue(15),
			SmtpHost:           nullable.NewNullableWithValue(""),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}
