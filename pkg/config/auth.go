package config

import (
	"strconv"
	"strings"
	"time"

	"github.com/go-errors/errors"
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

func (r *PasswordRequirements) UnmarshalText(text []byte) error {
	allowed := []PasswordRequirements{NoRequirements, LettersDigits, LowerUpperLettersDigits, LowerUpperLettersDigitsSymbols}
	if *r = PasswordRequirements(text); !sliceContains(allowed, *r) {
		return errors.Errorf("must be one of %v", allowed)
	}
	return nil
}

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

type CaptchaProvider string

const (
	HCaptchaProvider  CaptchaProvider = "hcaptcha"
	TurnstileProvider CaptchaProvider = "turnstile"
)

func (p *CaptchaProvider) UnmarshalText(text []byte) error {
	allowed := []CaptchaProvider{HCaptchaProvider, TurnstileProvider}
	if *p = CaptchaProvider(text); !sliceContains(allowed, *p) {
		return errors.Errorf("must be one of %v", allowed)
	}
	return nil
}

type (
	auth struct {
		Enabled bool   `toml:"enabled"`
		Image   string `toml:"-"`

		SiteUrl                    string               `toml:"site_url"`
		AdditionalRedirectUrls     []string             `toml:"additional_redirect_urls"`
		JwtExpiry                  uint                 `toml:"jwt_expiry"`
		EnableRefreshTokenRotation bool                 `toml:"enable_refresh_token_rotation"`
		RefreshTokenReuseInterval  uint                 `toml:"refresh_token_reuse_interval"`
		EnableManualLinking        bool                 `toml:"enable_manual_linking"`
		EnableSignup               bool                 `toml:"enable_signup"`
		EnableAnonymousSignIns     bool                 `toml:"enable_anonymous_sign_ins"`
		MinimumPasswordLength      uint                 `toml:"minimum_password_length"`
		PasswordRequirements       PasswordRequirements `toml:"password_requirements"`

		RateLimit rateLimit `toml:"rate_limit"`
		Captcha   *captcha  `toml:"captcha"`
		Hook      hook      `toml:"hook"`
		MFA       mfa       `toml:"mfa"`
		Sessions  sessions  `toml:"sessions"`
		Email     email     `toml:"email"`
		Sms       sms       `toml:"sms"`
		External  external  `toml:"external"`
		Web3      web3      `toml:"web3"`

		// Custom secrets can be injected from .env file
		JwtSecret      Secret `toml:"jwt_secret"`
		AnonKey        Secret `toml:"anon_key"`
		ServiceRoleKey Secret `toml:"service_role_key"`

		ThirdParty thirdParty `toml:"third_party"`
	}

	external map[string]provider

	thirdParty struct {
		Firebase tpaFirebase `toml:"firebase"`
		Auth0    tpaAuth0    `toml:"auth0"`
		Cognito  tpaCognito  `toml:"aws_cognito"`
		Clerk    tpaClerk    `toml:"clerk"`
	}

	rateLimit struct {
		AnonymousUsers     uint `toml:"anonymous_users"`
		TokenRefresh       uint `toml:"token_refresh"`
		SignInSignUps      uint `toml:"sign_in_sign_ups"`
		TokenVerifications uint `toml:"token_verifications"`
		EmailSent          uint `toml:"email_sent"`
		SmsSent            uint `toml:"sms_sent"`
		Web3               uint `toml:"web3"`
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

	tpaClerk struct {
		Enabled bool `toml:"enabled"`

		Domain string `toml:"domain"`
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
		Enabled    bool   `toml:"enabled"`
		Host       string `toml:"host"`
		Port       uint16 `toml:"port"`
		User       string `toml:"user"`
		Pass       Secret `toml:"pass"`
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
		Twilio              twilioConfig      `toml:"twilio"`
		TwilioVerify        twilioConfig      `toml:"twilio_verify"`
		Messagebird         messagebirdConfig `toml:"messagebird"`
		Textlocal           textlocalConfig   `toml:"textlocal"`
		Vonage              vonageConfig      `toml:"vonage"`
		TestOTP             map[string]string `toml:"test_otp"`
		MaxFrequency        time.Duration     `toml:"max_frequency"`
	}

	captcha struct {
		Enabled  bool            `toml:"enabled"`
		Provider CaptchaProvider `toml:"provider"`
		Secret   Secret          `toml:"secret"`
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
		Secrets Secret `toml:"secrets"`
	}

	sessions struct {
		Timebox           time.Duration `toml:"timebox"`
		InactivityTimeout time.Duration `toml:"inactivity_timeout"`
	}

	twilioConfig struct {
		Enabled           bool   `toml:"enabled"`
		AccountSid        string `toml:"account_sid"`
		MessageServiceSid string `toml:"message_service_sid"`
		AuthToken         Secret `toml:"auth_token"`
	}

	messagebirdConfig struct {
		Enabled    bool   `toml:"enabled"`
		Originator string `toml:"originator"`
		AccessKey  Secret `toml:"access_key"`
	}

	textlocalConfig struct {
		Enabled bool   `toml:"enabled"`
		Sender  string `toml:"sender"`
		ApiKey  Secret `toml:"api_key"`
	}

	vonageConfig struct {
		Enabled   bool   `toml:"enabled"`
		From      string `toml:"from"`
		ApiKey    string `toml:"api_key"`
		ApiSecret Secret `toml:"api_secret"`
	}

	provider struct {
		Enabled        bool   `toml:"enabled"`
		ClientId       string `toml:"client_id"`
		Secret         Secret `toml:"secret"`
		Url            string `toml:"url"`
		RedirectUri    string `toml:"redirect_uri"`
		SkipNonceCheck bool   `toml:"skip_nonce_check"`
	}

	solana struct {
		Enabled bool `toml:"enabled"`
	}

	web3 struct {
		Solana solana `toml:"solana"`
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
	// Add rate limit fields
	a.RateLimit.toAuthConfigBody(&body)
	if s := a.Email.Smtp; s != nil && s.Enabled {
		body.RateLimitEmailSent = cast.Ptr(cast.UintToInt(a.RateLimit.EmailSent))
	}
	// When local config is not set, we assume platform defaults should not change
	if a.Captcha != nil {
		a.Captcha.toAuthConfigBody(&body)
	}
	a.Hook.toAuthConfigBody(&body)
	a.MFA.toAuthConfigBody(&body)
	a.Sessions.toAuthConfigBody(&body)
	a.Email.toAuthConfigBody(&body)
	a.Sms.toAuthConfigBody(&body)
	a.External.toAuthConfigBody(&body)
	a.Web3.toAuthConfigBody(&body)
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
	a.RateLimit.fromAuthConfig(remoteConfig)
	if s := a.Email.Smtp; s != nil && s.Enabled {
		a.RateLimit.EmailSent = cast.IntToUint(cast.Val(remoteConfig.RateLimitEmailSent, 0))
	}
	a.Captcha.fromAuthConfig(remoteConfig)
	a.Hook.fromAuthConfig(remoteConfig)
	a.MFA.fromAuthConfig(remoteConfig)
	a.Sessions.fromAuthConfig(remoteConfig)
	a.Email.fromAuthConfig(remoteConfig)
	a.Sms.fromAuthConfig(remoteConfig)
	a.External.fromAuthConfig(remoteConfig)
	a.Web3.fromAuthConfig(remoteConfig)
}

func (r rateLimit) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.RateLimitAnonymousUsers = cast.Ptr(cast.UintToInt(r.AnonymousUsers))
	body.RateLimitTokenRefresh = cast.Ptr(cast.UintToInt(r.TokenRefresh))
	body.RateLimitOtp = cast.Ptr(cast.UintToInt(r.SignInSignUps))
	body.RateLimitVerify = cast.Ptr(cast.UintToInt(r.TokenVerifications))
	// Email rate limit is only updated when SMTP is enabled
	body.RateLimitSmsSent = cast.Ptr(cast.UintToInt(r.SmsSent))
	body.RateLimitWeb3 = cast.Ptr(cast.UintToInt(r.Web3))
}

func (r *rateLimit) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	r.AnonymousUsers = cast.IntToUint(cast.Val(remoteConfig.RateLimitAnonymousUsers, 0))
	r.TokenRefresh = cast.IntToUint(cast.Val(remoteConfig.RateLimitTokenRefresh, 0))
	r.SignInSignUps = cast.IntToUint(cast.Val(remoteConfig.RateLimitOtp, 0))
	r.TokenVerifications = cast.IntToUint(cast.Val(remoteConfig.RateLimitVerify, 0))
	// Email rate limit is only updated when SMTP is enabled
	r.SmsSent = cast.IntToUint(cast.Val(remoteConfig.RateLimitSmsSent, 0))
	r.Web3 = cast.IntToUint(cast.Val(remoteConfig.Web3, 0))
}

func (c captcha) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	if body.SecurityCaptchaEnabled = &c.Enabled; c.Enabled {
		body.SecurityCaptchaProvider = cast.Ptr(string(c.Provider))
		if len(c.Secret.SHA256) > 0 {
			body.SecurityCaptchaSecret = &c.Secret.Value
		}
	}
}

func (c *captcha) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	// When local config is not set, we assume platform defaults should not change
	if c == nil {
		return
	}
	// Ignore disabled captcha fields to minimise config diff
	if c.Enabled {
		c.Provider = CaptchaProvider(cast.Val(remoteConfig.SecurityCaptchaProvider, ""))
		if len(c.Secret.SHA256) > 0 {
			c.Secret.SHA256 = cast.Val(remoteConfig.SecurityCaptchaSecret, "")
		}
	}
	c.Enabled = cast.Val(remoteConfig.SecurityCaptchaEnabled, false)
}

func (h hook) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	// When local config is not set, we assume platform defaults should not change
	if hook := h.CustomAccessToken; hook != nil {
		if body.HookCustomAccessTokenEnabled = &hook.Enabled; hook.Enabled {
			body.HookCustomAccessTokenUri = &hook.URI
			if len(hook.Secrets.SHA256) > 0 {
				body.HookCustomAccessTokenSecrets = &hook.Secrets.Value
			}
		}
	}
	if hook := h.SendEmail; hook != nil {
		if body.HookSendEmailEnabled = &hook.Enabled; hook.Enabled {
			body.HookSendEmailUri = &hook.URI
			if len(hook.Secrets.SHA256) > 0 {
				body.HookSendEmailSecrets = &hook.Secrets.Value
			}
		}
	}
	if hook := h.SendSMS; hook != nil {
		if body.HookSendSmsEnabled = &hook.Enabled; hook.Enabled {
			body.HookSendSmsUri = &hook.URI
			if len(hook.Secrets.SHA256) > 0 {
				body.HookSendSmsSecrets = &hook.Secrets.Value
			}
		}
	}
	// Enterprise and team only features
	if hook := h.MFAVerificationAttempt; hook != nil {
		if body.HookMfaVerificationAttemptEnabled = &hook.Enabled; hook.Enabled {
			body.HookMfaVerificationAttemptUri = &hook.URI
			if len(hook.Secrets.SHA256) > 0 {
				body.HookMfaVerificationAttemptSecrets = &hook.Secrets.Value
			}
		}
	}
	if hook := h.PasswordVerificationAttempt; hook != nil {
		if body.HookPasswordVerificationAttemptEnabled = &hook.Enabled; hook.Enabled {
			body.HookPasswordVerificationAttemptUri = &hook.URI
			if len(hook.Secrets.SHA256) > 0 {
				body.HookPasswordVerificationAttemptSecrets = &hook.Secrets.Value
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
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = cast.Val(remoteConfig.HookCustomAccessTokenSecrets, "")
			}
		}
		hook.Enabled = cast.Val(remoteConfig.HookCustomAccessTokenEnabled, false)
	}
	if hook := h.SendEmail; hook != nil {
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookSendEmailUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = cast.Val(remoteConfig.HookSendEmailSecrets, "")
			}
		}
		hook.Enabled = cast.Val(remoteConfig.HookSendEmailEnabled, false)
	}
	if hook := h.SendSMS; hook != nil {
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookSendSmsUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = cast.Val(remoteConfig.HookSendSmsSecrets, "")
			}
		}
		hook.Enabled = cast.Val(remoteConfig.HookSendSmsEnabled, false)
	}
	// Enterprise and team only features
	if hook := h.MFAVerificationAttempt; hook != nil {
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookMfaVerificationAttemptUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = cast.Val(remoteConfig.HookMfaVerificationAttemptSecrets, "")
			}
		}
		hook.Enabled = cast.Val(remoteConfig.HookMfaVerificationAttemptEnabled, false)
	}
	if hook := h.PasswordVerificationAttempt; hook != nil {
		if hook.Enabled {
			hook.URI = cast.Val(remoteConfig.HookPasswordVerificationAttemptUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = cast.Val(remoteConfig.HookPasswordVerificationAttemptSecrets, "")
			}
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
	body.SessionsTimebox = cast.Ptr(int(s.Timebox.Hours()))
	body.SessionsInactivityTimeout = cast.Ptr(int(s.InactivityTimeout.Hours()))
}

func (s *sessions) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	s.Timebox = time.Duration(cast.Val(remoteConfig.SessionsTimebox, 0)) * time.Hour
	s.InactivityTimeout = time.Duration(cast.Val(remoteConfig.SessionsInactivityTimeout, 0)) * time.Hour
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
	e.Smtp.fromAuthConfig(remoteConfig)
	if len(e.Template) == 0 {
		return
	}
	if t, ok := e.Template["invite"]; ok {
		if t.Subject != nil {
			t.Subject = remoteConfig.MailerSubjectsInvite
		}
		if t.Content != nil {
			t.Content = remoteConfig.MailerTemplatesInviteContent
		}
		e.Template["invite"] = t
	}
	if t, ok := e.Template["confirmation"]; ok {
		if t.Subject != nil {
			t.Subject = remoteConfig.MailerSubjectsConfirmation
		}
		if t.Content != nil {
			t.Content = remoteConfig.MailerTemplatesConfirmationContent
		}
		e.Template["confirmation"] = t
	}
	if t, ok := e.Template["recovery"]; ok {
		if t.Subject != nil {
			t.Subject = remoteConfig.MailerSubjectsRecovery
		}
		if t.Content != nil {
			t.Content = remoteConfig.MailerTemplatesRecoveryContent
		}
		e.Template["recovery"] = t
	}
	if t, ok := e.Template["magic_link"]; ok {
		if t.Subject != nil {
			t.Subject = remoteConfig.MailerSubjectsMagicLink
		}
		if t.Content != nil {
			t.Content = remoteConfig.MailerTemplatesMagicLinkContent
		}
		e.Template["magic_link"] = t
	}
	if t, ok := e.Template["email_change"]; ok {
		if t.Subject != nil {
			t.Subject = remoteConfig.MailerSubjectsEmailChange
		}
		if t.Content != nil {
			t.Content = remoteConfig.MailerTemplatesEmailChangeContent
		}
		e.Template["email_change"] = t
	}
	if t, ok := e.Template["reauthentication"]; ok {
		if t.Subject != nil {
			t.Subject = remoteConfig.MailerSubjectsReauthentication
		}
		if t.Content != nil {
			t.Content = remoteConfig.MailerTemplatesReauthenticationContent
		}
		e.Template["reauthentication"] = t
	}
}

func (s smtp) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	if !s.Enabled {
		// Setting a single empty string disables SMTP
		body.SmtpHost = cast.Ptr("")
		return
	}
	body.SmtpHost = &s.Host
	body.SmtpPort = cast.Ptr(strconv.Itoa(int(s.Port)))
	body.SmtpUser = &s.User
	if len(s.Pass.SHA256) > 0 {
		body.SmtpPass = &s.Pass.Value
	}
	body.SmtpAdminEmail = &s.AdminEmail
	body.SmtpSenderName = &s.SenderName
}

func (s *smtp) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	// When local config is not set, we assume platform defaults should not change
	if s == nil {
		return
	}
	if s.Enabled {
		s.Host = cast.Val(remoteConfig.SmtpHost, "")
		s.User = cast.Val(remoteConfig.SmtpUser, "")
		if len(s.Pass.SHA256) > 0 {
			s.Pass.SHA256 = cast.Val(remoteConfig.SmtpPass, "")
		}
		s.AdminEmail = cast.Val(remoteConfig.SmtpAdminEmail, "")
		s.SenderName = cast.Val(remoteConfig.SmtpSenderName, "")
		portStr := cast.Val(remoteConfig.SmtpPort, "0")
		if port, err := strconv.ParseUint(portStr, 10, 16); err == nil {
			s.Port = uint16(port)
		}
	}
	// Api resets all values when SMTP is disabled
	s.Enabled = remoteConfig.SmtpHost != nil
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
		if len(s.Twilio.AuthToken.SHA256) > 0 {
			body.SmsTwilioAuthToken = &s.Twilio.AuthToken.Value
		}
		body.SmsTwilioAccountSid = &s.Twilio.AccountSid
		body.SmsTwilioMessageServiceSid = &s.Twilio.MessageServiceSid
	case s.TwilioVerify.Enabled:
		body.SmsProvider = cast.Ptr("twilio_verify")
		if len(s.TwilioVerify.AuthToken.SHA256) > 0 {
			body.SmsTwilioVerifyAuthToken = &s.TwilioVerify.AuthToken.Value
		}
		body.SmsTwilioVerifyAccountSid = &s.TwilioVerify.AccountSid
		body.SmsTwilioVerifyMessageServiceSid = &s.TwilioVerify.MessageServiceSid
	case s.Messagebird.Enabled:
		body.SmsProvider = cast.Ptr("messagebird")
		if len(s.Messagebird.AccessKey.SHA256) > 0 {
			body.SmsMessagebirdAccessKey = &s.Messagebird.AccessKey.Value
		}
		body.SmsMessagebirdOriginator = &s.Messagebird.Originator
	case s.Textlocal.Enabled:
		body.SmsProvider = cast.Ptr("textlocal")
		if len(s.Textlocal.ApiKey.SHA256) > 0 {
			body.SmsTextlocalApiKey = &s.Textlocal.ApiKey.Value
		}
		body.SmsTextlocalSender = &s.Textlocal.Sender
	case s.Vonage.Enabled:
		body.SmsProvider = cast.Ptr("vonage")
		if len(s.Vonage.ApiSecret.SHA256) > 0 {
			body.SmsVonageApiSecret = &s.Vonage.ApiSecret.Value
		}
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
		if len(s.Twilio.AuthToken.SHA256) > 0 {
			s.Twilio.AuthToken.SHA256 = cast.Val(remoteConfig.SmsTwilioAuthToken, "")
		}
		s.Twilio.AccountSid = cast.Val(remoteConfig.SmsTwilioAccountSid, "")
		s.Twilio.MessageServiceSid = cast.Val(remoteConfig.SmsTwilioMessageServiceSid, "")
	case s.TwilioVerify.Enabled:
		if len(s.TwilioVerify.AuthToken.SHA256) > 0 {
			s.TwilioVerify.AuthToken.SHA256 = cast.Val(remoteConfig.SmsTwilioVerifyAuthToken, "")
		}
		s.TwilioVerify.AccountSid = cast.Val(remoteConfig.SmsTwilioVerifyAccountSid, "")
		s.TwilioVerify.MessageServiceSid = cast.Val(remoteConfig.SmsTwilioVerifyMessageServiceSid, "")
	case s.Messagebird.Enabled:
		if len(s.Messagebird.AccessKey.SHA256) > 0 {
			s.Messagebird.AccessKey.SHA256 = cast.Val(remoteConfig.SmsMessagebirdAccessKey, "")
		}
		s.Messagebird.Originator = cast.Val(remoteConfig.SmsMessagebirdOriginator, "")
	case s.Textlocal.Enabled:
		if len(s.Textlocal.ApiKey.SHA256) > 0 {
			s.Textlocal.ApiKey.SHA256 = cast.Val(remoteConfig.SmsTextlocalApiKey, "")
		}
		s.Textlocal.Sender = cast.Val(remoteConfig.SmsTextlocalSender, "")
	case s.Vonage.Enabled:
		if len(s.Vonage.ApiSecret.SHA256) > 0 {
			s.Vonage.ApiSecret.SHA256 = cast.Val(remoteConfig.SmsVonageApiSecret, "")
		}
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
			if len(p.Secret.SHA256) > 0 {
				body.ExternalAppleSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["azure"]; ok {
		if body.ExternalAzureEnabled = &p.Enabled; *body.ExternalAzureEnabled {
			body.ExternalAzureClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalAzureSecret = &p.Secret.Value
			}
			body.ExternalAzureUrl = &p.Url
		}
	}
	if p, ok := e["bitbucket"]; ok {
		if body.ExternalBitbucketEnabled = &p.Enabled; *body.ExternalBitbucketEnabled {
			body.ExternalBitbucketClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalBitbucketSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["discord"]; ok {
		if body.ExternalDiscordEnabled = &p.Enabled; *body.ExternalDiscordEnabled {
			body.ExternalDiscordClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalDiscordSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["facebook"]; ok {
		if body.ExternalFacebookEnabled = &p.Enabled; *body.ExternalFacebookEnabled {
			body.ExternalFacebookClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalFacebookSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["figma"]; ok {
		if body.ExternalFigmaEnabled = &p.Enabled; *body.ExternalFigmaEnabled {
			body.ExternalFigmaClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalFigmaSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["github"]; ok {
		if body.ExternalGithubEnabled = &p.Enabled; *body.ExternalGithubEnabled {
			body.ExternalGithubClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalGithubSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["gitlab"]; ok {
		if body.ExternalGitlabEnabled = &p.Enabled; *body.ExternalGitlabEnabled {
			body.ExternalGitlabClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalGitlabSecret = &p.Secret.Value
			}
			body.ExternalGitlabUrl = &p.Url
		}
	}
	if p, ok := e["google"]; ok {
		if body.ExternalGoogleEnabled = &p.Enabled; *body.ExternalGoogleEnabled {
			body.ExternalGoogleClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalGoogleSecret = &p.Secret.Value
			}
			body.ExternalGoogleSkipNonceCheck = &p.SkipNonceCheck
		}
	}
	if p, ok := e["kakao"]; ok {
		if body.ExternalKakaoEnabled = &p.Enabled; *body.ExternalKakaoEnabled {
			body.ExternalKakaoClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalKakaoSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["keycloak"]; ok {
		if body.ExternalKeycloakEnabled = &p.Enabled; *body.ExternalKeycloakEnabled {
			body.ExternalKeycloakClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalKeycloakSecret = &p.Secret.Value
			}
			body.ExternalKeycloakUrl = &p.Url
		}
	}
	if p, ok := e["linkedin_oidc"]; ok {
		if body.ExternalLinkedinOidcEnabled = &p.Enabled; *body.ExternalLinkedinOidcEnabled {
			body.ExternalLinkedinOidcClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalLinkedinOidcSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["notion"]; ok {
		if body.ExternalNotionEnabled = &p.Enabled; *body.ExternalNotionEnabled {
			body.ExternalNotionClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalNotionSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["slack_oidc"]; ok {
		if body.ExternalSlackOidcEnabled = &p.Enabled; *body.ExternalSlackOidcEnabled {
			body.ExternalSlackOidcClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalSlackOidcSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["spotify"]; ok {
		if body.ExternalSpotifyEnabled = &p.Enabled; *body.ExternalSpotifyEnabled {
			body.ExternalSpotifyClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalSpotifySecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["twitch"]; ok {
		if body.ExternalTwitchEnabled = &p.Enabled; *body.ExternalTwitchEnabled {
			body.ExternalTwitchClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalTwitchSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["twitter"]; ok {
		if body.ExternalTwitterEnabled = &p.Enabled; *body.ExternalTwitterEnabled {
			body.ExternalTwitterClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalTwitterSecret = &p.Secret.Value
			}
		}
	}
	if p, ok := e["workos"]; ok {
		if body.ExternalWorkosEnabled = &p.Enabled; *body.ExternalWorkosEnabled {
			body.ExternalWorkosClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalWorkosSecret = &p.Secret.Value
			}
			body.ExternalWorkosUrl = &p.Url
		}
	}
	if p, ok := e["zoom"]; ok {
		if body.ExternalZoomEnabled = &p.Enabled; *body.ExternalZoomEnabled {
			body.ExternalZoomClientId = &p.ClientId
			if len(p.Secret.SHA256) > 0 {
				body.ExternalZoomSecret = &p.Secret.Value
			}
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
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalAppleSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalAppleEnabled, false)
		e["apple"] = p
	}

	if p, ok := e["azure"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalAzureClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalAzureSecret, "")
			}
			p.Url = cast.Val(remoteConfig.ExternalAzureUrl, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalAzureEnabled, false)
		e["azure"] = p
	}

	if p, ok := e["bitbucket"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalBitbucketClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalBitbucketSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalBitbucketEnabled, false)
		e["bitbucket"] = p
	}

	if p, ok := e["discord"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalDiscordClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalDiscordSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalDiscordEnabled, false)
		e["discord"] = p
	}

	if p, ok := e["facebook"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalFacebookClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalFacebookSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalFacebookEnabled, false)
		e["facebook"] = p
	}

	if p, ok := e["figma"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalFigmaClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalFigmaSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalFigmaEnabled, false)
		e["figma"] = p
	}

	if p, ok := e["github"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalGithubClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalGithubSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalGithubEnabled, false)
		e["github"] = p
	}

	if p, ok := e["gitlab"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalGitlabClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalGitlabSecret, "")
			}
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
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalGoogleSecret, "")
			}
			p.SkipNonceCheck = cast.Val(remoteConfig.ExternalGoogleSkipNonceCheck, false)
		}
		p.Enabled = cast.Val(remoteConfig.ExternalGoogleEnabled, false)
		e["google"] = p
	}

	if p, ok := e["kakao"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalKakaoClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalKakaoSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalKakaoEnabled, false)
		e["kakao"] = p
	}

	if p, ok := e["keycloak"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalKeycloakClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalKeycloakSecret, "")
			}
			p.Url = cast.Val(remoteConfig.ExternalKeycloakUrl, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalKeycloakEnabled, false)
		e["keycloak"] = p
	}

	if p, ok := e["linkedin_oidc"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalLinkedinOidcClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalLinkedinOidcSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalLinkedinOidcEnabled, false)
		e["linkedin_oidc"] = p
	}

	if p, ok := e["notion"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalNotionClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalNotionSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalNotionEnabled, false)
		e["notion"] = p
	}

	if p, ok := e["slack_oidc"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalSlackOidcClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalSlackOidcSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalSlackOidcEnabled, false)
		e["slack_oidc"] = p
	}

	if p, ok := e["spotify"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalSpotifyClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalSpotifySecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalSpotifyEnabled, false)
		e["spotify"] = p
	}

	if p, ok := e["twitch"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalTwitchClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalTwitchSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalTwitchEnabled, false)
		e["twitch"] = p
	}

	if p, ok := e["twitter"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalTwitterClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalTwitterSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalTwitterEnabled, false)
		e["twitter"] = p
	}

	if p, ok := e["workos"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalWorkosClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalWorkosSecret, "")
			}
			p.Url = cast.Val(remoteConfig.ExternalWorkosUrl, "")
		}
		p.Enabled = cast.Val(remoteConfig.ExternalWorkosEnabled, false)
		e["workos"] = p
	}

	if p, ok := e["zoom"]; ok {
		if p.Enabled {
			p.ClientId = cast.Val(remoteConfig.ExternalZoomClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = cast.Val(remoteConfig.ExternalZoomSecret, "")
			}
		}
		p.Enabled = cast.Val(remoteConfig.ExternalZoomEnabled, false)
		e["zoom"] = p
	}
}

func (a *auth) DiffWithRemote(remoteConfig v1API.AuthConfigResponse) ([]byte, error) {
	copy := a.Clone()
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

func (w web3) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	w.solana.toAuthConfigBody(body)
}

func (w *web3) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	w.solana.fromAuthConfig(remoteConfig)
}

func (s solana) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.ExternalWeb3SolanaEnabled = s.Enabled
}

func (s *solana) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	s.Enabled = remoteConfig.ExternalWeb3SolanaEnabled
}
