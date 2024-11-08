package config

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

func TestHookDiff(t *testing.T) {
	t.Run("local and remote enabled", func(t *testing.T) {
		c := auth{EnableSignup: true, Hook: hook{
			CustomAccessToken:           hookConfig{Enabled: true},
			SendSMS:                     hookConfig{Enabled: true},
			SendEmail:                   hookConfig{Enabled: true},
			MFAVerificationAttempt:      hookConfig{Enabled: true},
			PasswordVerificationAttempt: hookConfig{Enabled: true},
		}}
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
		c := auth{EnableSignup: true, Hook: hook{
			CustomAccessToken:      hookConfig{Enabled: true},
			MFAVerificationAttempt: hookConfig{Enabled: false},
		}}
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

		assert.Contains(t, string(diff), `[hook.mfa_verification_attempt]`)
		assert.Contains(t, string(diff), `-enabled = true`)
		assert.Contains(t, string(diff), `+enabled = false`)
		assert.Contains(t, string(diff), `uri = ""`)
		assert.Contains(t, string(diff), `secrets = ""`)

		assert.Contains(t, string(diff), `[hook.custom_access_token]`)
		assert.Contains(t, string(diff), `-enabled = false`)
		assert.Contains(t, string(diff), `+enabled = true`)
		assert.Contains(t, string(diff), `uri = ""`)
		assert.Contains(t, string(diff), `secrets = "hash:b613679a0814d9ec772f95d778c35fc5ff1697c493715653c6c712144292c5ad"`)
	})

	t.Run("local and remote disabled", func(t *testing.T) {
		c := auth{EnableSignup: true}
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

func TestSmsDiff(t *testing.T) {
	t.Run("local enabled remote enabled", func(t *testing.T) {
		c := auth{EnableSignup: true, Sms: sms{
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
		}}
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
		c := auth{EnableSignup: true}
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

		assert.Contains(t, string(diff), `[sms.twilio]`)
		assert.Contains(t, string(diff), `-enabled = true`)
		assert.Contains(t, string(diff), `+enabled = false`)

		assert.Contains(t, string(diff), `-[sms.test_otp]`)
		assert.Contains(t, string(diff), `-123 = "456"`)
		assert.Contains(t, string(diff), `-456 = "123"`)
	})

	t.Run("local enabled remote disabled", func(t *testing.T) {
		c := auth{EnableSignup: true, Sms: sms{
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
		}}
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

		assert.Contains(t, string(diff), `[sms.twilio]`)
		assert.Contains(t, string(diff), `-enabled = true`)
		assert.Contains(t, string(diff), `+enabled = false`)

		assert.Contains(t, string(diff), `[sms.messagebird]`)
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
		c := auth{EnableSignup: true, Sms: sms{
			EnableSignup:        false,
			EnableConfirmations: true,
			Template:            "Your code is {{ .Code }}",
			TestOTP:             map[string]string{"123": "456"},
			MaxFrequency:        time.Minute,
		}}
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
		c := auth{EnableSignup: true, Sms: sms{
			EnableSignup: true,
		}}
		// Run test
		diff, err := c.DiffWithRemote("", v1API.AuthConfigResponse{
			ExternalPhoneEnabled: cast.Ptr(false),
			SmsProvider:          cast.Ptr("twilio"),
		})
		// Check error
		assert.NoError(t, err)
		assert.Contains(t, string(diff), `[sms]`)
		assert.Contains(t, string(diff), `-enable_signup = false`)
		assert.Contains(t, string(diff), `+enable_signup = true`)
	})

	t.Run("enable provider without sign up", func(t *testing.T) {
		c := auth{EnableSignup: true, Sms: sms{
			Messagebird: messagebirdConfig{
				Enabled: true,
			},
		}}
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
		c := auth{EnableSignup: true, External: map[string]provider{
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
		}}
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
		c := auth{EnableSignup: true, External: map[string]provider{
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
		}}
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
		assert.Contains(t, string(diff), `[external.apple]`)
		assert.Contains(t, string(diff), `-enabled = false`)
		assert.Contains(t, string(diff), `+enabled = true`)
		assert.Contains(t, string(diff), `client_id = "test-client-1,test-client-2"`)
		assert.Contains(t, string(diff), `secret = "hash:ce62bb9bcced294fd4afe668f8ab3b50a89cf433093c526fffa3d0e46bf55252"`)

		assert.Contains(t, string(diff), `[external.google]`)
		assert.Contains(t, string(diff), `-enabled = true`)
		assert.Contains(t, string(diff), `+enabled = false`)
	})

	t.Run("local and remote disabled", func(t *testing.T) {
		c := auth{EnableSignup: true, External: map[string]provider{
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
		}}
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
