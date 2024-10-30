package config

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/go-errors/errors"
	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
	"github.com/supabase/cli/pkg/fetcher"
)

type (
	auth struct {
		Enabled                bool     `toml:"enabled"`
		Image                  string   `toml:"-"`
		SiteUrl                string   `toml:"site_url"`
		AdditionalRedirectUrls []string `toml:"additional_redirect_urls"`

		JwtExpiry                  uint `toml:"jwt_expiry"`
		EnableRefreshTokenRotation bool `toml:"enable_refresh_token_rotation"`
		RefreshTokenReuseInterval  uint `toml:"refresh_token_reuse_interval"`
		EnableManualLinking        bool `toml:"enable_manual_linking"`

		Hook     hook     `toml:"hook"`
		MFA      mfa      `toml:"mfa"`
		Sessions sessions `toml:"sessions"`

		EnableSignup           bool  `toml:"enable_signup"`
		EnableAnonymousSignIns bool  `toml:"enable_anonymous_sign_ins"`
		Email                  email `toml:"email"`
		Sms                    sms   `toml:"sms"`
		External               map[string]provider

		// Custom secrets can be injected from .env file
		JwtSecret      string `toml:"-" mapstructure:"jwt_secret"`
		AnonKey        string `toml:"-" mapstructure:"anon_key"`
		ServiceRoleKey string `toml:"-" mapstructure:"service_role_key"`

		ThirdParty thirdParty `toml:"third_party"`
	}

	provider struct {
		Enabled        bool   `toml:"enabled"`
		ClientId       string `toml:"client_id"`
		Secret         string `toml:"secret"`
		Url            string `toml:"url"`
		RedirectUri    string `toml:"redirect_uri"`
		SkipNonceCheck bool   `toml:"skip_nonce_check"`
	}

	hook struct {
		MFAVerificationAttempt      hookConfig `toml:"mfa_verification_attempt"`
		PasswordVerificationAttempt hookConfig `toml:"password_verification_attempt"`
		CustomAccessToken           hookConfig `toml:"custom_access_token"`
		SendSMS                     hookConfig `toml:"send_sms"`
		SendEmail                   hookConfig `toml:"send_email"`
	}

	hookConfig struct {
		Enabled bool   `toml:"enabled"`
		URI     string `toml:"uri"`
		Secrets string `toml:"secrets"`
	}

	mfa struct {
		TOTP               factorTypeConfiguration      `toml:"totp"`
		Phone              phoneFactorTypeConfiguration `toml:"phone"`
		WebAuthn           factorTypeConfiguration      `toml:"web_authn"`
		MaxEnrolledFactors uint                         `toml:"max_enrolled_factors"`
	}

	factorTypeConfiguration struct {
		EnrollEnabled bool `toml:"enroll_enabled"`
		VerifyEnabled bool `toml:"verify_enabled"`
	}

	phoneFactorTypeConfiguration struct {
		factorTypeConfiguration
		OtpLength    uint          `toml:"otp_length"`
		Template     string        `toml:"template"`
		MaxFrequency time.Duration `toml:"max_frequency"`
	}

	email struct {
		EnableSignup         bool                     `toml:"enable_signup"`
		DoubleConfirmChanges bool                     `toml:"double_confirm_changes"`
		EnableConfirmations  bool                     `toml:"enable_confirmations"`
		SecurePasswordChange bool                     `toml:"secure_password_change"`
		Template             map[string]emailTemplate `toml:"template"`
		Smtp                 smtp                     `toml:"smtp"`
		MaxFrequency         time.Duration            `toml:"max_frequency"`
		OtpLength            uint                     `toml:"otp_length"`
		OtpExpiry            uint                     `toml:"otp_expiry"`
	}

	smtp struct {
		Host       string `toml:"host"`
		Port       uint16 `toml:"port"`
		User       string `toml:"user"`
		Pass       string `toml:"pass"`
		AdminEmail string `toml:"admin_email"`
		SenderName string `toml:"sender_name"`
	}

	emailTemplate struct {
		Subject     string `toml:"subject"`
		ContentPath string `toml:"content_path"`
	}

	sessions struct {
		Timebox           time.Duration `toml:"timebox"`
		InactivityTimeout time.Duration `toml:"inactivity_timeout"`
	}

	sms struct {
		EnableSignup        bool              `toml:"enable_signup"`
		EnableConfirmations bool              `toml:"enable_confirmations"`
		Template            string            `toml:"template"`
		Twilio              twilioConfig      `toml:"twilio" mapstructure:"twilio"`
		TwilioVerify        twilioConfig      `toml:"twilio_verify" mapstructure:"twilio_verify"`
		Messagebird         messagebirdConfig `toml:"messagebird" mapstructure:"messagebird"`
		Textlocal           textlocalConfig   `toml:"textlocal" mapstructure:"textlocal"`
		Vonage              vonageConfig      `toml:"vonage" mapstructure:"vonage"`
		TestOTP             map[string]string `toml:"test_otp"`
		MaxFrequency        time.Duration     `toml:"max_frequency"`
	}

	twilioConfig struct {
		Enabled           bool   `toml:"enabled"`
		AccountSid        string `toml:"account_sid"`
		MessageServiceSid string `toml:"message_service_sid"`
		AuthToken         string `toml:"auth_token" mapstructure:"auth_token"`
	}

	messagebirdConfig struct {
		Enabled    bool   `toml:"enabled"`
		Originator string `toml:"originator"`
		AccessKey  string `toml:"access_key" mapstructure:"access_key"`
	}

	textlocalConfig struct {
		Enabled bool   `toml:"enabled"`
		Sender  string `toml:"sender"`
		ApiKey  string `toml:"api_key" mapstructure:"api_key"`
	}

	vonageConfig struct {
		Enabled   bool   `toml:"enabled"`
		From      string `toml:"from"`
		ApiKey    string `toml:"api_key" mapstructure:"api_key"`
		ApiSecret string `toml:"api_secret" mapstructure:"api_secret"`
	}

	thirdParty struct {
		Firebase tpaFirebase `toml:"firebase"`
		Auth0    tpaAuth0    `toml:"auth0"`
		Cognito  tpaCognito  `toml:"aws_cognito"`
	}

	tpaFirebase struct {
		Enabled bool `toml:"enabled"`

		ProjectID string `toml:"project_id"`
	}

	tpaAuth0 struct {
		Enabled bool `toml:"enabled"`

		Tenant       string `toml:"tenant"`
		TenantRegion string `toml:"tenant_region"`
	}

	tpaCognito struct {
		Enabled bool `toml:"enabled"`

		UserPoolID     string `toml:"user_pool_id"`
		UserPoolRegion string `toml:"user_pool_region"`
	}
)

func (a *auth) Clone() auth {
	copy := *a
	copy.External = maps.Clone(a.External)
	copy.Email.Template = maps.Clone(a.Email.Template)
	copy.Sms.TestOTP = maps.Clone(a.Sms.TestOTP)
	return copy
}

func (a *auth) ToUpdateAuthConfigBody() v1API.UpdateAuthConfigBody {
	body := v1API.UpdateAuthConfigBody{
		DisableSignup:                     cast.Ptr(!a.EnableSignup),
		SiteUrl:                           cast.Ptr(a.SiteUrl),
		JwtExp:                            cast.Ptr(cast.UintToInt(a.JwtExpiry)),
		SmtpAdminEmail:                    cast.Ptr(a.Email.Smtp.AdminEmail),
		SmtpHost:                          cast.Ptr(a.Email.Smtp.Host),
		SmtpPass:                          cast.Ptr(a.Email.Smtp.Pass),
		SmtpPort:                          cast.Ptr(strconv.Itoa(int(a.Email.Smtp.Port))),
		SmtpUser:                          cast.Ptr(a.Email.Smtp.User),
		SmtpSenderName:                    cast.Ptr(a.Email.Smtp.SenderName),
		SmtpMaxFrequency:                  cast.Ptr(int(a.Email.MaxFrequency.Seconds())),
		MailerAutoconfirm:                 cast.Ptr(a.Email.EnableConfirmations),
		MailerSecureEmailChangeEnabled:    cast.Ptr(a.Email.SecurePasswordChange),
		MailerOtpLength:                   cast.Ptr(cast.UintToInt(a.Email.OtpLength)),
		MailerOtpExp:                      cast.Ptr(cast.UintToInt(a.Email.OtpExpiry)),
		SmsAutoconfirm:                    cast.Ptr(a.Sms.EnableConfirmations),
		SmsProvider:                       a.Sms.getProvider(),
		SmsTemplate:                       cast.Ptr(a.Sms.Template),
		SmsMaxFrequency:                   cast.Ptr(int(a.Sms.MaxFrequency.Seconds())),
		ExternalEmailEnabled:              cast.Ptr(a.Email.EnableSignup),
		ExternalPhoneEnabled:              cast.Ptr(a.Sms.EnableSignup),
		ExternalAnonymousUsersEnabled:     cast.Ptr(a.EnableAnonymousSignIns),
		MfaMaxEnrolledFactors:             cast.Ptr(cast.UintToInt((a.MFA.MaxEnrolledFactors))),
		MfaTotpEnrollEnabled:              cast.Ptr(a.MFA.TOTP.EnrollEnabled),
		MfaTotpVerifyEnabled:              cast.Ptr(a.MFA.TOTP.VerifyEnabled),
		MfaPhoneEnrollEnabled:             cast.Ptr(a.MFA.Phone.EnrollEnabled),
		MfaPhoneVerifyEnabled:             cast.Ptr(a.MFA.Phone.VerifyEnabled),
		MfaPhoneOtpLength:                 cast.Ptr(cast.UintToInt(a.MFA.Phone.OtpLength)),
		MfaPhoneTemplate:                  cast.Ptr(a.MFA.Phone.Template),
		MfaPhoneMaxFrequency:              cast.Ptr(int(a.MFA.Phone.MaxFrequency.Seconds())),
		MfaWebAuthnEnrollEnabled:          cast.Ptr(a.MFA.WebAuthn.EnrollEnabled),
		MfaWebAuthnVerifyEnabled:          cast.Ptr(a.MFA.WebAuthn.VerifyEnabled),
		RefreshTokenRotationEnabled:       cast.Ptr(a.EnableRefreshTokenRotation),
		SecurityRefreshTokenReuseInterval: cast.Ptr(cast.UintToInt(a.RefreshTokenReuseInterval)),
		SecurityManualLinkingEnabled:      cast.Ptr(a.EnableManualLinking),
		SessionsTimebox:                   cast.Ptr(int(a.Sessions.Timebox.Seconds())),
		SessionsInactivityTimeout:         cast.Ptr(int(a.Sessions.InactivityTimeout.Seconds())),
	}

	// Handle external providers
	a.mapExternalProviders(&body)

	// Handle email templates
	a.mapEmailTemplates(&body)

	// Handle hooks
	a.mapHooks(&body)

	// Handle SMS providers
	a.mapSmsProviders(&body)

	return body
}

func (a *auth) mapExternalProviders(body *v1API.UpdateAuthConfigBody) {
	for providerName, config := range a.External {
		switch providerName {
		// Ignore deprecated fields: "linkedin", "slack"
		case "apple":
			body.ExternalAppleEnabled = cast.Ptr(config.Enabled)
			body.ExternalAppleClientId = cast.Ptr(config.ClientId)
			body.ExternalAppleSecret = cast.Ptr(config.Secret)
		case "azure":
			body.ExternalAzureEnabled = cast.Ptr(config.Enabled)
			body.ExternalAzureClientId = cast.Ptr(config.ClientId)
			body.ExternalAzureSecret = cast.Ptr(config.Secret)
			body.ExternalAzureUrl = cast.Ptr(config.Url)
		case "bitbucket":
			body.ExternalBitbucketEnabled = cast.Ptr(config.Enabled)
			body.ExternalBitbucketClientId = cast.Ptr(config.ClientId)
			body.ExternalBitbucketSecret = cast.Ptr(config.Secret)
		case "discord":
			body.ExternalDiscordEnabled = cast.Ptr(config.Enabled)
			body.ExternalDiscordClientId = cast.Ptr(config.ClientId)
			body.ExternalDiscordSecret = cast.Ptr(config.Secret)
		case "facebook":
			body.ExternalFacebookEnabled = cast.Ptr(config.Enabled)
			body.ExternalFacebookClientId = cast.Ptr(config.ClientId)
			body.ExternalFacebookSecret = cast.Ptr(config.Secret)
		case "github":
			body.ExternalGithubEnabled = cast.Ptr(config.Enabled)
			body.ExternalGithubClientId = cast.Ptr(config.ClientId)
			body.ExternalGithubSecret = cast.Ptr(config.Secret)
		case "gitlab":
			body.ExternalGitlabEnabled = cast.Ptr(config.Enabled)
			body.ExternalGitlabClientId = cast.Ptr(config.ClientId)
			body.ExternalGitlabSecret = cast.Ptr(config.Secret)
			body.ExternalGitlabUrl = cast.Ptr(config.Url)
		case "google":
			body.ExternalGoogleEnabled = cast.Ptr(config.Enabled)
			body.ExternalGoogleClientId = cast.Ptr(config.ClientId)
			body.ExternalGoogleSecret = cast.Ptr(config.Secret)
			body.ExternalGoogleSkipNonceCheck = cast.Ptr(config.SkipNonceCheck)
		case "keycloak":
			body.ExternalKeycloakEnabled = cast.Ptr(config.Enabled)
			body.ExternalKeycloakClientId = cast.Ptr(config.ClientId)
			body.ExternalKeycloakSecret = cast.Ptr(config.Secret)
			body.ExternalKeycloakUrl = cast.Ptr(config.Url)
		case "linkedin_oidc":
			body.ExternalLinkedinOidcEnabled = cast.Ptr(config.Enabled)
			body.ExternalLinkedinOidcClientId = cast.Ptr(config.ClientId)
			body.ExternalLinkedinOidcSecret = cast.Ptr(config.Secret)
		case "notion":
			body.ExternalNotionEnabled = cast.Ptr(config.Enabled)
			body.ExternalNotionClientId = cast.Ptr(config.ClientId)
			body.ExternalNotionSecret = cast.Ptr(config.Secret)
		case "slack_oidc":
			body.ExternalSlackOidcEnabled = cast.Ptr(config.Enabled)
			body.ExternalSlackOidcClientId = cast.Ptr(config.ClientId)
			body.ExternalSlackOidcSecret = cast.Ptr(config.Secret)
		case "spotify":
			body.ExternalSpotifyEnabled = cast.Ptr(config.Enabled)
			body.ExternalSpotifyClientId = cast.Ptr(config.ClientId)
			body.ExternalSpotifySecret = cast.Ptr(config.Secret)
		case "twitch":
			body.ExternalTwitchEnabled = cast.Ptr(config.Enabled)
			body.ExternalTwitchClientId = cast.Ptr(config.ClientId)
			body.ExternalTwitchSecret = cast.Ptr(config.Secret)
		case "twitter":
			body.ExternalTwitterEnabled = cast.Ptr(config.Enabled)
			body.ExternalTwitterClientId = cast.Ptr(config.ClientId)
			body.ExternalTwitterSecret = cast.Ptr(config.Secret)
		case "workos":
			body.ExternalWorkosEnabled = cast.Ptr(config.Enabled)
			body.ExternalWorkosClientId = cast.Ptr(config.ClientId)
			body.ExternalWorkosSecret = cast.Ptr(config.Secret)
			body.ExternalWorkosUrl = cast.Ptr(config.Url)
		case "zoom":
			body.ExternalZoomEnabled = cast.Ptr(config.Enabled)
			body.ExternalZoomClientId = cast.Ptr(config.ClientId)
			body.ExternalZoomSecret = cast.Ptr(config.Secret)
		}
	}
}

func (a *auth) mapEmailTemplates(body *v1API.UpdateAuthConfigBody) {
	// TODO: load file content and ignore empty string
	for name, template := range a.Email.Template {
		switch name {
		case "invite":
			body.MailerSubjectsInvite = cast.Ptr(template.Subject)
			body.MailerTemplatesInviteContent = cast.Ptr(template.ContentPath)
		case "confirmation":
			body.MailerSubjectsConfirmation = cast.Ptr(template.Subject)
			body.MailerTemplatesConfirmationContent = cast.Ptr(template.ContentPath)
		case "recovery":
			body.MailerSubjectsRecovery = cast.Ptr(template.Subject)
			body.MailerTemplatesRecoveryContent = cast.Ptr(template.ContentPath)
		case "magic_link":
			body.MailerSubjectsMagicLink = cast.Ptr(template.Subject)
			body.MailerTemplatesMagicLinkContent = cast.Ptr(template.ContentPath)
		case "email_change":
			body.MailerSubjectsEmailChange = cast.Ptr(template.Subject)
			body.MailerTemplatesEmailChangeContent = cast.Ptr(template.ContentPath)
		}
	}
}

func (a *auth) mapHooks(body *v1API.UpdateAuthConfigBody) {
	body.HookCustomAccessTokenEnabled = cast.Ptr(a.Hook.CustomAccessToken.Enabled)
	body.HookCustomAccessTokenUri = cast.Ptr(a.Hook.CustomAccessToken.URI)
	body.HookCustomAccessTokenSecrets = cast.Ptr(a.Hook.CustomAccessToken.Secrets)

	body.HookMfaVerificationAttemptEnabled = cast.Ptr(a.Hook.MFAVerificationAttempt.Enabled)
	body.HookMfaVerificationAttemptUri = cast.Ptr(a.Hook.MFAVerificationAttempt.URI)
	body.HookMfaVerificationAttemptSecrets = cast.Ptr(a.Hook.MFAVerificationAttempt.Secrets)

	body.HookPasswordVerificationAttemptEnabled = cast.Ptr(a.Hook.PasswordVerificationAttempt.Enabled)
	body.HookPasswordVerificationAttemptUri = cast.Ptr(a.Hook.PasswordVerificationAttempt.URI)
	body.HookPasswordVerificationAttemptSecrets = cast.Ptr(a.Hook.PasswordVerificationAttempt.Secrets)

	body.HookSendEmailEnabled = cast.Ptr(a.Hook.SendEmail.Enabled)
	body.HookSendEmailUri = cast.Ptr(a.Hook.SendEmail.URI)
	body.HookSendEmailSecrets = cast.Ptr(a.Hook.SendEmail.Secrets)

	body.HookSendSmsEnabled = cast.Ptr(a.Hook.SendSMS.Enabled)
	body.HookSendSmsUri = cast.Ptr(a.Hook.SendSMS.URI)
	body.HookSendSmsSecrets = cast.Ptr(a.Hook.SendSMS.Secrets)
}

func (a *auth) mapSmsProviders(body *v1API.UpdateAuthConfigBody) {
	if a.Sms.Twilio.Enabled {
		body.SmsTwilioAccountSid = cast.Ptr(a.Sms.Twilio.AccountSid)
		body.SmsTwilioAuthToken = cast.Ptr(a.Sms.Twilio.AuthToken)
		body.SmsTwilioMessageServiceSid = cast.Ptr(a.Sms.Twilio.MessageServiceSid)
	}

	if a.Sms.TwilioVerify.Enabled {
		body.SmsTwilioVerifyAccountSid = cast.Ptr(a.Sms.TwilioVerify.AccountSid)
		body.SmsTwilioVerifyAuthToken = cast.Ptr(a.Sms.TwilioVerify.AuthToken)
		body.SmsTwilioVerifyMessageServiceSid = cast.Ptr(a.Sms.TwilioVerify.MessageServiceSid)
	}

	if a.Sms.Messagebird.Enabled {
		body.SmsMessagebirdAccessKey = cast.Ptr(a.Sms.Messagebird.AccessKey)
		body.SmsMessagebirdOriginator = cast.Ptr(a.Sms.Messagebird.Originator)
	}

	if a.Sms.Textlocal.Enabled {
		body.SmsTextlocalApiKey = cast.Ptr(a.Sms.Textlocal.ApiKey)
		body.SmsTextlocalSender = cast.Ptr(a.Sms.Textlocal.Sender)
	}

	if a.Sms.Vonage.Enabled {
		body.SmsVonageApiKey = cast.Ptr(a.Sms.Vonage.ApiKey)
		body.SmsVonageApiSecret = cast.Ptr(a.Sms.Vonage.ApiSecret)
		body.SmsVonageFrom = cast.Ptr(a.Sms.Vonage.From)
	}
}

// Helper function to determine SMS provider
func (s sms) getProvider() *string {
	var provider string
	switch {
	case s.Twilio.Enabled:
		provider = "twilio"
	case s.TwilioVerify.Enabled:
		provider = "twilio_verify"
	case s.Messagebird.Enabled:
		provider = "messagebird"
	case s.Textlocal.Enabled:
		provider = "textlocal"
	case s.Vonage.Enabled:
		provider = "vonage"
	default:
		return nil
	}
	return &provider
}

func (a *auth) fromRemoteAuthConfig(remoteConfig v1API.AuthConfigResponse) auth {
	result := a.Clone()

	if remoteConfig.DisableSignup != nil {
		result.EnableSignup = !*remoteConfig.DisableSignup
	}
	if remoteConfig.SiteUrl != nil {
		result.SiteUrl = *remoteConfig.SiteUrl
	}
	if remoteConfig.JwtExp != nil {
		result.JwtExpiry = cast.IntToUint(*remoteConfig.JwtExp)
	}
	if remoteConfig.MailerAutoconfirm != nil {
		result.Email.EnableConfirmations = *remoteConfig.MailerAutoconfirm
	}
	if remoteConfig.MailerSecureEmailChangeEnabled != nil {
		result.Email.SecurePasswordChange = *remoteConfig.MailerSecureEmailChangeEnabled
	}
	if remoteConfig.SmsAutoconfirm != nil {
		result.Sms.EnableConfirmations = *remoteConfig.SmsAutoconfirm
	}
	if remoteConfig.SmsTemplate != nil {
		result.Sms.Template = *remoteConfig.SmsTemplate
	}
	if remoteConfig.SmsMaxFrequency != nil {
		result.Sms.MaxFrequency = time.Duration(*remoteConfig.SmsMaxFrequency) * time.Second
	}
	if remoteConfig.ExternalEmailEnabled != nil {
		result.Email.EnableSignup = *remoteConfig.ExternalEmailEnabled
	}
	if remoteConfig.ExternalPhoneEnabled != nil {
		result.Sms.EnableSignup = *remoteConfig.ExternalPhoneEnabled
	}
	if remoteConfig.ExternalAnonymousUsersEnabled != nil {
		result.EnableAnonymousSignIns = *remoteConfig.ExternalAnonymousUsersEnabled
	}
	if remoteConfig.SmtpMaxFrequency != nil {
		result.Email.MaxFrequency = time.Duration(*remoteConfig.SmtpMaxFrequency) * time.Second
	}
	if remoteConfig.MailerOtpLength != nil {
		result.Email.OtpLength = cast.IntToUint(*remoteConfig.MailerOtpLength)
	}
	result.Email.OtpExpiry = cast.IntToUint(remoteConfig.MailerOtpExp)
	if remoteConfig.MfaMaxEnrolledFactors != nil {
		result.MFA.MaxEnrolledFactors = cast.IntToUint(*remoteConfig.MfaMaxEnrolledFactors)
	}
	if remoteConfig.MfaTotpEnrollEnabled != nil {
		result.MFA.TOTP.EnrollEnabled = *remoteConfig.MfaTotpEnrollEnabled
	}
	if remoteConfig.MfaTotpVerifyEnabled != nil {
		result.MFA.TOTP.VerifyEnabled = *remoteConfig.MfaTotpVerifyEnabled
	}
	if remoteConfig.MfaPhoneEnrollEnabled != nil {
		result.MFA.Phone.EnrollEnabled = *remoteConfig.MfaPhoneEnrollEnabled
	}
	if remoteConfig.MfaPhoneVerifyEnabled != nil {
		result.MFA.Phone.VerifyEnabled = *remoteConfig.MfaPhoneVerifyEnabled
	}
	if remoteConfig.MfaPhoneTemplate != nil {
		result.MFA.Phone.Template = *remoteConfig.MfaPhoneTemplate
	}
	if remoteConfig.MfaPhoneMaxFrequency != nil {
		result.MFA.Phone.MaxFrequency = time.Duration(*remoteConfig.MfaPhoneMaxFrequency) * time.Second
	}
	result.MFA.Phone.OtpLength = cast.IntToUint(remoteConfig.MfaPhoneOtpLength)
	// Sensitives fields
	if remoteConfig.SmtpAdminEmail != nil {
		result.Email.Smtp.AdminEmail = *remoteConfig.SmtpAdminEmail
	}
	if remoteConfig.SmtpHost != nil {
		result.Email.Smtp.Host = *remoteConfig.SmtpHost
	}
	if remoteConfig.SmtpPass != nil {
		result.Email.Smtp.Pass = *remoteConfig.SmtpPass
	}
	if remoteConfig.SmtpPort != nil {
		if port, err := strconv.ParseUint(*remoteConfig.SmtpPort, 10, 16); err == nil {
			result.Email.Smtp.Port = uint16(port)
		}
	}
	if remoteConfig.SmtpUser != nil {
		result.Email.Smtp.User = *remoteConfig.SmtpUser
	}
	if remoteConfig.SmtpSenderName != nil {
		result.Email.Smtp.SenderName = *remoteConfig.SmtpSenderName
	}
	// Handle external providers
	result.mapRemoteExternalProviders(remoteConfig)
	// Handle email templates
	result.mapRemoteEmailTemplates(remoteConfig)
	// Handle hooks
	result.mapRemoteHooks(remoteConfig)
	// Handle SMS providers
	result.mapRemoteSmsProviders(remoteConfig)

	return result
}

func (a *auth) mapRemoteEmailTemplates(remoteConfig v1API.AuthConfigResponse) {
	for name, template := range a.Email.Template {
		switch name {
		case "invite":
			if remoteConfig.MailerSubjectsInvite != nil {
				template.Subject = *remoteConfig.MailerSubjectsInvite
			}
			if remoteConfig.MailerTemplatesInviteContent != nil {
				template.ContentPath = *remoteConfig.MailerTemplatesInviteContent
			}
		case "confirmation":
			if remoteConfig.MailerSubjectsConfirmation != nil {
				template.Subject = *remoteConfig.MailerSubjectsConfirmation
			}
			if remoteConfig.MailerTemplatesConfirmationContent != nil {
				template.ContentPath = *remoteConfig.MailerTemplatesConfirmationContent
			}
		case "recovery":
			if remoteConfig.MailerSubjectsRecovery != nil {
				template.Subject = *remoteConfig.MailerSubjectsRecovery
			}
			if remoteConfig.MailerTemplatesRecoveryContent != nil {
				template.ContentPath = *remoteConfig.MailerTemplatesRecoveryContent
			}
		case "magic_link":
			if remoteConfig.MailerSubjectsMagicLink != nil {
				template.Subject = *remoteConfig.MailerSubjectsMagicLink
			}
			if remoteConfig.MailerTemplatesMagicLinkContent != nil {
				template.ContentPath = *remoteConfig.MailerTemplatesMagicLinkContent
			}
		case "email_change":
			if remoteConfig.MailerSubjectsEmailChange != nil {
				template.Subject = *remoteConfig.MailerSubjectsEmailChange
			}
			if remoteConfig.MailerTemplatesEmailChangeContent != nil {
				template.ContentPath = *remoteConfig.MailerTemplatesEmailChangeContent
			}
		}
		a.Email.Template[name] = template
	}
}

func (a *auth) mapRemoteExternalProviders(remoteConfig v1API.AuthConfigResponse) {
	for providerName, config := range a.External {
		switch providerName {
		case "apple":
			if remoteConfig.ExternalAppleEnabled != nil {
				config.Enabled = *remoteConfig.ExternalAppleEnabled
			}
			if remoteConfig.ExternalAppleClientId != nil {
				config.ClientId = *remoteConfig.ExternalAppleClientId
			}
			if remoteConfig.ExternalAppleSecret != nil {
				config.Secret = *remoteConfig.ExternalAppleSecret
			}
		case "azure":
			if remoteConfig.ExternalAzureEnabled != nil {
				config.Enabled = *remoteConfig.ExternalAzureEnabled
			}
			if remoteConfig.ExternalAzureClientId != nil {
				config.ClientId = *remoteConfig.ExternalAzureClientId
			}
			if remoteConfig.ExternalAzureSecret != nil {
				config.Secret = *remoteConfig.ExternalAzureSecret
			}
			if remoteConfig.ExternalAzureUrl != nil {
				config.Url = *remoteConfig.ExternalAzureUrl
			}
		case "bitbucket":
			if remoteConfig.ExternalBitbucketEnabled != nil {
				config.Enabled = *remoteConfig.ExternalBitbucketEnabled
			}
			if remoteConfig.ExternalBitbucketClientId != nil {
				config.ClientId = *remoteConfig.ExternalBitbucketClientId
			}
			if remoteConfig.ExternalBitbucketSecret != nil {
				config.Secret = *remoteConfig.ExternalBitbucketSecret
			}
		case "discord":
			if remoteConfig.ExternalDiscordEnabled != nil {
				config.Enabled = *remoteConfig.ExternalDiscordEnabled
			}
			if remoteConfig.ExternalDiscordClientId != nil {
				config.ClientId = *remoteConfig.ExternalDiscordClientId
			}
			if remoteConfig.ExternalDiscordSecret != nil {
				config.Secret = *remoteConfig.ExternalDiscordSecret
			}
		case "facebook":
			if remoteConfig.ExternalFacebookEnabled != nil {
				config.Enabled = *remoteConfig.ExternalFacebookEnabled
			}
			if remoteConfig.ExternalFacebookClientId != nil {
				config.ClientId = *remoteConfig.ExternalFacebookClientId
			}
			if remoteConfig.ExternalFacebookSecret != nil {
				config.Secret = *remoteConfig.ExternalFacebookSecret
			}
		case "github":
			if remoteConfig.ExternalGithubEnabled != nil {
				config.Enabled = *remoteConfig.ExternalGithubEnabled
			}
			if remoteConfig.ExternalGithubClientId != nil {
				config.ClientId = *remoteConfig.ExternalGithubClientId
			}
			if remoteConfig.ExternalGithubSecret != nil {
				config.Secret = *remoteConfig.ExternalGithubSecret
			}
		case "gitlab":
			if remoteConfig.ExternalGitlabEnabled != nil {
				config.Enabled = *remoteConfig.ExternalGitlabEnabled
			}
			if remoteConfig.ExternalGitlabClientId != nil {
				config.ClientId = *remoteConfig.ExternalGitlabClientId
			}
			if remoteConfig.ExternalGitlabSecret != nil {
				config.Secret = *remoteConfig.ExternalGitlabSecret
			}
			if remoteConfig.ExternalGitlabUrl != nil {
				config.Url = *remoteConfig.ExternalGitlabUrl
			}
		case "google":
			if remoteConfig.ExternalGoogleEnabled != nil {
				config.Enabled = *remoteConfig.ExternalGoogleEnabled
			}
			if remoteConfig.ExternalGoogleClientId != nil {
				config.ClientId = *remoteConfig.ExternalGoogleClientId
			}
			if remoteConfig.ExternalGoogleSecret != nil {
				config.Secret = *remoteConfig.ExternalGoogleSecret
			}
			if remoteConfig.ExternalGoogleSkipNonceCheck != nil {
				config.SkipNonceCheck = *remoteConfig.ExternalGoogleSkipNonceCheck
			}
		case "keycloak":
			if remoteConfig.ExternalKeycloakEnabled != nil {
				config.Enabled = *remoteConfig.ExternalKeycloakEnabled
			}
			if remoteConfig.ExternalKeycloakClientId != nil {
				config.ClientId = *remoteConfig.ExternalKeycloakClientId
			}
			if remoteConfig.ExternalKeycloakSecret != nil {
				config.Secret = *remoteConfig.ExternalKeycloakSecret
			}
			if remoteConfig.ExternalKeycloakUrl != nil {
				config.Url = *remoteConfig.ExternalKeycloakUrl
			}
		case "linkedin_oidc", "linkedin":
			if remoteConfig.ExternalLinkedinOidcEnabled != nil {
				config.Enabled = *remoteConfig.ExternalLinkedinOidcEnabled
			}
			if remoteConfig.ExternalLinkedinOidcClientId != nil {
				config.ClientId = *remoteConfig.ExternalLinkedinOidcClientId
			}
			if remoteConfig.ExternalLinkedinOidcSecret != nil {
				config.Secret = *remoteConfig.ExternalLinkedinOidcSecret
			}
		case "notion":
			if remoteConfig.ExternalNotionEnabled != nil {
				config.Enabled = *remoteConfig.ExternalNotionEnabled
			}
			if remoteConfig.ExternalNotionClientId != nil {
				config.ClientId = *remoteConfig.ExternalNotionClientId
			}
			if remoteConfig.ExternalNotionSecret != nil {
				config.Secret = *remoteConfig.ExternalNotionSecret
			}
		case "slack_oidc", "slack":
			if remoteConfig.ExternalSlackOidcEnabled != nil {
				config.Enabled = *remoteConfig.ExternalSlackOidcEnabled
			}
			if remoteConfig.ExternalSlackOidcClientId != nil {
				config.ClientId = *remoteConfig.ExternalSlackOidcClientId
			}
			if remoteConfig.ExternalSlackOidcSecret != nil {
				config.Secret = *remoteConfig.ExternalSlackOidcSecret
			}
		case "spotify":
			if remoteConfig.ExternalSpotifyEnabled != nil {
				config.Enabled = *remoteConfig.ExternalSpotifyEnabled
			}
			if remoteConfig.ExternalSpotifyClientId != nil {
				config.ClientId = *remoteConfig.ExternalSpotifyClientId
			}
			if remoteConfig.ExternalSpotifySecret != nil {
				config.Secret = *remoteConfig.ExternalSpotifySecret
			}
		case "twitch":
			if remoteConfig.ExternalTwitchEnabled != nil {
				config.Enabled = *remoteConfig.ExternalTwitchEnabled
			}
			if remoteConfig.ExternalTwitchClientId != nil {
				config.ClientId = *remoteConfig.ExternalTwitchClientId
			}
			if remoteConfig.ExternalTwitchSecret != nil {
				config.Secret = *remoteConfig.ExternalTwitchSecret
			}
		case "twitter":
			if remoteConfig.ExternalTwitterEnabled != nil {
				config.Enabled = *remoteConfig.ExternalTwitterEnabled
			}
			if remoteConfig.ExternalTwitterClientId != nil {
				config.ClientId = *remoteConfig.ExternalTwitterClientId
			}
			if remoteConfig.ExternalTwitterSecret != nil {
				config.Secret = *remoteConfig.ExternalTwitterSecret
			}
		case "workos":
			if remoteConfig.ExternalWorkosEnabled != nil {
				config.Enabled = *remoteConfig.ExternalWorkosEnabled
			}
			if remoteConfig.ExternalWorkosClientId != nil {
				config.ClientId = *remoteConfig.ExternalWorkosClientId
			}
			if remoteConfig.ExternalWorkosSecret != nil {
				config.Secret = *remoteConfig.ExternalWorkosSecret
			}
			if remoteConfig.ExternalWorkosUrl != nil {
				config.Url = *remoteConfig.ExternalWorkosUrl
			}
		case "zoom":
			if remoteConfig.ExternalZoomEnabled != nil {
				config.Enabled = *remoteConfig.ExternalZoomEnabled
			}
			if remoteConfig.ExternalZoomClientId != nil {
				config.ClientId = *remoteConfig.ExternalZoomClientId
			}
			if remoteConfig.ExternalZoomSecret != nil {
				config.Secret = *remoteConfig.ExternalZoomSecret
			}
		}
		a.External[providerName] = config
	}
}

func (a *auth) mapRemoteHooks(remoteConfig v1API.AuthConfigResponse) {
	// Custom Access Token
	if remoteConfig.HookCustomAccessTokenEnabled != nil {
		a.Hook.CustomAccessToken.Enabled = *remoteConfig.HookCustomAccessTokenEnabled
	}
	if remoteConfig.HookCustomAccessTokenUri != nil {
		a.Hook.CustomAccessToken.URI = *remoteConfig.HookCustomAccessTokenUri
	}
	if remoteConfig.HookCustomAccessTokenSecrets != nil {
		a.Hook.CustomAccessToken.Secrets = *remoteConfig.HookCustomAccessTokenSecrets
	}

	// MFA Verification Attempt
	if remoteConfig.HookMfaVerificationAttemptEnabled != nil {
		a.Hook.MFAVerificationAttempt.Enabled = *remoteConfig.HookMfaVerificationAttemptEnabled
	}
	if remoteConfig.HookMfaVerificationAttemptUri != nil {
		a.Hook.MFAVerificationAttempt.URI = *remoteConfig.HookMfaVerificationAttemptUri
	}
	if remoteConfig.HookMfaVerificationAttemptSecrets != nil {
		a.Hook.MFAVerificationAttempt.Secrets = *remoteConfig.HookMfaVerificationAttemptSecrets
	}

	// Password Verification Attempt
	if remoteConfig.HookPasswordVerificationAttemptEnabled != nil {
		a.Hook.PasswordVerificationAttempt.Enabled = *remoteConfig.HookPasswordVerificationAttemptEnabled
	}
	if remoteConfig.HookPasswordVerificationAttemptUri != nil {
		a.Hook.PasswordVerificationAttempt.URI = *remoteConfig.HookPasswordVerificationAttemptUri
	}
	if remoteConfig.HookPasswordVerificationAttemptSecrets != nil {
		a.Hook.PasswordVerificationAttempt.Secrets = *remoteConfig.HookPasswordVerificationAttemptSecrets
	}

	// Send Email
	if remoteConfig.HookSendEmailEnabled != nil {
		a.Hook.SendEmail.Enabled = *remoteConfig.HookSendEmailEnabled
	}
	if remoteConfig.HookSendEmailUri != nil {
		a.Hook.SendEmail.URI = *remoteConfig.HookSendEmailUri
	}
	if remoteConfig.HookSendEmailSecrets != nil {
		a.Hook.SendEmail.Secrets = *remoteConfig.HookSendEmailSecrets
	}

	// Send SMS
	if remoteConfig.HookSendSmsEnabled != nil {
		a.Hook.SendSMS.Enabled = *remoteConfig.HookSendSmsEnabled
	}
	if remoteConfig.HookSendSmsUri != nil {
		a.Hook.SendSMS.URI = *remoteConfig.HookSendSmsUri
	}
	if remoteConfig.HookSendSmsSecrets != nil {
		a.Hook.SendSMS.Secrets = *remoteConfig.HookSendSmsSecrets
	}
}

func (a *auth) mapRemoteSmsProviders(remoteConfig v1API.AuthConfigResponse) {
	// Twilio
	if remoteConfig.SmsTwilioAccountSid != nil && remoteConfig.SmsTwilioAuthToken != nil {
		a.Sms.Twilio.Enabled = true
		a.Sms.Twilio.AccountSid = *remoteConfig.SmsTwilioAccountSid
		a.Sms.Twilio.AuthToken = *remoteConfig.SmsTwilioAuthToken
		if remoteConfig.SmsTwilioMessageServiceSid != nil {
			a.Sms.Twilio.MessageServiceSid = *remoteConfig.SmsTwilioMessageServiceSid
		}
	}

	// Twilio Verify
	if remoteConfig.SmsTwilioVerifyAccountSid != nil && remoteConfig.SmsTwilioVerifyAuthToken != nil {
		a.Sms.TwilioVerify.Enabled = true
		a.Sms.TwilioVerify.AccountSid = *remoteConfig.SmsTwilioVerifyAccountSid
		a.Sms.TwilioVerify.AuthToken = *remoteConfig.SmsTwilioVerifyAuthToken
		if remoteConfig.SmsTwilioVerifyMessageServiceSid != nil {
			a.Sms.TwilioVerify.MessageServiceSid = *remoteConfig.SmsTwilioVerifyMessageServiceSid
		}
	}

	// Messagebird
	if remoteConfig.SmsMessagebirdAccessKey != nil {
		a.Sms.Messagebird.Enabled = true
		a.Sms.Messagebird.AccessKey = *remoteConfig.SmsMessagebirdAccessKey
		if remoteConfig.SmsMessagebirdOriginator != nil {
			a.Sms.Messagebird.Originator = *remoteConfig.SmsMessagebirdOriginator
		}
	}

	// Textlocal
	if remoteConfig.SmsTextlocalApiKey != nil {
		a.Sms.Textlocal.Enabled = true
		a.Sms.Textlocal.ApiKey = *remoteConfig.SmsTextlocalApiKey
		if remoteConfig.SmsTextlocalSender != nil {
			a.Sms.Textlocal.Sender = *remoteConfig.SmsTextlocalSender
		}
	}

	// Vonage
	if remoteConfig.SmsVonageApiKey != nil && remoteConfig.SmsVonageApiSecret != nil {
		a.Sms.Vonage.Enabled = true
		a.Sms.Vonage.ApiKey = *remoteConfig.SmsVonageApiKey
		a.Sms.Vonage.ApiSecret = *remoteConfig.SmsVonageApiSecret
		if remoteConfig.SmsVonageFrom != nil {
			a.Sms.Vonage.From = *remoteConfig.SmsVonageFrom
		}
	}
}

func (a *auth) compareAndHideSensitiveFields(remote *auth) {
	// This function compares the original auth struct with a remote auth struct
	// and hides sensitive fields in both structs for secure comparison
	// SMTP sensitive fields
	diff.CompareSensitiveField(&a.Email.Smtp.Pass, &remote.Email.Smtp.Pass)

	// Sms sensitives fields
	diff.CompareSensitiveField(&a.Sms.Twilio.AuthToken, &remote.Sms.Twilio.AuthToken)
	diff.CompareSensitiveField(&a.Sms.TwilioVerify.AuthToken, &remote.Sms.TwilioVerify.AuthToken)
	diff.CompareSensitiveField(&a.Sms.Messagebird.AccessKey, &remote.Sms.Messagebird.AccessKey)
	diff.CompareSensitiveField(&a.Sms.Textlocal.ApiKey, &remote.Sms.Textlocal.ApiKey)
	diff.CompareSensitiveField(&a.Sms.Vonage.ApiKey, &remote.Sms.Vonage.ApiKey)
	diff.CompareSensitiveField(&a.Sms.Vonage.ApiSecret, &remote.Sms.Vonage.ApiSecret)

	// Compare external providers hide secrets and id
	for provider, aConfig := range a.External {
		if remoteConfig, exists := remote.External[provider]; exists {
			diff.CompareSensitiveField(&aConfig.Secret, &remoteConfig.Secret)
			remote.External[provider] = remoteConfig
			a.External[provider] = aConfig
		}
	}

	// Api sensitive fields
	diff.CompareSensitiveField(&a.JwtSecret, &remote.JwtSecret)
	diff.CompareSensitiveField(&a.AnonKey, &remote.AnonKey)
	diff.CompareSensitiveField(&a.ServiceRoleKey, &remote.ServiceRoleKey)

	// Hook secrets
	diff.CompareSensitiveField(&a.Hook.MFAVerificationAttempt.Secrets, &remote.Hook.MFAVerificationAttempt.Secrets)
	diff.CompareSensitiveField(&a.Hook.PasswordVerificationAttempt.Secrets, &remote.Hook.PasswordVerificationAttempt.Secrets)
	diff.CompareSensitiveField(&a.Hook.CustomAccessToken.Secrets, &remote.Hook.CustomAccessToken.Secrets)
	diff.CompareSensitiveField(&a.Hook.SendSMS.Secrets, &remote.Hook.SendSMS.Secrets)
	diff.CompareSensitiveField(&a.Hook.SendEmail.Secrets, &remote.Hook.SendEmail.Secrets)
}

func (a *auth) DiffWithRemote(remoteConfig v1API.AuthConfigResponse) ([]byte, error) {
	// First we clone our local auth for a new instance
	localCopy := a.Clone()
	// We make a new auth instance from our remote config
	remoteCopy := localCopy.fromRemoteAuthConfig(remoteConfig)
	// We compare and hide sensitive fields for auth config, leaving only a marker to know if there was changes or not
	localCopy.compareAndHideSensitiveFields(&remoteCopy)
	currentValue, err := ToTomlBytes(&localCopy)

	if err != nil {
		return nil, err
	}
	remoteCompare, err := ToTomlBytes(&remoteCopy)
	if err != nil {
		return nil, err
	}
	// We diff our resulting config
	return diff.Diff("remote[auth]", remoteCompare, "local[auth]", currentValue), nil
}

func (f *tpaFirebase) issuerURL() string {
	return fmt.Sprintf("https://securetoken.google.com/%s", f.ProjectID)
}

func (f *tpaFirebase) validate() error {
	if f.ProjectID == "" {
		return errors.New("Invalid config: auth.third_party.firebase is enabled but without a project_id.")
	}

	return nil
}

func (a *tpaAuth0) issuerURL() string {
	if a.TenantRegion != "" {
		return fmt.Sprintf("https://%s.%s.auth0.com", a.Tenant, a.TenantRegion)
	}

	return fmt.Sprintf("https://%s.auth0.com", a.Tenant)
}

func (a *tpaAuth0) validate() error {
	if a.Tenant == "" {
		return errors.New("Invalid config: auth.third_party.auth0 is enabled but without a tenant.")
	}

	return nil
}

func (c *tpaCognito) issuerURL() string {
	return fmt.Sprintf("https://cognito-idp.%s.amazonaws.com/%s", c.UserPoolRegion, c.UserPoolID)
}

func (c *tpaCognito) validate() error {
	if c.UserPoolID == "" {
		return errors.New("Invalid config: auth.third_party.cognito is enabled but without a user_pool_id.")
	}
	var err error
	if c.UserPoolID, err = maybeLoadEnv(c.UserPoolID); err != nil {
		return err
	}

	if c.UserPoolRegion == "" {
		return errors.New("Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.")
	}
	if c.UserPoolRegion, err = maybeLoadEnv(c.UserPoolRegion); err != nil {
		return err
	}

	return nil
}

func (tpa *thirdParty) validate() error {
	enabled := 0

	if tpa.Firebase.Enabled {
		enabled += 1

		if err := tpa.Firebase.validate(); err != nil {
			return err
		}
	}

	if tpa.Auth0.Enabled {
		enabled += 1

		if err := tpa.Auth0.validate(); err != nil {
			return err
		}
	}

	if tpa.Cognito.Enabled {
		enabled += 1

		if err := tpa.Cognito.validate(); err != nil {
			return err
		}
	}

	if enabled > 1 {
		return errors.New("Invalid config: Only one third_party provider allowed to be enabled at a time.")
	}

	return nil
}

func (tpa *thirdParty) IssuerURL() string {
	if tpa.Firebase.Enabled {
		return tpa.Firebase.issuerURL()
	}

	if tpa.Auth0.Enabled {
		return tpa.Auth0.issuerURL()
	}

	if tpa.Cognito.Enabled {
		return tpa.Cognito.issuerURL()
	}

	return ""
}

// ResolveJWKS creates the JWKS from the JWT secret and Third-Party auth
// configs by resolving the JWKS via the OIDC discovery URL.
// It always returns a JWKS string, except when there's an error fetching.
func (a *auth) ResolveJWKS(ctx context.Context) (string, error) {
	var jwks struct {
		Keys []json.RawMessage `json:"keys"`
	}

	issuerURL := a.ThirdParty.IssuerURL()
	if issuerURL != "" {
		discoveryURL := issuerURL + "/.well-known/openid-configuration"

		t := &http.Client{Timeout: 10 * time.Second}
		client := fetcher.NewFetcher(
			discoveryURL,
			fetcher.WithHTTPClient(t),
			fetcher.WithExpectedStatus(http.StatusOK),
		)

		resp, err := client.Send(ctx, http.MethodGet, "", nil)
		if err != nil {
			return "", err
		}

		type oidcConfiguration struct {
			JWKSURI string `json:"jwks_uri"`
		}

		oidcConfig, err := fetcher.ParseJSON[oidcConfiguration](resp.Body)
		if err != nil {
			return "", err
		}

		if oidcConfig.JWKSURI == "" {
			return "", fmt.Errorf("auth.third_party: OIDC configuration at URL %q does not expose a jwks_uri property", discoveryURL)
		}

		client = fetcher.NewFetcher(
			oidcConfig.JWKSURI,
			fetcher.WithHTTPClient(t),
			fetcher.WithExpectedStatus(http.StatusOK),
		)

		resp, err = client.Send(ctx, http.MethodGet, "", nil)
		if err != nil {
			return "", err
		}

		type remoteJWKS struct {
			Keys []json.RawMessage `json:"keys"`
		}

		rJWKS, err := fetcher.ParseJSON[remoteJWKS](resp.Body)
		if err != nil {
			return "", err
		}

		if len(rJWKS.Keys) == 0 {
			return "", fmt.Errorf("auth.third_party: JWKS at URL %q as discovered from %q does not contain any JWK keys", oidcConfig.JWKSURI, discoveryURL)
		}

		jwks.Keys = rJWKS.Keys
	}

	var secretJWK struct {
		KeyType      string `json:"kty"`
		KeyBase64URL string `json:"k"`
	}

	secretJWK.KeyType = "oct"
	secretJWK.KeyBase64URL = base64.RawURLEncoding.EncodeToString([]byte(a.JwtSecret))

	secretJWKEncoded, err := json.Marshal(&secretJWK)
	if err != nil {
		return "", errors.Errorf("failed to marshal secret jwk: %w", err)
	}

	jwks.Keys = append(jwks.Keys, json.RawMessage(secretJWKEncoded))

	jwksEncoded, err := json.Marshal(jwks)
	if err != nil {
		return "", errors.Errorf("failed to marshal jwks keys: %w", err)
	}

	return string(jwksEncoded), nil
}

func (h *hookConfig) HandleHook(hookType string) error {
	// If not enabled do nothing
	if !h.Enabled {
		return nil
	}
	if h.URI == "" {
		return errors.Errorf("missing required field in config: auth.hook.%s.uri", hookType)
	}
	if err := validateHookURI(h.URI, hookType); err != nil {
		return err
	}
	var err error
	if h.Secrets, err = maybeLoadEnv(h.Secrets); err != nil {
		return errors.Errorf("missing required field in config: auth.hook.%s.secrets", hookType)
	}
	return nil
}

func validateHookURI(uri, hookName string) error {
	parsed, err := url.Parse(uri)
	if err != nil {
		return errors.Errorf("failed to parse template url: %w", err)
	}
	if !(parsed.Scheme == "http" || parsed.Scheme == "https" || parsed.Scheme == "pg-functions") {
		return errors.Errorf("Invalid HTTP hook config: auth.hook.%v should be a Postgres function URI, or a HTTP or HTTPS URL", hookName)
	}
	return nil
}
