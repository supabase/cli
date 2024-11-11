package config

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func newWithDefaults() auth {
	return auth{
		EnableSignup: true,
		Email: email{
			EnableConfirmations: true,
		},
	}
}

func TestHookDiff(t *testing.T) {
	t.Run("local and remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Hook = hook{
			CustomAccessToken:           hookConfig{Enabled: true},
			SendSMS:                     hookConfig{Enabled: true},
			SendEmail:                   hookConfig{Enabled: true},
			MFAVerificationAttempt:      hookConfig{Enabled: true},
			PasswordVerificationAttempt: hookConfig{Enabled: true},
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			HookCustomAccessTokenEnabled:           cast.Ptr(true),
			HookCustomAccessTokenUri:               cast.Ptr(""),
			HookCustomAccessTokenSecrets:           cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			HookSendEmailEnabled:                   cast.Ptr(true),
			HookSendEmailUri:                       cast.Ptr(""),
			HookSendEmailSecrets:                   cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			HookSendSmsEnabled:                     cast.Ptr(true),
			HookSendSmsUri:                         cast.Ptr(""),
			HookSendSmsSecrets:                     cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			HookMfaVerificationAttemptEnabled:      cast.Ptr(true),
			HookMfaVerificationAttemptUri:          cast.Ptr(""),
			HookMfaVerificationAttemptSecrets:      cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			HookPasswordVerificationAttemptEnabled: cast.Ptr(true),
			HookPasswordVerificationAttemptUri:     cast.Ptr(""),
			HookPasswordVerificationAttemptSecrets: cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local enabled and disabled", func(t *testing.T) {
		c := newWithDefaults()
		c.Hook = hook{
			CustomAccessToken:      hookConfig{Enabled: true},
			MFAVerificationAttempt: hookConfig{Enabled: false},
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			HookCustomAccessTokenEnabled:      cast.Ptr(false),
			HookCustomAccessTokenUri:          cast.Ptr(""),
			HookCustomAccessTokenSecrets:      cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			HookMfaVerificationAttemptEnabled: cast.Ptr(true),
			HookMfaVerificationAttemptUri:     cast.Ptr(""),
			HookMfaVerificationAttemptSecrets: cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
		})
		// Check error
		assert.NoError(t, err)

		assert.Contains(t, string(diff), ` [hook.mfa_verification_attempt]`)
		assert.Contains(t, string(diff), `-enabled = true`)
		assert.Contains(t, string(diff), `+enabled = false`)
		assert.Contains(t, string(diff), ` uri = ""`)
		assert.Contains(t, string(diff), ` secrets = ""`)

		assert.Contains(t, string(diff), ` [hook.custom_access_token]`)
		assert.Contains(t, string(diff), `-enabled = false`)
		assert.Contains(t, string(diff), `+enabled = true`)
		assert.Contains(t, string(diff), ` uri = ""`)
		assert.Contains(t, string(diff), ` secrets = "hash:b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"`)
	})

	t.Run("local and remote disabled", func(t *testing.T) {
		c := newWithDefaults()
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			HookCustomAccessTokenEnabled:           cast.Ptr(false),
			HookSendEmailEnabled:                   cast.Ptr(false),
			HookSendSmsEnabled:                     cast.Ptr(false),
			HookMfaVerificationAttemptEnabled:      cast.Ptr(false),
			HookPasswordVerificationAttemptEnabled: cast.Ptr(false),
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
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			MfaMaxEnrolledFactors:    cast.Ptr(10),
			MfaTotpEnrollEnabled:     cast.Ptr(true),
			MfaTotpVerifyEnabled:     cast.Ptr(true),
			MfaPhoneEnrollEnabled:    cast.Ptr(true),
			MfaPhoneVerifyEnabled:    cast.Ptr(true),
			MfaPhoneOtpLength:        6,
			MfaPhoneTemplate:         cast.Ptr("Your code is {{ .Code }}"),
			MfaPhoneMaxFrequency:     cast.Ptr(5),
			MfaWebAuthnEnrollEnabled: cast.Ptr(true),
			MfaWebAuthnVerifyEnabled: cast.Ptr(true),
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
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			MfaMaxEnrolledFactors:    cast.Ptr(10),
			MfaTotpEnrollEnabled:     cast.Ptr(false),
			MfaTotpVerifyEnabled:     cast.Ptr(false),
			MfaPhoneEnrollEnabled:    cast.Ptr(false),
			MfaPhoneVerifyEnabled:    cast.Ptr(false),
			MfaPhoneOtpLength:        6,
			MfaPhoneTemplate:         cast.Ptr("Your code is {{ .Code }}"),
			MfaPhoneMaxFrequency:     cast.Ptr(5),
			MfaWebAuthnEnrollEnabled: cast.Ptr(false),
			MfaWebAuthnVerifyEnabled: cast.Ptr(false),
		})
		// Check error
		assert.NoError(t, err)
		assert.Contains(t, string(diff), ` [mfa]`)
		assert.Contains(t, string(diff), `-max_enrolled_factors = 10`)
		assert.Contains(t, string(diff), `+max_enrolled_factors = 0`)
		assert.Contains(t, string(diff), ` [mfa.totp]`)
		assert.Contains(t, string(diff), ` enroll_enabled = false`)
		assert.Contains(t, string(diff), ` verify_enabled = false`)
		assert.Contains(t, string(diff), ` [mfa.phone]`)
		assert.Contains(t, string(diff), `-enroll_enabled = false`)
		assert.Contains(t, string(diff), `-verify_enabled = false`)
		assert.Contains(t, string(diff), `-otp_length = 6`)
		assert.Contains(t, string(diff), `-template = "Your code is {{ .Code }}"`)
		assert.Contains(t, string(diff), `-max_frequency = "5s"`)
		assert.Contains(t, string(diff), `+enroll_enabled = true`)
		assert.Contains(t, string(diff), `+verify_enabled = true`)
		assert.Contains(t, string(diff), `+otp_length = 0`)
		assert.Contains(t, string(diff), `+template = ""`)
		assert.Contains(t, string(diff), `+max_frequency = "0s"`)
		assert.Contains(t, string(diff), ` [mfa.web_authn]`)
		assert.Contains(t, string(diff), ` enroll_enabled = false`)
		assert.Contains(t, string(diff), ` verify_enabled = false`)
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
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			MfaMaxEnrolledFactors:    cast.Ptr(10),
			MfaTotpEnrollEnabled:     cast.Ptr(false),
			MfaTotpVerifyEnabled:     cast.Ptr(false),
			MfaPhoneEnrollEnabled:    cast.Ptr(false),
			MfaPhoneVerifyEnabled:    cast.Ptr(false),
			MfaPhoneOtpLength:        6,
			MfaPhoneTemplate:         cast.Ptr("Your code is {{ .Code }}"),
			MfaPhoneMaxFrequency:     cast.Ptr(5),
			MfaWebAuthnEnrollEnabled: cast.Ptr(false),
			MfaWebAuthnVerifyEnabled: cast.Ptr(false),
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
					Subject: "invite-subject",
					Content: "invite-content",
				},
				"confirmation": {
					Subject: "confirmation-subject",
					Content: "confirmation-content",
				},
				"recovery": {
					Subject: "recovery-subject",
					Content: "recovery-content",
				},
				"magic_link": {
					Subject: "magic-link-subject",
					Content: "magic-link-content",
				},
				"email_change": {
					Subject: "email-change-subject",
					Content: "email-change-content",
				},
				"reauthentication": {
					Subject: "reauthentication-subject",
					Content: "reauthentication-content",
				},
			},
			Smtp: &smtp{
				Host:       "smtp.sendgrid.net",
				Port:       587,
				User:       "apikey",
				Pass:       "test-key",
				AdminEmail: "admin@email.com",
				SenderName: "Admin",
			},
			MaxFrequency: time.Second,
			OtpLength:    6,
			OtpExpiry:    3600,
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalEmailEnabled:           cast.Ptr(true),
			MailerSecureEmailChangeEnabled: cast.Ptr(true),
			MailerAutoconfirm:              cast.Ptr(false),
			MailerOtpLength:                cast.Ptr(6),
			MailerOtpExp:                   3600,
			SecurityUpdatePasswordRequireReauthentication: cast.Ptr(true),
			SmtpHost:         cast.Ptr("smtp.sendgrid.net"),
			SmtpPort:         cast.Ptr("587"),
			SmtpUser:         cast.Ptr("apikey"),
			SmtpPass:         cast.Ptr("ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e"),
			SmtpAdminEmail:   cast.Ptr("admin@email.com"),
			SmtpSenderName:   cast.Ptr("Admin"),
			SmtpMaxFrequency: cast.Ptr(1),
			// Custom templates
			MailerSubjectsInvite:                   cast.Ptr("invite-subject"),
			MailerTemplatesInviteContent:           cast.Ptr("invite-content"),
			MailerSubjectsConfirmation:             cast.Ptr("confirmation-subject"),
			MailerTemplatesConfirmationContent:     cast.Ptr("confirmation-content"),
			MailerSubjectsRecovery:                 cast.Ptr("recovery-subject"),
			MailerTemplatesRecoveryContent:         cast.Ptr("recovery-content"),
			MailerSubjectsMagicLink:                cast.Ptr("magic-link-subject"),
			MailerTemplatesMagicLinkContent:        cast.Ptr("magic-link-content"),
			MailerSubjectsEmailChange:              cast.Ptr("email-change-subject"),
			MailerTemplatesEmailChangeContent:      cast.Ptr("email-change-content"),
			MailerSubjectsReauthentication:         cast.Ptr("reauthentication-subject"),
			MailerTemplatesReauthenticationContent: cast.Ptr("reauthentication-content"),
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
					Subject: "invite-subject",
					Content: "invite-content",
				},
				"confirmation": {
					Subject: "confirmation-subject",
				},
				"recovery": {
					Content: "recovery-content",
				},
				"magic_link": {
					Subject: "magic-link-subject",
					Content: "magic-link-content",
				},
				"email_change": {
					Subject: "email-change-subject",
					Content: "email-change-content",
				},
				"reauthentication": {
					Subject: "reauthentication-subject",
					Content: "reauthentication-content",
				},
			},
			Smtp: &smtp{
				Host:       "smtp.sendgrid.net",
				Port:       587,
				User:       "apikey",
				Pass:       "test-key",
				AdminEmail: "admin@email.com",
				SenderName: "Admin",
			},
			MaxFrequency: time.Second,
			OtpLength:    8,
			OtpExpiry:    86400,
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalEmailEnabled:           cast.Ptr(false),
			MailerSecureEmailChangeEnabled: cast.Ptr(false),
			MailerAutoconfirm:              cast.Ptr(true),
			MailerOtpLength:                cast.Ptr(6),
			MailerOtpExp:                   3600,
			SecurityUpdatePasswordRequireReauthentication: cast.Ptr(false),
			SmtpMaxFrequency: cast.Ptr(60),
			// Custom templates
			MailerTemplatesConfirmationContent: cast.Ptr("confirmation-content"),
			MailerSubjectsRecovery:             cast.Ptr("recovery-subject"),
			MailerSubjectsMagicLink:            cast.Ptr("magic-link-subject"),
			MailerTemplatesEmailChangeContent:  cast.Ptr("email-change-content"),
		})
		// Check error
		assert.NoError(t, err)

		assert.Contains(t, string(diff), ` [email]`)
		assert.Contains(t, string(diff), `-enable_signup = false`)
		assert.Contains(t, string(diff), `-double_confirm_changes = false`)
		assert.Contains(t, string(diff), `-enable_confirmations = false`)
		assert.Contains(t, string(diff), `-secure_password_change = false`)
		assert.Contains(t, string(diff), `-max_frequency = "1m0s"`)
		assert.Contains(t, string(diff), `-otp_length = 6`)
		assert.Contains(t, string(diff), `-otp_expiry = 3600`)
		assert.Contains(t, string(diff), `+enable_signup = true`)
		assert.Contains(t, string(diff), `+double_confirm_changes = true`)
		assert.Contains(t, string(diff), `+enable_confirmations = true`)
		assert.Contains(t, string(diff), `+secure_password_change = true`)
		assert.Contains(t, string(diff), `+max_frequency = "1s"`)
		assert.Contains(t, string(diff), `+otp_length = 8`)
		assert.Contains(t, string(diff), `+otp_expiry = 86400`)

		assert.Contains(t, string(diff), `+[email.smtp]`)
		assert.Contains(t, string(diff), `+host = "smtp.sendgrid.net"`)
		assert.Contains(t, string(diff), `+port = 587`)
		assert.Contains(t, string(diff), `+user = "apikey"`)
		assert.Contains(t, string(diff), `+pass = "hash:ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e"`)
		assert.Contains(t, string(diff), `+admin_email = "admin@email.com"`)
		assert.Contains(t, string(diff), `+sender_name = "Admin"`)

		assert.Contains(t, string(diff), ` [email.template]`)
		assert.Contains(t, string(diff), ` [email.template.confirmation]`)
		assert.Contains(t, string(diff), `-subject = ""`)
		assert.Contains(t, string(diff), `+subject = "confirmation-subject"`)
		assert.Contains(t, string(diff), ` content_path = ""`)
		assert.Contains(t, string(diff), ` content = ""`)
		assert.Contains(t, string(diff), ` [email.template.email_change]`)
		assert.Contains(t, string(diff), `-subject = ""`)
		assert.Contains(t, string(diff), `+subject = "email-change-subject"`)
		assert.Contains(t, string(diff), ` content_path = ""`)
		assert.Contains(t, string(diff), ` content = "email-change-content"`)
		assert.Contains(t, string(diff), ` [email.template.invite]`)
		assert.Contains(t, string(diff), `-subject = ""`)
		assert.Contains(t, string(diff), `-content_path = ""`)
		assert.Contains(t, string(diff), `-content = ""`)
		assert.Contains(t, string(diff), `+subject = "invite-subject"`)
		assert.Contains(t, string(diff), `+content_path = ""`)
		assert.Contains(t, string(diff), `+content = "invite-content"`)
		assert.Contains(t, string(diff), ` [email.template.magic_link]`)
		assert.Contains(t, string(diff), ` subject = "magic-link-subject"`)
		assert.Contains(t, string(diff), ` content_path = ""`)
		assert.Contains(t, string(diff), `-content = ""`)
		assert.Contains(t, string(diff), `+content = "magic-link-content"`)
		assert.Contains(t, string(diff), ` [email.template.recovery]`)
		assert.Contains(t, string(diff), ` subject = ""`)
		assert.Contains(t, string(diff), ` content_path = ""`)
		assert.Contains(t, string(diff), `-content = ""`)
		assert.Contains(t, string(diff), `+content = "recovery-content"`)
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
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalEmailEnabled:           cast.Ptr(true),
			MailerSecureEmailChangeEnabled: cast.Ptr(true),
			MailerAutoconfirm:              cast.Ptr(false),
			MailerOtpLength:                cast.Ptr(6),
			MailerOtpExp:                   3600,
			SecurityUpdatePasswordRequireReauthentication: cast.Ptr(true),
			SmtpHost:         cast.Ptr("smtp.sendgrid.net"),
			SmtpPort:         cast.Ptr("587"),
			SmtpUser:         cast.Ptr("apikey"),
			SmtpPass:         cast.Ptr("ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e"),
			SmtpAdminEmail:   cast.Ptr("admin@email.com"),
			SmtpSenderName:   cast.Ptr("Admin"),
			SmtpMaxFrequency: cast.Ptr(1),
			// Custom templates
			MailerSubjectsInvite:                   cast.Ptr("invite-subject"),
			MailerTemplatesInviteContent:           cast.Ptr("invite-content"),
			MailerSubjectsConfirmation:             cast.Ptr("confirmation-subject"),
			MailerTemplatesConfirmationContent:     cast.Ptr("confirmation-content"),
			MailerSubjectsRecovery:                 cast.Ptr("recovery-subject"),
			MailerTemplatesRecoveryContent:         cast.Ptr("recovery-content"),
			MailerSubjectsMagicLink:                cast.Ptr("magic-link-subject"),
			MailerTemplatesMagicLinkContent:        cast.Ptr("magic-link-content"),
			MailerSubjectsEmailChange:              cast.Ptr("email-change-subject"),
			MailerTemplatesEmailChangeContent:      cast.Ptr("email-change-content"),
			MailerSubjectsReauthentication:         cast.Ptr("reauthentication-subject"),
			MailerTemplatesReauthenticationContent: cast.Ptr("reauthentication-content"),
		})
		// Check error
		assert.NoError(t, err)

		assert.Contains(t, string(diff), ` [email]`)
		assert.Contains(t, string(diff), `-enable_signup = true`)
		assert.Contains(t, string(diff), `-double_confirm_changes = true`)
		assert.Contains(t, string(diff), `-enable_confirmations = true`)
		assert.Contains(t, string(diff), `-secure_password_change = true`)
		assert.Contains(t, string(diff), `-max_frequency = "1s"`)
		assert.Contains(t, string(diff), `-otp_length = 6`)
		assert.Contains(t, string(diff), `-otp_expiry = 3600`)
		assert.Contains(t, string(diff), `+enable_signup = false`)
		assert.Contains(t, string(diff), `+double_confirm_changes = false`)
		assert.Contains(t, string(diff), `+enable_confirmations = false`)
		assert.Contains(t, string(diff), `+secure_password_change = false`)
		assert.Contains(t, string(diff), `+max_frequency = "1m0s"`)
		assert.Contains(t, string(diff), `+otp_length = 8`)
		assert.Contains(t, string(diff), `+otp_expiry = 86400`)

		assert.Contains(t, string(diff), `-[email.smtp]`)
		assert.Contains(t, string(diff), `-host = "smtp.sendgrid.net"`)
		assert.Contains(t, string(diff), `-port = 587`)
		assert.Contains(t, string(diff), `-user = "apikey"`)
		assert.Contains(t, string(diff), `-pass = "hash:ed64b7695a606bc6ab4fcb41fe815b5ddf1063ccbc87afe1fa89756635db520e"`)
		assert.Contains(t, string(diff), `-admin_email = "admin@email.com"`)
		assert.Contains(t, string(diff), `-sender_name = "Admin"`)
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
			MaxFrequency: time.Minute,
			OtpLength:    6,
			OtpExpiry:    3600,
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalEmailEnabled:           cast.Ptr(false),
			MailerSecureEmailChangeEnabled: cast.Ptr(false),
			MailerAutoconfirm:              cast.Ptr(true),
			MailerOtpLength:                cast.Ptr(6),
			MailerOtpExp:                   3600,
			SecurityUpdatePasswordRequireReauthentication: cast.Ptr(false),
			SmtpMaxFrequency: cast.Ptr(60),
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
				AuthToken:         "test-token",
			},
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalPhoneEnabled:       cast.Ptr(true),
			SmsAutoconfirm:             cast.Ptr(true),
			SmsMaxFrequency:            cast.Ptr(60),
			SmsOtpExp:                  cast.Ptr(3600),
			SmsOtpLength:               6,
			SmsProvider:                cast.Ptr("twilio"),
			SmsTemplate:                cast.Ptr("Your code is {{ .Code }}"),
			SmsTestOtp:                 cast.Ptr("123=456"),
			SmsTestOtpValidUntil:       cast.Ptr("2050-01-01T01:00:00Z"),
			SmsTwilioAccountSid:        cast.Ptr("test-account"),
			SmsTwilioAuthToken:         cast.Ptr("c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88"),
			SmsTwilioContentSid:        cast.Ptr("test-content"),
			SmsTwilioMessageServiceSid: cast.Ptr("test-service"),
			// Extra configs returned from api can be ignored
			SmsMessagebirdAccessKey:          cast.Ptr("test-messagebird-key"),
			SmsMessagebirdOriginator:         cast.Ptr("test-messagebird-originator"),
			SmsTextlocalApiKey:               cast.Ptr("test-textlocal-key"),
			SmsTextlocalSender:               cast.Ptr("test-textlocal-sencer"),
			SmsTwilioVerifyAccountSid:        cast.Ptr("test-verify-account"),
			SmsTwilioVerifyAuthToken:         cast.Ptr("test-verify-token"),
			SmsTwilioVerifyMessageServiceSid: cast.Ptr("test-verify-service"),
			SmsVonageApiKey:                  cast.Ptr("test-vonage-key"),
			SmsVonageApiSecret:               cast.Ptr("test-vonage-secret"),
			SmsVonageFrom:                    cast.Ptr("test-vonage-from"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("local disabled remote enabled", func(t *testing.T) {
		c := newWithDefaults()
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalPhoneEnabled:       cast.Ptr(true),
			SmsAutoconfirm:             cast.Ptr(true),
			SmsMaxFrequency:            cast.Ptr(60),
			SmsOtpExp:                  cast.Ptr(3600),
			SmsOtpLength:               6,
			SmsProvider:                cast.Ptr("twilio"),
			SmsTemplate:                cast.Ptr("Your code is {{ .Code }}"),
			SmsTestOtp:                 cast.Ptr("123=456,456=123"),
			SmsTestOtpValidUntil:       cast.Ptr("2050-01-01T01:00:00Z"),
			SmsTwilioAccountSid:        cast.Ptr("test-account"),
			SmsTwilioAuthToken:         cast.Ptr("c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88"),
			SmsTwilioContentSid:        cast.Ptr("test-content"),
			SmsTwilioMessageServiceSid: cast.Ptr("test-service"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Contains(t, string(diff), `-enable_signup = true`)
		assert.Contains(t, string(diff), `-enable_confirmations = true`)
		assert.Contains(t, string(diff), `-template = "Your code is {{ .Code }}"`)
		assert.Contains(t, string(diff), `-max_frequency = "1m0s"`)

		assert.Contains(t, string(diff), `+enable_signup = false`)
		assert.Contains(t, string(diff), `+enable_confirmations = false`)
		assert.Contains(t, string(diff), `+template = ""`)
		assert.Contains(t, string(diff), `+max_frequency = "0s"`)

		assert.Contains(t, string(diff), ` [sms.twilio]`)
		assert.Contains(t, string(diff), `-enabled = true`)
		assert.Contains(t, string(diff), `+enabled = false`)

		assert.Contains(t, string(diff), `-[sms.test_otp]`)
		assert.Contains(t, string(diff), `-123 = "456"`)
		assert.Contains(t, string(diff), `-456 = "123"`)
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
				AccessKey:  "test-access-key",
			},
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalPhoneEnabled:       cast.Ptr(false),
			SmsAutoconfirm:             cast.Ptr(false),
			SmsMaxFrequency:            cast.Ptr(0),
			SmsOtpExp:                  cast.Ptr(3600),
			SmsOtpLength:               6,
			SmsProvider:                cast.Ptr("twilio"),
			SmsTemplate:                cast.Ptr(""),
			SmsTwilioAccountSid:        cast.Ptr("test-account"),
			SmsTwilioAuthToken:         cast.Ptr("c84443bc59b92caef8ec8500ff443584793756749523811eb333af2bbc74fc88"),
			SmsTwilioContentSid:        cast.Ptr("test-content"),
			SmsTwilioMessageServiceSid: cast.Ptr("test-service"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Contains(t, string(diff), `-enable_signup = false`)
		assert.Contains(t, string(diff), `-enable_confirmations = false`)
		assert.Contains(t, string(diff), `-template = ""`)
		assert.Contains(t, string(diff), `-max_frequency = "0s"`)

		assert.Contains(t, string(diff), `+enable_signup = true`)
		assert.Contains(t, string(diff), `+enable_confirmations = true`)
		assert.Contains(t, string(diff), `+template = "Your code is {{ .Code }}"`)
		assert.Contains(t, string(diff), `+max_frequency = "1m0s"`)

		assert.Contains(t, string(diff), ` [sms.twilio]`)
		assert.Contains(t, string(diff), `-enabled = true`)
		assert.Contains(t, string(diff), `+enabled = false`)

		assert.Contains(t, string(diff), ` [sms.messagebird]`)
		assert.Contains(t, string(diff), `-enabled = false`)
		assert.Contains(t, string(diff), `-originator = ""`)
		assert.Contains(t, string(diff), `-access_key = "hash:"`)
		assert.Contains(t, string(diff), `+enabled = true`)
		assert.Contains(t, string(diff), `+originator = "test-originator"`)
		assert.Contains(t, string(diff), `+access_key = "hash:ab60d03fc809fb02dae838582f3ddc13d1d6cb32ffba77c4b969dd3caa496f13"`)

		assert.Contains(t, string(diff), `+[sms.test_otp]`)
		assert.Contains(t, string(diff), `+123 = "456"`)
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
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalPhoneEnabled:     cast.Ptr(false),
			SmsAutoconfirm:           cast.Ptr(true),
			SmsMaxFrequency:          cast.Ptr(60),
			SmsOtpExp:                cast.Ptr(3600),
			SmsOtpLength:             6,
			SmsTemplate:              cast.Ptr("Your code is {{ .Code }}"),
			SmsTestOtp:               cast.Ptr("123=456"),
			SmsTestOtpValidUntil:     cast.Ptr("2050-01-01T01:00:00Z"),
			SmsProvider:              cast.Ptr("messagebird"),
			SmsMessagebirdAccessKey:  cast.Ptr("test-messagebird-key"),
			SmsMessagebirdOriginator: cast.Ptr("test-messagebird-originator"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})

	t.Run("enable sign up without provider", func(t *testing.T) {
		// This is not a valid config because platform requires a SMS provider.
		// For consistency, we handle this in config.Load and emit a warning.
		c := newWithDefaults()
		c.Sms = sms{
			EnableSignup: true,
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalPhoneEnabled: cast.Ptr(false),
			SmsProvider:          cast.Ptr("twilio"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Contains(t, string(diff), ` [sms]`)
		assert.Contains(t, string(diff), `-enable_signup = false`)
		assert.Contains(t, string(diff), `+enable_signup = true`)
	})

	t.Run("enable provider without sign up", func(t *testing.T) {
		c := newWithDefaults()
		c.Sms = sms{
			Messagebird: messagebirdConfig{
				Enabled: true,
			},
		}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalPhoneEnabled:    cast.Ptr(false),
			SmsProvider:             cast.Ptr("messagebird"),
			SmsMessagebirdAccessKey: cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
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
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalAppleAdditionalClientIds:  cast.Ptr(""),
			ExternalAppleClientId:             cast.Ptr(""),
			ExternalAppleEnabled:              cast.Ptr(true),
			ExternalAppleSecret:               cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalAzureClientId:             cast.Ptr(""),
			ExternalAzureEnabled:              cast.Ptr(true),
			ExternalAzureSecret:               cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalAzureUrl:                  cast.Ptr(""),
			ExternalBitbucketClientId:         cast.Ptr(""),
			ExternalBitbucketEnabled:          cast.Ptr(true),
			ExternalBitbucketSecret:           cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalDiscordClientId:           cast.Ptr(""),
			ExternalDiscordEnabled:            cast.Ptr(true),
			ExternalDiscordSecret:             cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalFacebookClientId:          cast.Ptr(""),
			ExternalFacebookEnabled:           cast.Ptr(true),
			ExternalFacebookSecret:            cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalFigmaClientId:             cast.Ptr(""),
			ExternalFigmaEnabled:              cast.Ptr(true),
			ExternalFigmaSecret:               cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalGithubClientId:            cast.Ptr(""),
			ExternalGithubEnabled:             cast.Ptr(true),
			ExternalGithubSecret:              cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalGitlabClientId:            cast.Ptr(""),
			ExternalGitlabEnabled:             cast.Ptr(true),
			ExternalGitlabSecret:              cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalGitlabUrl:                 cast.Ptr(""),
			ExternalGoogleAdditionalClientIds: cast.Ptr(""),
			ExternalGoogleClientId:            cast.Ptr(""),
			ExternalGoogleEnabled:             cast.Ptr(true),
			ExternalGoogleSecret:              cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalGoogleSkipNonceCheck:      cast.Ptr(false),
			ExternalKakaoClientId:             cast.Ptr(""),
			ExternalKakaoEnabled:              cast.Ptr(true),
			ExternalKakaoSecret:               cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalKeycloakClientId:          cast.Ptr(""),
			ExternalKeycloakEnabled:           cast.Ptr(true),
			ExternalKeycloakSecret:            cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalKeycloakUrl:               cast.Ptr(""),
			ExternalLinkedinOidcClientId:      cast.Ptr(""),
			ExternalLinkedinOidcEnabled:       cast.Ptr(true),
			ExternalLinkedinOidcSecret:        cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalNotionClientId:            cast.Ptr(""),
			ExternalNotionEnabled:             cast.Ptr(true),
			ExternalNotionSecret:              cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalSlackOidcClientId:         cast.Ptr(""),
			ExternalSlackOidcEnabled:          cast.Ptr(true),
			ExternalSlackOidcSecret:           cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalSpotifyClientId:           cast.Ptr(""),
			ExternalSpotifyEnabled:            cast.Ptr(true),
			ExternalSpotifySecret:             cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalTwitchClientId:            cast.Ptr(""),
			ExternalTwitchEnabled:             cast.Ptr(true),
			ExternalTwitchSecret:              cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalTwitterClientId:           cast.Ptr(""),
			ExternalTwitterEnabled:            cast.Ptr(true),
			ExternalTwitterSecret:             cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalWorkosClientId:            cast.Ptr(""),
			ExternalWorkosEnabled:             cast.Ptr(true),
			ExternalWorkosSecret:              cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalWorkosUrl:                 cast.Ptr(""),
			ExternalZoomClientId:              cast.Ptr(""),
			ExternalZoomEnabled:               cast.Ptr(true),
			ExternalZoomSecret:                cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			// Deprecated fields should be ignored
			ExternalSlackClientId: cast.Ptr(""),
			ExternalSlackEnabled:  cast.Ptr(true),
			ExternalSlackSecret:   cast.Ptr(""),
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
				Secret:   "test-secret",
			},
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
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalAppleAdditionalClientIds:  cast.Ptr("test-client-2"),
			ExternalAppleClientId:             cast.Ptr("test-client-1"),
			ExternalAppleEnabled:              cast.Ptr(false),
			ExternalAppleSecret:               cast.Ptr("ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"),
			ExternalGoogleAdditionalClientIds: cast.Ptr("test-client-2"),
			ExternalGoogleClientId:            cast.Ptr("test-client-1"),
			ExternalGoogleEnabled:             cast.Ptr(true),
			ExternalGoogleSecret:              cast.Ptr("b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"),
			ExternalGoogleSkipNonceCheck:      cast.Ptr(true),
		})
		// Check error
		assert.NoError(t, err)
		assert.Contains(t, string(diff), ` [external.apple]`)
		assert.Contains(t, string(diff), `-enabled = false`)
		assert.Contains(t, string(diff), `+enabled = true`)
		assert.Contains(t, string(diff), ` client_id = "test-client-1,test-client-2"`)
		assert.Contains(t, string(diff), ` secret = "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"`)

		assert.Contains(t, string(diff), ` [external.google]`)
		assert.Contains(t, string(diff), `-enabled = true`)
		assert.Contains(t, string(diff), `+enabled = false`)
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
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalAppleEnabled:         cast.Ptr(false),
			ExternalAzureEnabled:         cast.Ptr(false),
			ExternalBitbucketEnabled:     cast.Ptr(false),
			ExternalDiscordEnabled:       cast.Ptr(false),
			ExternalFacebookEnabled:      cast.Ptr(false),
			ExternalFigmaEnabled:         cast.Ptr(false),
			ExternalGithubEnabled:        cast.Ptr(false),
			ExternalGitlabEnabled:        cast.Ptr(false),
			ExternalGoogleEnabled:        cast.Ptr(false),
			ExternalGoogleSkipNonceCheck: cast.Ptr(false),
			ExternalKakaoEnabled:         cast.Ptr(false),
			ExternalKeycloakEnabled:      cast.Ptr(false),
			ExternalLinkedinOidcEnabled:  cast.Ptr(false),
			ExternalNotionEnabled:        cast.Ptr(false),
			ExternalSlackOidcEnabled:     cast.Ptr(false),
			ExternalSpotifyEnabled:       cast.Ptr(false),
			ExternalTwitchEnabled:        cast.Ptr(false),
			ExternalTwitterEnabled:       cast.Ptr(false),
			ExternalWorkosEnabled:        cast.Ptr(false),
			ExternalZoomEnabled:          cast.Ptr(false),
			// Deprecated fields should be ignored
			ExternalSlackEnabled: cast.Ptr(false),
		})
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, string(diff))
	})
}
