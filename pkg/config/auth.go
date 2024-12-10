package config

import (
	"strconv"
	"strings"
	"time"

	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
)

type PasswordRequirements string

const (
	NoRequirements                 PasswordRequirements = ""
	LettersDigits                  PasswordRequirements = "letters_digits"
	LowerUpperLettersDigits        PasswordRequirements = "lower_upper_letters_digits"
	LowerUpperLettersDigitsSymbols PasswordRequirements = "lower_upper_letters_digits_symbols"
)

func (r PasswordRequirements) ToChar() v1API.UpdateAuthConfigBodyPasswordRequiredCharacters {
	switch r {
	case LettersDigits:
		return v1API.AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
	case LowerUpperLettersDigits:
		return v1API.AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567891
	case LowerUpperLettersDigitsSymbols:
		return v1API.AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567892
	}
	return v1API.Empty
}

func NewPasswordRequirement(c v1API.UpdateAuthConfigBodyPasswordRequiredCharacters) PasswordRequirements {
	switch c {
	case v1API.AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:
		return LettersDigits
	case v1API.AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567891:
		return LowerUpperLettersDigits
	case v1API.AbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567892:
		return LowerUpperLettersDigitsSymbols
	}
	return NoRequirements
}

type (
	auth struct {
		Enabled bool   `toml:"enabled"`
		Image   string `toml:"-"`

		SiteUrl                    string               `toml:"site_url" mapstructure:"site_url"`
		AdditionalRedirectUrls     []string             `toml:"additional_redirect_urls"`
		JwtExpiry                  uint                 `toml:"jwt_expiry"`
		EnableRefreshTokenRotation bool                 `toml:"enable_refresh_token_rotation"`
		RefreshTokenReuseInterval  uint                 `toml:"refresh_token_reuse_interval"`
		EnableManualLinking        bool                 `toml:"enable_manual_linking"`
		EnableSignup               bool                 `toml:"enable_signup"`
		EnableAnonymousSignIns     bool                 `toml:"enable_anonymous_sign_ins"`
		MinimumPasswordLength      uint                 `toml:"minimum_password_length"`
		PasswordRequirements       PasswordRequirements `toml:"password_requirements"`

		Hook     hook     `toml:"hook"`
		MFA      mfa      `toml:"mfa"`
		Sessions sessions `toml:"sessions"`
		Email    email    `toml:"email"`
		Sms      sms      `toml:"sms"`
		External external `toml:"external"`

		// Custom secrets can be injected from .env file
		JwtSecret      string `toml:"-" mapstructure:"jwt_secret"`
		AnonKey        string `toml:"-" mapstructure:"anon_key"`
		ServiceRoleKey string `toml:"-" mapstructure:"service_role_key"`

		ThirdParty thirdParty `toml:"third_party"`
	}

	external map[string]provider

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

	email struct {
		EnableSignup         bool                     `toml:"enable_signup"`
		DoubleConfirmChanges bool                     `toml:"double_confirm_changes"`
		EnableConfirmations  bool                     `toml:"enable_confirmations"`
		SecurePasswordChange bool                     `toml:"secure_password_change"`
		Template             map[string]emailTemplate `toml:"template"`
		Smtp                 *smtp                    `toml:"smtp"`
		MaxFrequency         time.Duration            `toml:"max_frequency"`
		OtpLength            uint                     `toml:"otp_length"`
		OtpExpiry            uint                     `toml:"otp_expiry"`
	}

	smtp struct {
		Enabled    *bool  `toml:"enabled"`
		Host       string `toml:"host"`
		Port       uint16 `toml:"port"`
		User       string `toml:"user"`
		Pass       string `toml:"pass"`
		AdminEmail string `toml:"admin_email"`
		SenderName string `toml:"sender_name"`
	}

	emailTemplate struct {
		Subject *string `toml:"subject"`
		Content *string `toml:"content"`
		// Only content path is accepted in config.toml
		ContentPath string `toml:"content_path"`
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

	hook struct {
		MFAVerificationAttempt      *hookConfig `toml:"mfa_verification_attempt"`
		PasswordVerificationAttempt *hookConfig `toml:"password_verification_attempt"`
		CustomAccessToken           *hookConfig `toml:"custom_access_token"`
		SendSMS                     *hookConfig `toml:"send_sms"`
		SendEmail                   *hookConfig `toml:"send_email"`
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

	mfa struct {
		TOTP               factorTypeConfiguration      `toml:"totp"`
		Phone              phoneFactorTypeConfiguration `toml:"phone"`
		WebAuthn           factorTypeConfiguration      `toml:"web_authn"`
		MaxEnrolledFactors uint                         `toml:"max_enrolled_factors"`
	}

	hookConfig struct {
		Enabled bool   `toml:"enabled"`
		URI     string `toml:"uri"`
		Secrets string `toml:"secrets"`
	}

	sessions struct {
		Timebox           time.Duration `toml:"timebox"`
		InactivityTimeout time.Duration `toml:"inactivity_timeout"`
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

	provider struct {
		Enabled        bool   `toml:"enabled"`
		ClientId       string `toml:"client_id"`
		Secret         string `toml:"secret"`
		Url            string `toml:"url"`
		RedirectUri    string `toml:"redirect_uri"`
		SkipNonceCheck bool   `toml:"skip_nonce_check"`
	}
)

func (a *auth) ToUpdateAuthConfigBody() v1API.UpdateAuthConfigBody {
	body := v1API.UpdateAuthConfigBody{
		SiteUrl:                           &a.SiteUrl,
		UriAllowList:                      cast.Ptr(strings.Join(a.AdditionalRedirectUrls, ",")),
		JwtExp:                            cast.UintToIntPtr(&a.JwtExpiry),
		RefreshTokenRotationEnabled:       &a.EnableRefreshTokenRotation,
		SecurityRefreshTokenReuseInterval: cast.UintToIntPtr(&a.RefreshTokenReuseInterval),
		SecurityManualLinkingEnabled:      &a.EnableManualLinking,
		DisableSignup:                     cast.Ptr(!a.EnableSignup),
		ExternalAnonymousUsersEnabled:     &a.EnableAnonymousSignIns,
		PasswordMinLength:                 cast.UintToIntPtr(&a.MinimumPasswordLength),
		PasswordRequiredCharacters:        cast.Ptr(a.PasswordRequirements.ToChar()),
	}
	a.Hook.toAuthConfigBody(&body)
	a.MFA.toAuthConfigBody(&body)
	a.Sessions.toAuthConfigBody(&body)
	a.Email.toAuthConfigBody(&body)
	a.Sms.toAuthConfigBody(&body)
	a.External.toAuthConfigBody(&body)
	return body
}

func (a *auth) FromRemoteAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	a.SiteUrl = cast.Val(remoteConfig.SiteUrl, "")
	a.AdditionalRedirectUrls = strToArr(cast.Val(remoteConfig.UriAllowList, ""))
	a.JwtExpiry = cast.IntToUint(cast.Val(remoteConfig.JwtExp, 0))
	a.EnableRefreshTokenRotation = cast.Val(remoteConfig.RefreshTokenRotationEnabled, false)
	a.RefreshTokenReuseInterval = cast.IntToUint(cast.Val(remoteConfig.SecurityRefreshTokenReuseInterval, 0))
	a.EnableManualLinking = cast.Val(remoteConfig.SecurityManualLinkingEnabled, false)
	a.EnableSignup = !cast.Val(remoteConfig.DisableSignup, false)
	a.EnableAnonymousSignIns = cast.Val(remoteConfig.ExternalAnonymousUsersEnabled, false)
	a.MinimumPasswordLength = cast.IntToUint(cast.Val(remoteConfig.PasswordMinLength, 0))
	prc := cast.Val(remoteConfig.PasswordRequiredCharacters, "")
	a.PasswordRequirements = NewPasswordRequirement(v1API.UpdateAuthConfigBodyPasswordRequiredCharacters(prc))
	a.Hook.fromAuthConfig(remoteConfig)
	a.MFA.fromAuthConfig(remoteConfig)
	a.Sessions.fromAuthConfig(remoteConfig)
	a.Email.fromAuthConfig(remoteConfig)
	a.Sms.fromAuthConfig(remoteConfig)
	a.External.fromAuthConfig(remoteConfig)
}

func (h hook) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	// When local config is not set, we assume platform defaults should not change
	if hook := h.CustomAccessToken; hook != nil {
		if body.HookCustomAccessTokenEnabled = &hook.Enabled; hook.Enabled {
			body.HookCustomAccessTokenUri = &hook.URI
			if len(hook.Secrets) > 0 {
				body.HookCustomAccessTokenSecrets = &hook.Secrets
			}
		}
	}
	if hook := h.SendEmail; hook != nil {
		if body.HookSendEmailEnabled = &hook.Enabled; hook.Enabled {
			body.HookSendEmailUri = &hook.URI
			if len(hook.Secrets) > 0 {
				body.HookSendEmailSecrets = &hook.Secrets
			}
		}
	}
	if hook := h.SendSMS; hook != nil {
		if body.HookSendSmsEnabled = &hook.Enabled; hook.Enabled {
			body.HookSendSmsUri = &hook.URI
			if len(hook.Secrets) > 0 {
				body.HookSendSmsSecrets = &hook.Secrets
			}
		}
	}
	// Enterprise and team only features
	if hook := h.MFAVerificationAttempt; hook != nil {
		if body.HookMfaVerificationAttemptEnabled = &hook.Enabled; hook.Enabled {
			body.HookMfaVerificationAttemptUri = &hook.URI
			if len(hook.Secrets) > 0 {
				body.HookMfaVerificationAttemptSecrets = &hook.Secrets
			}
		}
	}
	if hook := h.PasswordVerificationAttempt; hook != nil {
		if body.HookPasswordVerificationAttemptEnabled = &hook.Enabled; hook.Enabled {
			body.HookPasswordVerificationAttemptUri = &hook.URI
			if len(hook.Secrets) > 0 {
				body.HookPasswordVerificationAttemptSecrets = &hook.Secrets
			}
		}
	}
}
func (h *hook) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	// When local config is not set, we assume platform defaults should not change
	if hook := h.CustomAccessToken; hook != nil {
		// Ignore disabled hooks because their envs are not loaded
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookCustomAccessTokenUri, "")
			hook.Secrets = hashPrefix + cast.Val(remoteConfig.HookCustomAccessTokenSecrets, "")
		}
		hook.Enabled = cast.Val(remoteConfig.HookCustomAccessTokenEnabled, false)
	}
	if hook := h.SendEmail; hook != nil {
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookSendEmailUri, "")
			hook.Secrets = hashPrefix + cast.Val(remoteConfig.HookSendEmailSecrets, "")
		}
		hook.Enabled = cast.Val(remoteConfig.HookSendEmailEnabled, false)
	}
	if hook := h.SendSMS; hook != nil {
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookSendSmsUri, "")
			hook.Secrets = hashPrefix + cast.Val(remoteConfig.HookSendSmsSecrets, "")
		}
		hook.Enabled = cast.Val(remoteConfig.HookSendSmsEnabled, false)
	}
	// Enterprise and team only features
	if hook := h.MFAVerificationAttempt; hook != nil {
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookMfaVerificationAttemptUri, "")
			hook.Secrets = hashPrefix + cast.Val(remoteConfig.HookMfaVerificationAttemptSecrets, "")
		}
		hook.Enabled = cast.Val(remoteConfig.HookMfaVerificationAttemptEnabled, false)
	}
	if hook := h.PasswordVerificationAttempt; hook != nil {
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookPasswordVerificationAttemptUri, "")
			hook.Secrets = hashPrefix + cast.Val(remoteConfig.HookPasswordVerificationAttemptSecrets, "")
		}
		hook.Enabled = cast.Val(remoteConfig.HookPasswordVerificationAttemptEnabled, false)
	}
}

func (m mfa) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.MfaMaxEnrolledFactors = cast.UintToIntPtr(&m.MaxEnrolledFactors)
	body.MfaTotpEnrollEnabled = &m.TOTP.EnrollEnabled
	body.MfaTotpVerifyEnabled = &m.TOTP.VerifyEnabled
	body.MfaPhoneEnrollEnabled = &m.Phone.EnrollEnabled
	body.MfaPhoneVerifyEnabled = &m.Phone.VerifyEnabled
	body.MfaPhoneOtpLength = cast.UintToIntPtr(&m.Phone.OtpLength)
	body.MfaPhoneTemplate = &m.Phone.Template
	body.MfaPhoneMaxFrequency = cast.Ptr(int(m.Phone.MaxFrequency.Seconds()))
	body.MfaWebAuthnEnrollEnabled = &m.WebAuthn.EnrollEnabled
	body.MfaWebAuthnVerifyEnabled = &m.WebAuthn.VerifyEnabled
}

func (m *mfa) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	m.MaxEnrolledFactors = cast.IntToUint(cast.Val(remoteConfig.MfaMaxEnrolledFactors, 0))
	m.TOTP.EnrollEnabled = cast.Val(remoteConfig.MfaTotpEnrollEnabled, false)
	m.TOTP.VerifyEnabled = cast.Val(remoteConfig.MfaTotpVerifyEnabled, false)
	m.Phone.EnrollEnabled = cast.Val(remoteConfig.MfaPhoneEnrollEnabled, false)
	m.Phone.VerifyEnabled = cast.Val(remoteConfig.MfaPhoneVerifyEnabled, false)
	m.Phone.OtpLength = cast.IntToUint(remoteConfig.MfaPhoneOtpLength)
	m.Phone.Template = cast.Val(remoteConfig.MfaPhoneTemplate, "")
	m.Phone.MaxFrequency = time.Duration(cast.Val(remoteConfig.MfaPhoneMaxFrequency, 0)) * time.Second
	m.WebAuthn.EnrollEnabled = cast.Val(remoteConfig.MfaWebAuthnEnrollEnabled, false)
	m.WebAuthn.VerifyEnabled = cast.Val(remoteConfig.MfaWebAuthnVerifyEnabled, false)
}

func (s sessions) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.SessionsTimebox = cast.Ptr(int(s.Timebox.Seconds()))
	body.SessionsInactivityTimeout = cast.Ptr(int(s.InactivityTimeout.Seconds()))
}

func (s *sessions) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	s.Timebox = time.Duration(cast.Val(remoteConfig.SessionsTimebox, 0)) * time.Second
	s.InactivityTimeout = time.Duration(cast.Val(remoteConfig.SessionsInactivityTimeout, 0)) * time.Second
}

func (e email) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.ExternalEmailEnabled = &e.EnableSignup
	body.MailerSecureEmailChangeEnabled = &e.DoubleConfirmChanges
	body.MailerAutoconfirm = cast.Ptr(!e.EnableConfirmations)
	body.MailerOtpLength = cast.UintToIntPtr(&e.OtpLength)
	body.MailerOtpExp = cast.UintToIntPtr(&e.OtpExpiry)
	body.SecurityUpdatePasswordRequireReauthentication = &e.SecurePasswordChange
	body.SmtpMaxFrequency = cast.Ptr(int(e.MaxFrequency.Seconds()))
	// When local config is not set, we assume platform defaults should not change
	if e.Smtp != nil {
		e.Smtp.toAuthConfigBody(body)
	}
	if len(e.Template) == 0 {
		return
	}
	var tmpl *emailTemplate
	tmpl = cast.Ptr(e.Template["invite"])
	body.MailerSubjectsInvite = tmpl.Subject
	body.MailerTemplatesInviteContent = tmpl.Content
	tmpl = cast.Ptr(e.Template["confirmation"])
	body.MailerSubjectsConfirmation = tmpl.Subject
	body.MailerTemplatesConfirmationContent = tmpl.Content
	tmpl = cast.Ptr(e.Template["recovery"])
	body.MailerSubjectsRecovery = tmpl.Subject
	body.MailerTemplatesRecoveryContent = tmpl.Content
	tmpl = cast.Ptr(e.Template["magic_link"])
	body.MailerSubjectsMagicLink = tmpl.Subject
	body.MailerTemplatesMagicLinkContent = tmpl.Content
	tmpl = cast.Ptr(e.Template["email_change"])
	body.MailerSubjectsEmailChange = tmpl.Subject
	body.MailerTemplatesEmailChangeContent = tmpl.Content
	tmpl = cast.Ptr(e.Template["reauthentication"])
	body.MailerSubjectsReauthentication = tmpl.Subject
	body.MailerTemplatesReauthenticationContent = tmpl.Content
}

func (e *email) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	e.EnableSignup = cast.Val(remoteConfig.ExternalEmailEnabled, false)
	e.DoubleConfirmChanges = cast.Val(remoteConfig.MailerSecureEmailChangeEnabled, false)
	e.EnableConfirmations = !cast.Val(remoteConfig.MailerAutoconfirm, false)
	e.OtpLength = cast.IntToUint(cast.Val(remoteConfig.MailerOtpLength, 0))
	e.OtpExpiry = cast.IntToUint(remoteConfig.MailerOtpExp)
	e.SecurePasswordChange = cast.Val(remoteConfig.SecurityUpdatePasswordRequireReauthentication, false)
	e.MaxFrequency = time.Duration(cast.Val(remoteConfig.SmtpMaxFrequency, 0)) * time.Second
	// When local config is not set, we assume platform defaults should not change
	if e.Smtp != nil {
		e.Smtp.fromAuthConfig(remoteConfig)
	}
	if len(e.Template) == 0 {
		return
	}
	var tmpl emailTemplate
	tmpl = e.Template["invite"]
	if tmpl.Subject != nil {
		tmpl.Subject = remoteConfig.MailerSubjectsInvite
	}
	if tmpl.Content != nil {
		tmpl.Content = remoteConfig.MailerTemplatesInviteContent
	}
	e.Template["invite"] = tmpl

	tmpl = e.Template["confirmation"]
	if tmpl.Subject != nil {
		tmpl.Subject = remoteConfig.MailerSubjectsConfirmation
	}
	if tmpl.Content != nil {
		tmpl.Content = remoteConfig.MailerTemplatesConfirmationContent
	}
	e.Template["confirmation"] = tmpl

	tmpl = e.Template["recovery"]
	if tmpl.Subject != nil {
		tmpl.Subject = remoteConfig.MailerSubjectsRecovery
	}
	if tmpl.Content != nil {
		tmpl.Content = remoteConfig.MailerTemplatesRecoveryContent
	}
	e.Template["recovery"] = tmpl

	tmpl = e.Template["magic_link"]
	if tmpl.Subject != nil {
		tmpl.Subject = remoteConfig.MailerSubjectsMagicLink
	}
	if tmpl.Content != nil {
		tmpl.Content = remoteConfig.MailerTemplatesMagicLinkContent
	}
	e.Template["magic_link"] = tmpl

	tmpl = e.Template["email_change"]
	if tmpl.Subject != nil {
		tmpl.Subject = remoteConfig.MailerSubjectsEmailChange
	}
	if tmpl.Content != nil {
		tmpl.Content = remoteConfig.MailerTemplatesEmailChangeContent
	}
	e.Template["email_change"] = tmpl

	tmpl = e.Template["reauthentication"]
	if tmpl.Subject != nil {
		tmpl.Subject = remoteConfig.MailerSubjectsReauthentication
	}
	if tmpl.Content != nil {
		tmpl.Content = remoteConfig.MailerTemplatesReauthenticationContent
	}
	e.Template["reauthentication"] = tmpl
}

func (s smtp) IsEnabled() bool {
	// If Enabled is not defined, or defined and set to true
	return cast.Val(s.Enabled, true)
}

func (s smtp) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	if !s.IsEnabled() {
		// Setting a single empty string disables SMTP
		body.SmtpHost = cast.Ptr("")
		return
	}
	body.SmtpHost = &s.Host
	body.SmtpPort = cast.Ptr(strconv.Itoa(int(s.Port)))
	body.SmtpUser = &s.User
	body.SmtpPass = &s.Pass
	body.SmtpAdminEmail = &s.AdminEmail
	body.SmtpSenderName = &s.SenderName
}

func (s *smtp) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	showDiff := s.IsEnabled()
	// Api resets all values when SMTP is disabled
	if enabled := remoteConfig.SmtpHost != nil; s.Enabled != nil {
		*s.Enabled = enabled
	}
	if !showDiff {
		return
	}
	s.Host = cast.Val(remoteConfig.SmtpHost, "")
	s.User = cast.Val(remoteConfig.SmtpUser, "")
	s.Pass = hashPrefix + cast.Val(remoteConfig.SmtpPass, "")
	s.AdminEmail = cast.Val(remoteConfig.SmtpAdminEmail, "")
	s.SenderName = cast.Val(remoteConfig.SmtpSenderName, "")
	portStr := cast.Val(remoteConfig.SmtpPort, "0")
	if port, err := strconv.ParseUint(portStr, 10, 16); err == nil {
		s.Port = uint16(port)
	}
}

func (s sms) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.ExternalPhoneEnabled = &s.EnableSignup
	body.SmsMaxFrequency = cast.Ptr(int(s.MaxFrequency.Seconds()))
	body.SmsAutoconfirm = &s.EnableConfirmations
	body.SmsTemplate = &s.Template
	if otpString := mapToEnv(s.TestOTP); len(otpString) > 0 {
		body.SmsTestOtp = &otpString
		// Set a 10 year validity for test OTP
		timestamp := time.Now().UTC().AddDate(10, 0, 0).Format(time.RFC3339)
		body.SmsTestOtpValidUntil = &timestamp
	}
	// Api only overrides configs of enabled providers
	switch {
	case s.Twilio.Enabled:
		body.SmsProvider = cast.Ptr("twilio")
		body.SmsTwilioAuthToken = &s.Twilio.AuthToken
		body.SmsTwilioAccountSid = &s.Twilio.AccountSid
		body.SmsTwilioMessageServiceSid = &s.Twilio.MessageServiceSid
	case s.TwilioVerify.Enabled:
		body.SmsProvider = cast.Ptr("twilio_verify")
		body.SmsTwilioVerifyAuthToken = &s.TwilioVerify.AuthToken
		body.SmsTwilioVerifyAccountSid = &s.TwilioVerify.AccountSid
		body.SmsTwilioVerifyMessageServiceSid = &s.TwilioVerify.MessageServiceSid
	case s.Messagebird.Enabled:
		body.SmsProvider = cast.Ptr("messagebird")
		body.SmsMessagebirdAccessKey = &s.Messagebird.AccessKey
		body.SmsMessagebirdOriginator = &s.Messagebird.Originator
	case s.Textlocal.Enabled:
		body.SmsProvider = cast.Ptr("textlocal")
		body.SmsTextlocalApiKey = &s.Textlocal.ApiKey
		body.SmsTextlocalSender = &s.Textlocal.Sender
	case s.Vonage.Enabled:
		body.SmsProvider = cast.Ptr("vonage")
		body.SmsVonageApiSecret = &s.Vonage.ApiSecret
		body.SmsVonageApiKey = &s.Vonage.ApiKey
		body.SmsVonageFrom = &s.Vonage.From
	}
}

func (s *sms) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	s.EnableSignup = cast.Val(remoteConfig.ExternalPhoneEnabled, false)
	s.MaxFrequency = time.Duration(cast.Val(remoteConfig.SmsMaxFrequency, 0)) * time.Second
	s.EnableConfirmations = cast.Val(remoteConfig.SmsAutoconfirm, false)
	s.Template = cast.Val(remoteConfig.SmsTemplate, "")
	s.TestOTP = envToMap(cast.Val(remoteConfig.SmsTestOtp, ""))
	// We are only interested in the provider that's enabled locally
	switch {
	case s.Twilio.Enabled:
		s.Twilio.AuthToken = hashPrefix + cast.Val(remoteConfig.SmsTwilioAuthToken, "")
		s.Twilio.AccountSid = cast.Val(remoteConfig.SmsTwilioAccountSid, "")
		s.Twilio.MessageServiceSid = cast.Val(remoteConfig.SmsTwilioMessageServiceSid, "")
	case s.TwilioVerify.Enabled:
		s.TwilioVerify.AuthToken = hashPrefix + cast.Val(remoteConfig.SmsTwilioVerifyAuthToken, "")
		s.TwilioVerify.AccountSid = cast.Val(remoteConfig.SmsTwilioVerifyAccountSid, "")
		s.TwilioVerify.MessageServiceSid = cast.Val(remoteConfig.SmsTwilioVerifyMessageServiceSid, "")
	case s.Messagebird.Enabled:
		s.Messagebird.AccessKey = hashPrefix + cast.Val(remoteConfig.SmsMessagebirdAccessKey, "")
		s.Messagebird.Originator = cast.Val(remoteConfig.SmsMessagebirdOriginator, "")
	case s.Textlocal.Enabled:
		s.Textlocal.ApiKey = hashPrefix + cast.Val(remoteConfig.SmsTextlocalApiKey, "")
		s.Textlocal.Sender = cast.Val(remoteConfig.SmsTextlocalSender, "")
	case s.Vonage.Enabled:
		s.Vonage.ApiSecret = hashPrefix + cast.Val(remoteConfig.SmsVonageApiSecret, "")
		s.Vonage.ApiKey = cast.Val(remoteConfig.SmsVonageApiKey, "")
		s.Vonage.From = cast.Val(remoteConfig.SmsVonageFrom, "")
	case !s.EnableSignup:
		// Nothing to do if both local and remote providers are disabled.
		return
	}
	if provider := cast.Val(remoteConfig.SmsProvider, ""); len(provider) > 0 {
		s.Twilio.Enabled = provider == "twilio"
		s.TwilioVerify.Enabled = provider == "twilio_verify"
		s.Messagebird.Enabled = provider == "messagebird"
		s.Textlocal.Enabled = provider == "textlocal"
		s.Vonage.Enabled = provider == "vonage"
	}
}

func (e external) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	if len(e) == 0 {
		return
	}
	// Ignore configs of disabled providers because their envs are not loaded
	if p, ok := e["apple"]; ok {
		if body.ExternalAppleEnabled = &p.Enabled; *body.ExternalAppleEnabled {
			body.ExternalAppleClientId = &p.ClientId
			body.ExternalAppleSecret = &p.Secret
		}
	}
	if p, ok := e["azure"]; ok {
		if body.ExternalAzureEnabled = &p.Enabled; *body.ExternalAzureEnabled {
			body.ExternalAzureClientId = &p.ClientId
			body.ExternalAzureSecret = &p.Secret
			body.ExternalAzureUrl = &p.Url
		}
	}
	if p, ok := e["bitbucket"]; ok {
		if body.ExternalBitbucketEnabled = &p.Enabled; *body.ExternalBitbucketEnabled {
			body.ExternalBitbucketClientId = &p.ClientId
			body.ExternalBitbucketSecret = &p.Secret
		}
	}
	if p, ok := e["discord"]; ok {
		if body.ExternalDiscordEnabled = &p.Enabled; *body.ExternalDiscordEnabled {
			body.ExternalDiscordClientId = &p.ClientId
			body.ExternalDiscordSecret = &p.Secret
		}
	}
	if p, ok := e["facebook"]; ok {
		if body.ExternalFacebookEnabled = &p.Enabled; *body.ExternalFacebookEnabled {
			body.ExternalFacebookClientId = &p.ClientId
			body.ExternalFacebookSecret = &p.Secret
		}
	}
	if p, ok := e["figma"]; ok {
		if body.ExternalFigmaEnabled = &p.Enabled; *body.ExternalFigmaEnabled {
			body.ExternalFigmaClientId = &p.ClientId
			body.ExternalFigmaSecret = &p.Secret
		}
	}
	if p, ok := e["github"]; ok {
		if body.ExternalGithubEnabled = &p.Enabled; *body.ExternalGithubEnabled {
			body.ExternalGithubClientId = &p.ClientId
			body.ExternalGithubSecret = &p.Secret
		}
	}
	if p, ok := e["gitlab"]; ok {
		if body.ExternalGitlabEnabled = &p.Enabled; *body.ExternalGitlabEnabled {
			body.ExternalGitlabClientId = &p.ClientId
			body.ExternalGitlabSecret = &p.Secret
			body.ExternalGitlabUrl = &p.Url
		}
	}
	if p, ok := e["google"]; ok {
		if body.ExternalGoogleEnabled = &p.Enabled; *body.ExternalGoogleEnabled {
			body.ExternalGoogleClientId = &p.ClientId
			body.ExternalGoogleSecret = &p.Secret
			body.ExternalGoogleSkipNonceCheck = &p.SkipNonceCheck
		}
	}
	if p, ok := e["kakao"]; ok {
		if body.ExternalKakaoEnabled = &p.Enabled; *body.ExternalKakaoEnabled {
			body.ExternalKakaoClientId = &p.ClientId
			body.ExternalKakaoSecret = &p.Secret
		}
	}
	if p, ok := e["keycloak"]; ok {
		if body.ExternalKeycloakEnabled = &p.Enabled; *body.ExternalKeycloakEnabled {
			body.ExternalKeycloakClientId = &p.ClientId
			body.ExternalKeycloakSecret = &p.Secret
			body.ExternalKeycloakUrl = &p.Url
		}
	}
	if p, ok := e["linkedin_oidc"]; ok {
		if body.ExternalLinkedinOidcEnabled = &p.Enabled; *body.ExternalLinkedinOidcEnabled {
			body.ExternalLinkedinOidcClientId = &p.ClientId
			body.ExternalLinkedinOidcSecret = &p.Secret
		}
	}
	if p, ok := e["notion"]; ok {
		if body.ExternalNotionEnabled = &p.Enabled; *body.ExternalNotionEnabled {
			body.ExternalNotionClientId = &p.ClientId
			body.ExternalNotionSecret = &p.Secret
		}
	}
	if p, ok := e["slack_oidc"]; ok {
		if body.ExternalSlackOidcEnabled = &p.Enabled; *body.ExternalSlackOidcEnabled {
			body.ExternalSlackOidcClientId = &p.ClientId
			body.ExternalSlackOidcSecret = &p.Secret
		}
	}
	if p, ok := e["spotify"]; ok {
		if body.ExternalSpotifyEnabled = &p.Enabled; *body.ExternalSpotifyEnabled {
			body.ExternalSpotifyClientId = &p.ClientId
			body.ExternalSpotifySecret = &p.Secret
		}
	}
	if p, ok := e["twitch"]; ok {
		if body.ExternalTwitchEnabled = &p.Enabled; *body.ExternalTwitchEnabled {
			body.ExternalTwitchClientId = &p.ClientId
			body.ExternalTwitchSecret = &p.Secret
		}
	}
	if p, ok := e["twitter"]; ok {
		if body.ExternalTwitterEnabled = &p.Enabled; *body.ExternalTwitterEnabled {
			body.ExternalTwitterClientId = &p.ClientId
			body.ExternalTwitterSecret = &p.Secret
		}
	}
	if p, ok := e["workos"]; ok {
		if body.ExternalWorkosEnabled = &p.Enabled; *body.ExternalWorkosEnabled {
			body.ExternalWorkosClientId = &p.ClientId
			body.ExternalWorkosSecret = &p.Secret
			body.ExternalWorkosUrl = &p.Url
		}
	}
	if p, ok := e["zoom"]; ok {
		if body.ExternalZoomEnabled = &p.Enabled; *body.ExternalZoomEnabled {
			body.ExternalZoomClientId = &p.ClientId
			body.ExternalZoomSecret = &p.Secret
		}
	}
}

func (e external) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	if len(e) == 0 {
		return
	}
	// Ignore configs of disabled providers because their envs are not loaded
	if p, ok := e["apple"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalAppleClientId, "")
			if ids := cast.Val(remoteConfig.ExternalAppleAdditionalClientIds, ""); len(ids) > 0 {
				p.ClientId += "," + ids
			}
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalAppleSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalAppleEnabled, false)
		e["apple"] = p
	}

	if p, ok := e["azure"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalAzureClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalAzureSecret, "")
			p.Url = cast.Val(remoteConfig.ExternalAzureUrl, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalAzureEnabled, false)
		e["azure"] = p
	}

	if p, ok := e["bitbucket"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalBitbucketClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalBitbucketSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalBitbucketEnabled, false)
		e["bitbucket"] = p
	}

	if p, ok := e["discord"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalDiscordClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalDiscordSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalDiscordEnabled, false)
		e["discord"] = p
	}

	if p, ok := e["facebook"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalFacebookClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalFacebookSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalFacebookEnabled, false)
		e["facebook"] = p
	}

	if p, ok := e["figma"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalFigmaClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalFigmaSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalFigmaEnabled, false)
		e["figma"] = p
	}

	if p, ok := e["github"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalGithubClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalGithubSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalGithubEnabled, false)
		e["github"] = p
	}

	if p, ok := e["gitlab"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalGitlabClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalGitlabSecret, "")
			p.Url = cast.Val(remoteConfig.ExternalGitlabUrl, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalGitlabEnabled, false)
		e["gitlab"] = p
	}

	if p, ok := e["google"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalGoogleClientId, "")
			if ids := cast.Val(remoteConfig.ExternalGoogleAdditionalClientIds, ""); len(ids) > 0 {
				p.ClientId += "," + ids
			}
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalGoogleSecret, "")
			p.SkipNonceCheck = cast.Val(remoteConfig.ExternalGoogleSkipNonceCheck, false)
		}
		p.Enabled = cast.Val(remoteConfig.ExternalGoogleEnabled, false)
		e["google"] = p
	}

	if p, ok := e["kakao"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalKakaoClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalKakaoSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalKakaoEnabled, false)
		e["kakao"] = p
	}

	if p, ok := e["keycloak"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalKeycloakClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalKeycloakSecret, "")
			p.Url = cast.Val(remoteConfig.ExternalKeycloakUrl, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalKeycloakEnabled, false)
		e["keycloak"] = p
	}

	if p, ok := e["linkedin_oidc"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalLinkedinOidcClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalLinkedinOidcSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalLinkedinOidcEnabled, false)
		e["linkedin_oidc"] = p
	}

	if p, ok := e["notion"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalNotionClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalNotionSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalNotionEnabled, false)
		e["notion"] = p
	}

	if p, ok := e["slack_oidc"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalSlackOidcClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalSlackOidcSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalSlackOidcEnabled, false)
		e["slack_oidc"] = p
	}

	if p, ok := e["spotify"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalSpotifyClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalSpotifySecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalSpotifyEnabled, false)
		e["spotify"] = p
	}

	if p, ok := e["twitch"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalTwitchClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalTwitchSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalTwitchEnabled, false)
		e["twitch"] = p
	}

	if p, ok := e["twitter"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalTwitterClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalTwitterSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalTwitterEnabled, false)
		e["twitter"] = p
	}

	if p, ok := e["workos"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalWorkosClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalWorkosSecret, "")
			p.Url = cast.Val(remoteConfig.ExternalWorkosUrl, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalWorkosEnabled, false)
		e["workos"] = p
	}

	if p, ok := e["zoom"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalZoomClientId, "")
			p.Secret = hashPrefix + cast.Val(remoteConfig.ExternalZoomSecret, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalZoomEnabled, false)
		e["zoom"] = p
	}
}

func (a *auth) DiffWithRemote(projectRef string, remoteConfig v1API.AuthConfigResponse) ([]byte, error) {
	copy := a.Clone()
	copy.HashSecrets(projectRef)
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	copy.FromRemoteAuthConfig(remoteConfig)
	remoteCompare, err := ToTomlBytes(copy)
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[auth]", remoteCompare, "local[auth]", currentValue), nil
}

const hashPrefix = "hash:"

func (a *auth) HashSecrets(key string) {
	hash := func(v string) string {
		if len(v) == 0 {
			return hashPrefix
		}
		return hashPrefix + sha256Hmac(key, v)
	}
	if a.Email.Smtp != nil && a.Email.Smtp.IsEnabled() {
		a.Email.Smtp.Pass = hash(a.Email.Smtp.Pass)
	}
	// Only hash secrets for locally enabled providers because other envs won't be loaded
	switch {
	case a.Sms.Twilio.Enabled:
		a.Sms.Twilio.AuthToken = hash(a.Sms.Twilio.AuthToken)
	case a.Sms.TwilioVerify.Enabled:
		a.Sms.TwilioVerify.AuthToken = hash(a.Sms.TwilioVerify.AuthToken)
	case a.Sms.Messagebird.Enabled:
		a.Sms.Messagebird.AccessKey = hash(a.Sms.Messagebird.AccessKey)
	case a.Sms.Textlocal.Enabled:
		a.Sms.Textlocal.ApiKey = hash(a.Sms.Textlocal.ApiKey)
	case a.Sms.Vonage.Enabled:
		a.Sms.Vonage.ApiSecret = hash(a.Sms.Vonage.ApiSecret)
	}
	if a.Hook.MFAVerificationAttempt != nil && a.Hook.MFAVerificationAttempt.Enabled {
		a.Hook.MFAVerificationAttempt.Secrets = hash(a.Hook.MFAVerificationAttempt.Secrets)
	}
	if a.Hook.PasswordVerificationAttempt != nil && a.Hook.PasswordVerificationAttempt.Enabled {
		a.Hook.PasswordVerificationAttempt.Secrets = hash(a.Hook.PasswordVerificationAttempt.Secrets)
	}
	if a.Hook.CustomAccessToken != nil && a.Hook.CustomAccessToken.Enabled {
		a.Hook.CustomAccessToken.Secrets = hash(a.Hook.CustomAccessToken.Secrets)
	}
	if a.Hook.SendSMS != nil && a.Hook.SendSMS.Enabled {
		a.Hook.SendSMS.Secrets = hash(a.Hook.SendSMS.Secrets)
	}
	if a.Hook.SendEmail != nil && a.Hook.SendEmail.Enabled {
		a.Hook.SendEmail.Secrets = hash(a.Hook.SendEmail.Secrets)
	}
	for name, provider := range a.External {
		if provider.Enabled {
			provider.Secret = hash(provider.Secret)
		}
		a.External[name] = provider
	}
	// TODO: support SecurityCaptchaSecret in local config
}
