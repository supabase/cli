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
	"github.com/supabase/cli/pkg/fetcher"
)

type (
	Auth struct {
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

func (a *Auth) Clone() Auth {
	copy := *a
	copy.External = maps.Clone(a.External)
	copy.Email.Template = maps.Clone(a.Email.Template)
	copy.Sms.TestOTP = maps.Clone(a.Sms.TestOTP)
	return copy
}

func (a *Auth) ToUpdateAuthConfigBody() v1API.UpdateAuthConfigBody {
	body := v1API.UpdateAuthConfigBody{
		DisableSignup:                     ptr(!a.EnableSignup),
		SiteUrl:                           ptr(a.SiteUrl),
		JwtExp:                            ptr(float32(a.JwtExpiry)),
		SmtpAdminEmail:                    ptr(a.Email.Smtp.AdminEmail),
		SmtpHost:                          ptr(a.Email.Smtp.Host),
		SmtpPass:                          ptr(a.Email.Smtp.Pass),
		SmtpPort:                          ptr(strconv.Itoa(int(a.Email.Smtp.Port))),
		SmtpUser:                          ptr(a.Email.Smtp.User),
		SmtpSenderName:                    ptr(a.Email.Smtp.SenderName),
		SmtpMaxFrequency:                  ptr(float32(a.Email.MaxFrequency.Seconds())),
		MailerAutoconfirm:                 ptr(a.Email.EnableConfirmations),
		MailerSecureEmailChangeEnabled:    ptr(a.Email.SecurePasswordChange),
		SmsAutoconfirm:                    ptr(a.Sms.EnableConfirmations),
		SmsProvider:                       ptr(getSmsProvider(a)),
		SmsTemplate:                       ptr(a.Sms.Template),
		SmsMaxFrequency:                   ptr(float32(a.Sms.MaxFrequency.Seconds())),
		ExternalEmailEnabled:              ptr(a.Email.EnableSignup),
		ExternalPhoneEnabled:              ptr(a.Sms.EnableSignup),
		ExternalAnonymousUsersEnabled:     ptr(a.EnableAnonymousSignIns),
		MfaMaxEnrolledFactors:             ptr(float32(a.MFA.MaxEnrolledFactors)),
		MfaTotpEnrollEnabled:              ptr(a.MFA.TOTP.EnrollEnabled),
		MfaTotpVerifyEnabled:              ptr(a.MFA.TOTP.VerifyEnabled),
		MfaPhoneEnrollEnabled:             ptr(a.MFA.Phone.EnrollEnabled),
		MfaPhoneVerifyEnabled:             ptr(a.MFA.Phone.VerifyEnabled),
		MfaPhoneOtpLength:                 ptr(float32(a.MFA.Phone.OtpLength)),
		MfaPhoneTemplate:                  ptr(a.MFA.Phone.Template),
		MfaPhoneMaxFrequency:              ptr(float32(a.MFA.Phone.MaxFrequency.Seconds())),
		RefreshTokenRotationEnabled:       ptr(a.EnableRefreshTokenRotation),
		SecurityRefreshTokenReuseInterval: ptr(float32(a.RefreshTokenReuseInterval)),
		SecurityManualLinkingEnabled:      ptr(a.EnableManualLinking),
		SessionsTimebox:                   ptr(float32(a.Sessions.Timebox.Seconds())),
		SessionsInactivityTimeout:         ptr(float32(a.Sessions.InactivityTimeout.Seconds())),
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

func (a *Auth) mapExternalProviders(body *v1API.UpdateAuthConfigBody) {
	for providerName, config := range a.External {
		switch providerName {
		case "apple":
			body.ExternalAppleEnabled = ptr(config.Enabled)
			body.ExternalAppleClientId = ptr(config.ClientId)
			body.ExternalAppleSecret = ptr(config.Secret)
		case "azure":
			body.ExternalAzureEnabled = ptr(config.Enabled)
			body.ExternalAzureClientId = ptr(config.ClientId)
			body.ExternalAzureSecret = ptr(config.Secret)
			body.ExternalAzureUrl = ptr(config.Url)
		case "bitbucket":
			body.ExternalBitbucketEnabled = ptr(config.Enabled)
			body.ExternalBitbucketClientId = ptr(config.ClientId)
			body.ExternalBitbucketSecret = ptr(config.Secret)
		case "discord":
			body.ExternalDiscordEnabled = ptr(config.Enabled)
			body.ExternalDiscordClientId = ptr(config.ClientId)
			body.ExternalDiscordSecret = ptr(config.Secret)
		case "facebook":
			body.ExternalFacebookEnabled = ptr(config.Enabled)
			body.ExternalFacebookClientId = ptr(config.ClientId)
			body.ExternalFacebookSecret = ptr(config.Secret)
		case "github":
			body.ExternalGithubEnabled = ptr(config.Enabled)
			body.ExternalGithubClientId = ptr(config.ClientId)
			body.ExternalGithubSecret = ptr(config.Secret)
		case "gitlab":
			body.ExternalGitlabEnabled = ptr(config.Enabled)
			body.ExternalGitlabClientId = ptr(config.ClientId)
			body.ExternalGitlabSecret = ptr(config.Secret)
			body.ExternalGitlabUrl = ptr(config.Url)
		case "google":
			body.ExternalGoogleEnabled = ptr(config.Enabled)
			body.ExternalGoogleClientId = ptr(config.ClientId)
			body.ExternalGoogleSecret = ptr(config.Secret)
			body.ExternalGoogleSkipNonceCheck = ptr(config.SkipNonceCheck)
		case "keycloak":
			body.ExternalKeycloakEnabled = ptr(config.Enabled)
			body.ExternalKeycloakClientId = ptr(config.ClientId)
			body.ExternalKeycloakSecret = ptr(config.Secret)
			body.ExternalKeycloakUrl = ptr(config.Url)
		case "linkedin_oidc":
		case "linkedin":
			body.ExternalLinkedinOidcEnabled = ptr(config.Enabled)
			body.ExternalLinkedinOidcClientId = ptr(config.ClientId)
			body.ExternalLinkedinOidcSecret = ptr(config.Secret)
		case "notion":
			body.ExternalNotionEnabled = ptr(config.Enabled)
			body.ExternalNotionClientId = ptr(config.ClientId)
			body.ExternalNotionSecret = ptr(config.Secret)
		case "slack_oidc":
		case "slack":
			body.ExternalSlackOidcEnabled = ptr(config.Enabled)
			body.ExternalSlackOidcClientId = ptr(config.ClientId)
			body.ExternalSlackOidcSecret = ptr(config.Secret)
		case "spotify":
			body.ExternalSpotifyEnabled = ptr(config.Enabled)
			body.ExternalSpotifyClientId = ptr(config.ClientId)
			body.ExternalSpotifySecret = ptr(config.Secret)
		case "twitch":
			body.ExternalTwitchEnabled = ptr(config.Enabled)
			body.ExternalTwitchClientId = ptr(config.ClientId)
			body.ExternalTwitchSecret = ptr(config.Secret)
		case "twitter":
			body.ExternalTwitterEnabled = ptr(config.Enabled)
			body.ExternalTwitterClientId = ptr(config.ClientId)
			body.ExternalTwitterSecret = ptr(config.Secret)
		case "workos":
			body.ExternalWorkosEnabled = ptr(config.Enabled)
			body.ExternalWorkosClientId = ptr(config.ClientId)
			body.ExternalWorkosSecret = ptr(config.Secret)
			body.ExternalWorkosUrl = ptr(config.Url)
		case "zoom":
			body.ExternalZoomEnabled = ptr(config.Enabled)
			body.ExternalZoomClientId = ptr(config.ClientId)
			body.ExternalZoomSecret = ptr(config.Secret)
		}
	}
}

func (a *Auth) mapEmailTemplates(body *v1API.UpdateAuthConfigBody) {

	for name, template := range a.Email.Template {
		switch name {
		case "invite":
			body.MailerSubjectsInvite = ptr(template.Subject)
			body.MailerTemplatesInviteContent = ptr(template.ContentPath)
		case "confirmation":
			body.MailerSubjectsConfirmation = ptr(template.Subject)
			body.MailerTemplatesConfirmationContent = ptr(template.ContentPath)
		case "recovery":
			body.MailerSubjectsRecovery = ptr(template.Subject)
			body.MailerTemplatesRecoveryContent = ptr(template.ContentPath)
		case "magic_link":
			body.MailerSubjectsMagicLink = ptr(template.Subject)
			body.MailerTemplatesMagicLinkContent = ptr(template.ContentPath)
		case "email_change":
			body.MailerSubjectsEmailChange = ptr(template.Subject)
			body.MailerTemplatesEmailChangeContent = ptr(template.ContentPath)
		}
	}
}

func (a *Auth) mapHooks(body *v1API.UpdateAuthConfigBody) {
	body.HookCustomAccessTokenEnabled = ptr(a.Hook.CustomAccessToken.Enabled)
	body.HookCustomAccessTokenUri = ptr(a.Hook.CustomAccessToken.URI)
	body.HookCustomAccessTokenSecrets = ptr(a.Hook.CustomAccessToken.Secrets)

	body.HookMfaVerificationAttemptEnabled = ptr(a.Hook.MFAVerificationAttempt.Enabled)
	body.HookMfaVerificationAttemptUri = ptr(a.Hook.MFAVerificationAttempt.URI)
	body.HookMfaVerificationAttemptSecrets = ptr(a.Hook.MFAVerificationAttempt.Secrets)

	body.HookPasswordVerificationAttemptEnabled = ptr(a.Hook.PasswordVerificationAttempt.Enabled)
	body.HookPasswordVerificationAttemptUri = ptr(a.Hook.PasswordVerificationAttempt.URI)
	body.HookPasswordVerificationAttemptSecrets = ptr(a.Hook.PasswordVerificationAttempt.Secrets)

	body.HookSendEmailEnabled = ptr(a.Hook.SendEmail.Enabled)
	body.HookSendEmailUri = ptr(a.Hook.SendEmail.URI)
	body.HookSendEmailSecrets = ptr(a.Hook.SendEmail.Secrets)

	body.HookSendSmsEnabled = ptr(a.Hook.SendSMS.Enabled)
	body.HookSendSmsUri = ptr(a.Hook.SendSMS.URI)
	body.HookSendSmsSecrets = ptr(a.Hook.SendSMS.Secrets)
}

func (a *Auth) mapSmsProviders(body *v1API.UpdateAuthConfigBody) {
	if a.Sms.Twilio.Enabled {
		body.SmsTwilioAccountSid = ptr(a.Sms.Twilio.AccountSid)
		body.SmsTwilioAuthToken = ptr(a.Sms.Twilio.AuthToken)
		body.SmsTwilioMessageServiceSid = ptr(a.Sms.Twilio.MessageServiceSid)
	}

	if a.Sms.TwilioVerify.Enabled {
		body.SmsTwilioVerifyAccountSid = ptr(a.Sms.TwilioVerify.AccountSid)
		body.SmsTwilioVerifyAuthToken = ptr(a.Sms.TwilioVerify.AuthToken)
		body.SmsTwilioVerifyMessageServiceSid = ptr(a.Sms.TwilioVerify.MessageServiceSid)
	}

	if a.Sms.Messagebird.Enabled {
		body.SmsMessagebirdAccessKey = ptr(a.Sms.Messagebird.AccessKey)
		body.SmsMessagebirdOriginator = ptr(a.Sms.Messagebird.Originator)
	}

	if a.Sms.Textlocal.Enabled {
		body.SmsTextlocalApiKey = ptr(a.Sms.Textlocal.ApiKey)
		body.SmsTextlocalSender = ptr(a.Sms.Textlocal.Sender)
	}

	if a.Sms.Vonage.Enabled {
		body.SmsVonageApiKey = ptr(a.Sms.Vonage.ApiKey)
		body.SmsVonageApiSecret = ptr(a.Sms.Vonage.ApiSecret)
		body.SmsVonageFrom = ptr(a.Sms.Vonage.From)
	}
}

// Helper function to determine SMS provider
func getSmsProvider(a *Auth) string {
	switch {
	case a.Sms.Twilio.Enabled:
		return "twilio"
	case a.Sms.TwilioVerify.Enabled:
		return "twilio_verify"
	case a.Sms.Messagebird.Enabled:
		return "messagebird"
	case a.Sms.Textlocal.Enabled:
		return "textlocal"
	case a.Sms.Vonage.Enabled:
		return "vonage"
	default:
		return ""
	}
}

func (a *Auth) FromRemoteAuthConfig(remoteConfig v1API.AuthConfigResponse) Auth {
	result := a.Clone()

	if remoteConfig.DisableSignup != nil {
		result.EnableSignup = !*remoteConfig.DisableSignup
	}
	if remoteConfig.SiteUrl != nil {
		result.SiteUrl = *remoteConfig.SiteUrl
	}
	if remoteConfig.JwtExp != nil {
		result.JwtExpiry = uint(time.Duration(*remoteConfig.JwtExp))
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

func (a *Auth) mapRemoteEmailTemplates(remoteConfig v1API.AuthConfigResponse) {
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

func (a *Auth) mapRemoteExternalProviders(remoteConfig v1API.AuthConfigResponse) {
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

func (a *Auth) mapRemoteHooks(remoteConfig v1API.AuthConfigResponse) {
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

func (a *Auth) mapRemoteSmsProviders(remoteConfig v1API.AuthConfigResponse) {
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

func (original *Auth) compareAndHideSensitiveFields(remote *Auth) {
	// This function compares the original Auth struct with a remote Auth struct
	// and hides sensitive fields in both structs for secure comparison
	// SMTP sensitive fields
	compareSensitiveField(&original.Email.Smtp.AdminEmail, &remote.Email.Smtp.AdminEmail)
	compareSensitiveField(&original.Email.Smtp.Host, &remote.Email.Smtp.Host)
	compareSensitiveField(&original.Email.Smtp.User, &remote.Email.Smtp.User)
	compareSensitiveField(&original.Email.Smtp.SenderName, &remote.Email.Smtp.SenderName)
	compareSensitiveField(&original.Email.Smtp.Pass, &remote.Email.Smtp.Pass)
	// Sms sensitives fields
	compareSensitiveField(&original.Sms.Twilio.AuthToken, &remote.Sms.Twilio.AuthToken)
	compareSensitiveField(&original.Sms.TwilioVerify.AuthToken, &remote.Sms.TwilioVerify.AuthToken)
	compareSensitiveField(&original.Sms.Messagebird.AccessKey, &remote.Sms.Messagebird.AccessKey)
	compareSensitiveField(&original.Sms.Textlocal.ApiKey, &remote.Sms.Textlocal.ApiKey)
	compareSensitiveField(&original.Sms.Vonage.ApiKey, &remote.Sms.Vonage.ApiKey)
	compareSensitiveField(&original.Sms.Vonage.ApiSecret, &remote.Sms.Vonage.ApiSecret)
	compareSensitiveField(&original.Sms.Twilio.AccountSid, &remote.Sms.Twilio.AccountSid)
	compareSensitiveField(&original.Sms.Twilio.MessageServiceSid, &remote.Sms.Twilio.MessageServiceSid)
	compareSensitiveField(&original.Sms.TwilioVerify.AccountSid, &remote.Sms.TwilioVerify.AccountSid)
	compareSensitiveField(&original.Sms.TwilioVerify.MessageServiceSid, &remote.Sms.TwilioVerify.MessageServiceSid)

	// Compare external providers hide secrets and id
	for provider, originalConfig := range original.External {
		if remoteConfig, exists := remote.External[provider]; exists {
			compareSensitiveField(&originalConfig.Secret, &remoteConfig.Secret)
			compareSensitiveField(&originalConfig.ClientId, &remoteConfig.ClientId)
			compareSensitiveField(&originalConfig.RedirectUri, &remoteConfig.RedirectUri)
			compareSensitiveField(&originalConfig.Url, &remoteConfig.Url)
			remote.External[provider] = remoteConfig
			original.External[provider] = originalConfig
		}
	}
	// Api sensitive fields
	compareSensitiveField(&original.JwtSecret, &remote.JwtSecret)
	compareSensitiveField(&original.AnonKey, &remote.AnonKey)
	compareSensitiveField(&original.ServiceRoleKey, &remote.ServiceRoleKey)

	// Third-party sensitive fields
	compareSensitiveField(&original.ThirdParty.Firebase.ProjectID, &remote.ThirdParty.Firebase.ProjectID)
	compareSensitiveField(&original.ThirdParty.Auth0.Tenant, &remote.ThirdParty.Auth0.Tenant)
	compareSensitiveField(&original.ThirdParty.Cognito.UserPoolID, &remote.ThirdParty.Cognito.UserPoolID)

	// Hook secrets
	compareSensitiveField(&original.Hook.MFAVerificationAttempt.Secrets, &remote.Hook.MFAVerificationAttempt.Secrets)
	compareSensitiveField(&original.Hook.PasswordVerificationAttempt.Secrets, &remote.Hook.PasswordVerificationAttempt.Secrets)
	compareSensitiveField(&original.Hook.CustomAccessToken.Secrets, &remote.Hook.CustomAccessToken.Secrets)
	compareSensitiveField(&original.Hook.SendSMS.Secrets, &remote.Hook.SendSMS.Secrets)
	compareSensitiveField(&original.Hook.SendEmail.Secrets, &remote.Hook.SendEmail.Secrets)
}

func (a *Auth) DiffWithRemote(remoteConfig v1API.AuthConfigResponse) []byte {
	// First we clone our local auth for a new instance
	localCopy := a.Clone()
	// We make a new Auth instance from our remote config
	remoteCopy := localCopy.FromRemoteAuthConfig(remoteConfig)
	// We compare and hide sensitive fields for auth config, leaving only a marker to know if there was changes or not
	localCopy.compareAndHideSensitiveFields(&remoteCopy)
	currentValue := ToTomlBytes(&localCopy)
	remoteCompare := ToTomlBytes(&remoteCopy)
	// We diff our resulting config
	return Diff("remote[auth]", remoteCompare, "local[auth]", currentValue)
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

// ResolveJWKS creates the JWKS from the JWT secret and Third-Party Auth
// configs by resolving the JWKS via the OIDC discovery URL.
// It always returns a JWKS string, except when there's an error fetching.
func (a *Auth) ResolveJWKS(ctx context.Context) (string, error) {
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
