package config

import (
	"strconv"
	"time"

	v1API "github.com/supabase/cli/pkg/api"
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

func (a *Auth) ToUpdateAuthConfigBody() v1API.UpdateAuthConfigBody {
	body := v1API.UpdateAuthConfigBody{
		DisableSignup:                     &a.EnableSignup,
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

// Helper function to get a pointer to a value
func ptr[T any](v T) *T {
	return &v
}
