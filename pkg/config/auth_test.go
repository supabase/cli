package config

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
)

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
