package config

import (
	"strconv"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/oapi-codegen/nullable"
	openapi_types "github.com/oapi-codegen/runtime/types"
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
		return v1API.UpdateAuthConfigBodyPasswordRequiredCharactersAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
	case LowerUpperLettersDigits:
		return v1API.UpdateAuthConfigBodyPasswordRequiredCharactersAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567891
	case LowerUpperLettersDigitsSymbols:
		return v1API.UpdateAuthConfigBodyPasswordRequiredCharactersAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567892
	}
	return v1API.UpdateAuthConfigBodyPasswordRequiredCharactersEmpty
}

func NewPasswordRequirement(c v1API.UpdateAuthConfigBodyPasswordRequiredCharacters) PasswordRequirements {
	switch c {
	case v1API.UpdateAuthConfigBodyPasswordRequiredCharactersAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:
		return LettersDigits
	case v1API.UpdateAuthConfigBodyPasswordRequiredCharactersAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567891:
		return LowerUpperLettersDigits
	case v1API.UpdateAuthConfigBodyPasswordRequiredCharactersAbcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ01234567892:
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
		Enabled    bool                `toml:"enabled"`
		Host       string              `toml:"host"`
		Port       uint16              `toml:"port"`
		User       string              `toml:"user"`
		Pass       Secret              `toml:"pass"`
		AdminEmail openapi_types.Email `toml:"admin_email"`
		SenderName string              `toml:"sender_name"`
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
		BeforeUserCreated           *hookConfig `toml:"before_user_created"`
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
		SiteUrl:                           nullable.NewNullableWithValue(a.SiteUrl),
		UriAllowList:                      nullable.NewNullableWithValue(strings.Join(a.AdditionalRedirectUrls, ",")),
		JwtExp:                            nullable.NewNullableWithValue(cast.UintToInt(a.JwtExpiry)),
		RefreshTokenRotationEnabled:       nullable.NewNullableWithValue(a.EnableRefreshTokenRotation),
		SecurityRefreshTokenReuseInterval: nullable.NewNullableWithValue(cast.UintToInt(a.RefreshTokenReuseInterval)),
		SecurityManualLinkingEnabled:      nullable.NewNullableWithValue(a.EnableManualLinking),
		DisableSignup:                     nullable.NewNullableWithValue(!a.EnableSignup),
		ExternalAnonymousUsersEnabled:     nullable.NewNullableWithValue(a.EnableAnonymousSignIns),
		PasswordMinLength:                 nullable.NewNullableWithValue(cast.UintToInt(a.MinimumPasswordLength)),
		PasswordRequiredCharacters:        nullable.NewNullableWithValue(a.PasswordRequirements.ToChar()),
	}
	// Add rate limit fields
	a.RateLimit.toAuthConfigBody(&body)
	if s := a.Email.Smtp; s != nil && s.Enabled {
		body.RateLimitEmailSent = nullable.NewNullableWithValue(cast.UintToInt(a.RateLimit.EmailSent))
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
	a.SiteUrl = ValOrDefault(remoteConfig.SiteUrl, "")
	a.AdditionalRedirectUrls = strToArr(ValOrDefault(remoteConfig.UriAllowList, ""))
	a.JwtExpiry = cast.IntToUint(ValOrDefault(remoteConfig.JwtExp, 0))
	a.EnableRefreshTokenRotation = ValOrDefault(remoteConfig.RefreshTokenRotationEnabled, false)
	a.RefreshTokenReuseInterval = cast.IntToUint(ValOrDefault(remoteConfig.SecurityRefreshTokenReuseInterval, 0))
	a.EnableManualLinking = ValOrDefault(remoteConfig.SecurityManualLinkingEnabled, false)
	a.EnableSignup = !ValOrDefault(remoteConfig.DisableSignup, false)
	a.EnableAnonymousSignIns = ValOrDefault(remoteConfig.ExternalAnonymousUsersEnabled, false)
	a.MinimumPasswordLength = cast.IntToUint(ValOrDefault(remoteConfig.PasswordMinLength, 0))
	prc := ValOrDefault(remoteConfig.PasswordRequiredCharacters, "")
	a.PasswordRequirements = NewPasswordRequirement(v1API.UpdateAuthConfigBodyPasswordRequiredCharacters(prc))
	a.RateLimit.fromAuthConfig(remoteConfig)
	if s := a.Email.Smtp; s != nil && s.Enabled {
		a.RateLimit.EmailSent = cast.IntToUint(ValOrDefault(remoteConfig.RateLimitEmailSent, 0))
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
	body.RateLimitAnonymousUsers = nullable.NewNullableWithValue(cast.UintToInt(r.AnonymousUsers))
	body.RateLimitTokenRefresh = nullable.NewNullableWithValue(cast.UintToInt(r.TokenRefresh))
	body.RateLimitOtp = nullable.NewNullableWithValue(cast.UintToInt(r.SignInSignUps))
	body.RateLimitVerify = nullable.NewNullableWithValue(cast.UintToInt(r.TokenVerifications))
	// Email rate limit is only updated when SMTP is enabled
	body.RateLimitSmsSent = nullable.NewNullableWithValue(cast.UintToInt(r.SmsSent))
	body.RateLimitWeb3 = nullable.NewNullableWithValue((cast.UintToInt(r.Web3)))
}

func (r *rateLimit) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	r.AnonymousUsers = cast.IntToUint(ValOrDefault(remoteConfig.RateLimitAnonymousUsers, 0))
	r.TokenRefresh = cast.IntToUint(ValOrDefault(remoteConfig.RateLimitTokenRefresh, 0))
	r.SignInSignUps = cast.IntToUint(ValOrDefault(remoteConfig.RateLimitOtp, 0))
	r.TokenVerifications = cast.IntToUint(ValOrDefault(remoteConfig.RateLimitVerify, 0))
	// Email rate limit is only updated when SMTP is enabled
	r.SmsSent = cast.IntToUint(ValOrDefault(remoteConfig.RateLimitSmsSent, 0))
	r.Web3 = cast.IntToUint(ValOrDefault(remoteConfig.RateLimitWeb3, 0))
}

func (c captcha) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	if body.SecurityCaptchaEnabled = nullable.NewNullableWithValue(c.Enabled); c.Enabled {
		body.SecurityCaptchaProvider = nullable.NewNullableWithValue(v1API.UpdateAuthConfigBodySecurityCaptchaProvider(c.Provider))
		if len(c.Secret.SHA256) > 0 {
			body.SecurityCaptchaSecret = nullable.NewNullableWithValue(c.Secret.Value)
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
		c.Provider = CaptchaProvider(ValOrDefault(remoteConfig.SecurityCaptchaProvider, ""))
		if len(c.Secret.SHA256) > 0 {
			c.Secret.SHA256 = ValOrDefault(remoteConfig.SecurityCaptchaSecret, "")
		}
	}
	c.Enabled = ValOrDefault(remoteConfig.SecurityCaptchaEnabled, false)
}

func (h hook) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	// When local config is not set, we assume platform defaults should not change
	if hook := h.BeforeUserCreated; hook != nil {
		if body.HookBeforeUserCreatedEnabled = nullable.NewNullableWithValue(hook.Enabled); hook.Enabled {
			body.HookBeforeUserCreatedUri = nullable.NewNullableWithValue(hook.URI)
			if len(hook.Secrets.SHA256) > 0 {
				body.HookBeforeUserCreatedSecrets = nullable.NewNullableWithValue(hook.Secrets.Value)
			}
		}
	}
	if hook := h.CustomAccessToken; hook != nil {
		if body.HookCustomAccessTokenEnabled = nullable.NewNullableWithValue(hook.Enabled); hook.Enabled {
			body.HookCustomAccessTokenUri = nullable.NewNullableWithValue(hook.URI)
			if len(hook.Secrets.SHA256) > 0 {
				body.HookCustomAccessTokenSecrets = nullable.NewNullableWithValue(hook.Secrets.Value)
			}
		}
	}
	if hook := h.SendEmail; hook != nil {
		if body.HookSendEmailEnabled = nullable.NewNullableWithValue(hook.Enabled); hook.Enabled {
			body.HookSendEmailUri = nullable.NewNullableWithValue(hook.URI)
			if len(hook.Secrets.SHA256) > 0 {
				body.HookSendEmailSecrets = nullable.NewNullableWithValue(hook.Secrets.Value)
			}
		}
	}
	if hook := h.SendSMS; hook != nil {
		if body.HookSendSmsEnabled = nullable.NewNullableWithValue(hook.Enabled); hook.Enabled {
			body.HookSendSmsUri = nullable.NewNullableWithValue(hook.URI)
			if len(hook.Secrets.SHA256) > 0 {
				body.HookSendSmsSecrets = nullable.NewNullableWithValue(hook.Secrets.Value)
			}
		}
	}
	// Enterprise and team only features
	if hook := h.MFAVerificationAttempt; hook != nil {
		if body.HookMfaVerificationAttemptEnabled = nullable.NewNullableWithValue(hook.Enabled); hook.Enabled {
			body.HookMfaVerificationAttemptUri = nullable.NewNullableWithValue(hook.URI)
			if len(hook.Secrets.SHA256) > 0 {
				body.HookMfaVerificationAttemptSecrets = nullable.NewNullableWithValue(hook.Secrets.Value)
			}
		}
	}
	if hook := h.PasswordVerificationAttempt; hook != nil {
		if body.HookPasswordVerificationAttemptEnabled = nullable.NewNullableWithValue(hook.Enabled); hook.Enabled {
			body.HookPasswordVerificationAttemptUri = nullable.NewNullableWithValue(hook.URI)
			if len(hook.Secrets.SHA256) > 0 {
				body.HookPasswordVerificationAttemptSecrets = nullable.NewNullableWithValue(hook.Secrets.Value)
			}
		}
	}
}
func (h *hook) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	// When local config is not set, we assume platform defaults should not change
	if hook := h.BeforeUserCreated; hook != nil {
		// Ignore disabled hooks because their envs are not loaded
		if hook.Enabled {
			hook.URI = ValOrDefault(remoteConfig.HookBeforeUserCreatedUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = ValOrDefault(remoteConfig.HookBeforeUserCreatedSecrets, "")
			}
		}
		hook.Enabled = ValOrDefault(remoteConfig.HookBeforeUserCreatedEnabled, false)
	}
	if hook := h.CustomAccessToken; hook != nil {
		// Ignore disabled hooks because their envs are not loaded
		if hook.Enabled {
			hook.URI = ValOrDefault(remoteConfig.HookCustomAccessTokenUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = ValOrDefault(remoteConfig.HookCustomAccessTokenSecrets, "")
			}
		}
		hook.Enabled = ValOrDefault(remoteConfig.HookCustomAccessTokenEnabled, false)
	}
	if hook := h.SendEmail; hook != nil {
		if hook.Enabled {
			hook.URI = ValOrDefault(remoteConfig.HookSendEmailUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = ValOrDefault(remoteConfig.HookSendEmailSecrets, "")
			}
		}
		hook.Enabled = ValOrDefault(remoteConfig.HookSendEmailEnabled, false)
	}
	if hook := h.SendSMS; hook != nil {
		if hook.Enabled {
			hook.URI = ValOrDefault(remoteConfig.HookSendSmsUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = ValOrDefault(remoteConfig.HookSendSmsSecrets, "")
			}
		}
		hook.Enabled = ValOrDefault(remoteConfig.HookSendSmsEnabled, false)
	}
	// Enterprise and team only features
	if hook := h.MFAVerificationAttempt; hook != nil {
		if hook.Enabled {
			hook.URI = ValOrDefault(remoteConfig.HookMfaVerificationAttemptUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = ValOrDefault(remoteConfig.HookMfaVerificationAttemptSecrets, "")
			}
		}
		hook.Enabled = ValOrDefault(remoteConfig.HookMfaVerificationAttemptEnabled, false)
	}
	if hook := h.PasswordVerificationAttempt; hook != nil {
		if hook.Enabled {
			hook.URI = ValOrDefault(remoteConfig.HookPasswordVerificationAttemptUri, "")
			if len(hook.Secrets.SHA256) > 0 {
				hook.Secrets.SHA256 = ValOrDefault(remoteConfig.HookPasswordVerificationAttemptSecrets, "")
			}
		}
		hook.Enabled = ValOrDefault(remoteConfig.HookPasswordVerificationAttemptEnabled, false)
	}
}

func (m mfa) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.MfaMaxEnrolledFactors = nullable.NewNullableWithValue(cast.UintToInt(m.MaxEnrolledFactors))
	body.MfaTotpEnrollEnabled = nullable.NewNullableWithValue(m.TOTP.EnrollEnabled)
	body.MfaTotpVerifyEnabled = nullable.NewNullableWithValue(m.TOTP.VerifyEnabled)
	body.MfaPhoneEnrollEnabled = nullable.NewNullableWithValue(m.Phone.EnrollEnabled)
	body.MfaPhoneVerifyEnabled = nullable.NewNullableWithValue(m.Phone.VerifyEnabled)
	body.MfaPhoneOtpLength = nullable.NewNullableWithValue(cast.UintToInt(m.Phone.OtpLength))
	body.MfaPhoneTemplate = nullable.NewNullableWithValue(m.Phone.Template)
	body.MfaPhoneMaxFrequency = nullable.NewNullableWithValue(int(m.Phone.MaxFrequency.Seconds()))
	body.MfaWebAuthnEnrollEnabled = nullable.NewNullableWithValue(m.WebAuthn.EnrollEnabled)
	body.MfaWebAuthnVerifyEnabled = nullable.NewNullableWithValue(m.WebAuthn.VerifyEnabled)
}

func (m *mfa) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	m.MaxEnrolledFactors = cast.IntToUint(ValOrDefault(remoteConfig.MfaMaxEnrolledFactors, 0))
	m.TOTP.EnrollEnabled = ValOrDefault(remoteConfig.MfaTotpEnrollEnabled, false)
	m.TOTP.VerifyEnabled = ValOrDefault(remoteConfig.MfaTotpVerifyEnabled, false)
	m.Phone.EnrollEnabled = ValOrDefault(remoteConfig.MfaPhoneEnrollEnabled, false)
	m.Phone.VerifyEnabled = ValOrDefault(remoteConfig.MfaPhoneVerifyEnabled, false)
	m.Phone.OtpLength = cast.IntToUint(remoteConfig.MfaPhoneOtpLength)
	m.Phone.Template = ValOrDefault(remoteConfig.MfaPhoneTemplate, "")
	m.Phone.MaxFrequency = time.Duration(ValOrDefault(remoteConfig.MfaPhoneMaxFrequency, 0)) * time.Second
	m.WebAuthn.EnrollEnabled = ValOrDefault(remoteConfig.MfaWebAuthnEnrollEnabled, false)
	m.WebAuthn.VerifyEnabled = ValOrDefault(remoteConfig.MfaWebAuthnVerifyEnabled, false)
}

func (s sessions) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.SessionsTimebox = nullable.NewNullableWithValue(int(s.Timebox.Hours()))
	body.SessionsInactivityTimeout = nullable.NewNullableWithValue(int(s.InactivityTimeout.Hours()))
}

func (s *sessions) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	s.Timebox = time.Duration(ValOrDefault(remoteConfig.SessionsTimebox, 0)) * time.Hour
	s.InactivityTimeout = time.Duration(ValOrDefault(remoteConfig.SessionsInactivityTimeout, 0)) * time.Hour
}

func (e email) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.ExternalEmailEnabled = nullable.NewNullableWithValue(e.EnableSignup)
	body.MailerSecureEmailChangeEnabled = nullable.NewNullableWithValue(e.DoubleConfirmChanges)
	body.MailerAutoconfirm = nullable.NewNullableWithValue(!e.EnableConfirmations)
	body.MailerOtpLength = nullable.NewNullableWithValue(cast.UintToInt(e.OtpLength))
	body.MailerOtpExp = cast.UintToIntPtr(&e.OtpExpiry)
	body.SecurityUpdatePasswordRequireReauthentication = nullable.NewNullableWithValue(e.SecurePasswordChange)
	body.SmtpMaxFrequency = nullable.NewNullableWithValue(int(e.MaxFrequency.Seconds()))
	// When local config is not set, we assume platform defaults should not change
	if e.Smtp != nil {
		e.Smtp.toAuthConfigBody(body)
	}
	if len(e.Template) == 0 {
		return
	}
	var tmpl *emailTemplate
	tmpl = cast.Ptr(e.Template["invite"])
	if tmpl.Subject != nil {
		body.MailerSubjectsInvite = nullable.NewNullableWithValue(*tmpl.Subject)
	}
	if tmpl.Content != nil {
		body.MailerTemplatesInviteContent = nullable.NewNullableWithValue(*tmpl.Content)
	}
	tmpl = cast.Ptr(e.Template["confirmation"])
	if tmpl.Subject != nil {
		body.MailerSubjectsConfirmation = nullable.NewNullableWithValue(*tmpl.Subject)
	}
	if tmpl.Content != nil {
		body.MailerTemplatesConfirmationContent = nullable.NewNullableWithValue(*tmpl.Content)
	}
	tmpl = cast.Ptr(e.Template["recovery"])
	if tmpl.Subject != nil {
		body.MailerSubjectsRecovery = nullable.NewNullableWithValue(*tmpl.Subject)
	}
	if tmpl.Content != nil {
		body.MailerTemplatesRecoveryContent = nullable.NewNullableWithValue(*tmpl.Content)
	}
	tmpl = cast.Ptr(e.Template["magic_link"])
	if tmpl.Subject != nil {
		body.MailerSubjectsMagicLink = nullable.NewNullableWithValue(*tmpl.Subject)
	}
	if tmpl.Content != nil {
		body.MailerTemplatesMagicLinkContent = nullable.NewNullableWithValue(*tmpl.Content)
	}
	tmpl = cast.Ptr(e.Template["email_change"])
	if tmpl.Subject != nil {
		body.MailerSubjectsEmailChange = nullable.NewNullableWithValue(*tmpl.Subject)
	}
	if tmpl.Content != nil {
		body.MailerTemplatesEmailChangeContent = nullable.NewNullableWithValue(*tmpl.Content)
	}
	tmpl = cast.Ptr(e.Template["reauthentication"])
	if tmpl.Subject != nil {
		body.MailerSubjectsReauthentication = nullable.NewNullableWithValue(*tmpl.Subject)
	}
	if tmpl.Content != nil {
		body.MailerTemplatesReauthenticationContent = nullable.NewNullableWithValue(*tmpl.Content)
	}
}

func (e *email) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	e.EnableSignup = ValOrDefault(remoteConfig.ExternalEmailEnabled, false)
	e.DoubleConfirmChanges = ValOrDefault(remoteConfig.MailerSecureEmailChangeEnabled, false)
	e.EnableConfirmations = !ValOrDefault(remoteConfig.MailerAutoconfirm, false)
	e.OtpLength = cast.IntToUint(ValOrDefault(remoteConfig.MailerOtpLength, 0))
	e.OtpExpiry = cast.IntToUint(remoteConfig.MailerOtpExp)
	e.SecurePasswordChange = ValOrDefault(remoteConfig.SecurityUpdatePasswordRequireReauthentication, false)
	e.MaxFrequency = time.Duration(ValOrDefault(remoteConfig.SmtpMaxFrequency, 0)) * time.Second
	e.Smtp.fromAuthConfig(remoteConfig)
	if len(e.Template) == 0 {
		return
	}
	if t, ok := e.Template["invite"]; ok {
		if t.Subject != nil {
			if value, err := remoteConfig.MailerSubjectsInvite.Get(); err == nil {
				t.Subject = &value
			} else {
				t.Subject = nil
			}
		}
		if t.Content != nil {
			if value, err := remoteConfig.MailerTemplatesInviteContent.Get(); err == nil {
				t.Content = &value
			} else {
				t.Content = nil
			}
		}
		e.Template["invite"] = t
	}
	if t, ok := e.Template["confirmation"]; ok {
		if t.Subject != nil {
			if value, err := remoteConfig.MailerSubjectsConfirmation.Get(); err == nil {
				t.Subject = &value
			} else {
				t.Subject = nil
			}
		}
		if t.Content != nil {
			if value, err := remoteConfig.MailerTemplatesConfirmationContent.Get(); err == nil {
				t.Content = &value
			} else {
				t.Content = nil
			}
		}
		e.Template["confirmation"] = t
	}
	if t, ok := e.Template["recovery"]; ok {
		if t.Subject != nil {
			if value, err := remoteConfig.MailerSubjectsRecovery.Get(); err == nil {
				t.Subject = &value
			} else {
				t.Subject = nil
			}
		}
		if t.Content != nil {
			if value, err := remoteConfig.MailerTemplatesRecoveryContent.Get(); err == nil {
				t.Content = &value
			} else {
				t.Content = nil
			}
		}
		e.Template["recovery"] = t
	}
	if t, ok := e.Template["magic_link"]; ok {
		if t.Subject != nil {
			if value, err := remoteConfig.MailerSubjectsMagicLink.Get(); err == nil {
				t.Subject = &value
			} else {
				t.Subject = nil
			}
		}
		if t.Content != nil {
			if value, err := remoteConfig.MailerTemplatesMagicLinkContent.Get(); err == nil {
				t.Content = &value
			} else {
				t.Content = nil
			}
		}
		e.Template["magic_link"] = t
	}
	if t, ok := e.Template["email_change"]; ok {
		if t.Subject != nil {
			if value, err := remoteConfig.MailerSubjectsEmailChange.Get(); err == nil {
				t.Subject = &value
			} else {
				t.Subject = nil
			}
		}
		if t.Content != nil {
			if value, err := remoteConfig.MailerTemplatesEmailChangeContent.Get(); err == nil {
				t.Content = &value
			} else {
				t.Content = nil
			}
		}
		e.Template["email_change"] = t
	}
	if t, ok := e.Template["reauthentication"]; ok {
		if t.Subject != nil {
			if value, err := remoteConfig.MailerSubjectsReauthentication.Get(); err == nil {
				t.Subject = &value
			} else {
				t.Subject = nil
			}
		}
		if t.Content != nil {
			if value, err := remoteConfig.MailerTemplatesReauthenticationContent.Get(); err == nil {
				t.Content = &value
			} else {
				t.Content = nil
			}
		}
		e.Template["reauthentication"] = t
	}
}

func (s smtp) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	if !s.Enabled {
		// Setting a single empty string disables SMTP
		body.SmtpHost = nullable.NewNullableWithValue("")
		return
	}
	body.SmtpHost = nullable.NewNullableWithValue(s.Host)
	body.SmtpPort = nullable.NewNullableWithValue(strconv.Itoa(int(s.Port)))
	body.SmtpUser = nullable.NewNullableWithValue(s.User)
	if len(s.Pass.SHA256) > 0 {
		body.SmtpPass = nullable.NewNullableWithValue(s.Pass.Value)
	}
	body.SmtpAdminEmail = nullable.NewNullableWithValue(s.AdminEmail)
	body.SmtpSenderName = nullable.NewNullableWithValue(s.SenderName)
}

func (s *smtp) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	// When local config is not set, we assume platform defaults should not change
	if s == nil {
		return
	}
	if s.Enabled {
		s.Host = ValOrDefault(remoteConfig.SmtpHost, "")
		s.User = ValOrDefault(remoteConfig.SmtpUser, "")
		if len(s.Pass.SHA256) > 0 {
			s.Pass.SHA256 = ValOrDefault(remoteConfig.SmtpPass, "")
		}
		s.AdminEmail = ValOrDefault(remoteConfig.SmtpAdminEmail, openapi_types.Email(""))
		s.SenderName = ValOrDefault(remoteConfig.SmtpSenderName, "")
		portStr := ValOrDefault(remoteConfig.SmtpPort, "0")
		if port, err := strconv.ParseUint(portStr, 10, 16); err == nil {
			s.Port = uint16(port)
		}
	}
	// Api resets all values when SMTP is disabled
	s.Enabled = remoteConfig.SmtpHost != nil
}

func (s sms) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.ExternalPhoneEnabled = nullable.NewNullableWithValue(s.EnableSignup)
	body.SmsMaxFrequency = nullable.NewNullableWithValue(int(s.MaxFrequency.Seconds()))
	body.SmsAutoconfirm = nullable.NewNullableWithValue(s.EnableConfirmations)
	body.SmsTemplate = nullable.NewNullableWithValue(s.Template)
	if otpString := mapToEnv(s.TestOTP); len(otpString) > 0 {
		body.SmsTestOtp = nullable.NewNullableWithValue(otpString)
		// Set a 10 year validity for test OTP
		timestamp := time.Now().UTC().AddDate(10, 0, 0)
		body.SmsTestOtpValidUntil = nullable.NewNullableWithValue(timestamp)
	}
	// Api only overrides configs of enabled providers
	switch {
	case s.Twilio.Enabled:
		body.SmsProvider = nullable.NewNullableWithValue(v1API.UpdateAuthConfigBodySmsProviderTwilio)
		if len(s.Twilio.AuthToken.SHA256) > 0 {
			body.SmsTwilioAuthToken = nullable.NewNullableWithValue(s.Twilio.AuthToken.Value)
		}
		body.SmsTwilioAccountSid = nullable.NewNullableWithValue(s.Twilio.AccountSid)
		body.SmsTwilioMessageServiceSid = nullable.NewNullableWithValue(s.Twilio.MessageServiceSid)
	case s.TwilioVerify.Enabled:
		body.SmsProvider = nullable.NewNullableWithValue(v1API.UpdateAuthConfigBodySmsProviderTwilioVerify)
		if len(s.TwilioVerify.AuthToken.SHA256) > 0 {
			body.SmsTwilioVerifyAuthToken = nullable.NewNullableWithValue(s.TwilioVerify.AuthToken.Value)
		}
		body.SmsTwilioVerifyAccountSid = nullable.NewNullableWithValue(s.TwilioVerify.AccountSid)
		body.SmsTwilioVerifyMessageServiceSid = nullable.NewNullableWithValue(s.TwilioVerify.MessageServiceSid)
	case s.Messagebird.Enabled:
		body.SmsProvider = nullable.NewNullableWithValue(v1API.UpdateAuthConfigBodySmsProviderMessagebird)
		if len(s.Messagebird.AccessKey.SHA256) > 0 {
			body.SmsMessagebirdAccessKey = nullable.NewNullableWithValue(s.Messagebird.AccessKey.Value)
		}
		body.SmsMessagebirdOriginator = nullable.NewNullableWithValue(s.Messagebird.Originator)
	case s.Textlocal.Enabled:
		body.SmsProvider = nullable.NewNullableWithValue(v1API.UpdateAuthConfigBodySmsProviderTextlocal)
		if len(s.Textlocal.ApiKey.SHA256) > 0 {
			body.SmsTextlocalApiKey = nullable.NewNullableWithValue(s.Textlocal.ApiKey.Value)
		}
		body.SmsTextlocalSender = nullable.NewNullableWithValue(s.Textlocal.Sender)
	case s.Vonage.Enabled:
		body.SmsProvider = nullable.NewNullableWithValue(v1API.UpdateAuthConfigBodySmsProviderVonage)
		if len(s.Vonage.ApiSecret.SHA256) > 0 {
			body.SmsVonageApiSecret = nullable.NewNullableWithValue(s.Vonage.ApiSecret.Value)
		}
		body.SmsVonageApiKey = nullable.NewNullableWithValue(s.Vonage.ApiKey)
		body.SmsVonageFrom = nullable.NewNullableWithValue(s.Vonage.From)
	}
}

func (s *sms) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	s.EnableSignup = ValOrDefault(remoteConfig.ExternalPhoneEnabled, false)
	s.MaxFrequency = time.Duration(ValOrDefault(remoteConfig.SmsMaxFrequency, 0)) * time.Second
	s.EnableConfirmations = ValOrDefault(remoteConfig.SmsAutoconfirm, false)
	s.Template = ValOrDefault(remoteConfig.SmsTemplate, "")
	s.TestOTP = envToMap(ValOrDefault(remoteConfig.SmsTestOtp, ""))
	// We are only interested in the provider that's enabled locally
	switch {
	case s.Twilio.Enabled:
		if len(s.Twilio.AuthToken.SHA256) > 0 {
			s.Twilio.AuthToken.SHA256 = ValOrDefault(remoteConfig.SmsTwilioAuthToken, "")
		}
		s.Twilio.AccountSid = ValOrDefault(remoteConfig.SmsTwilioAccountSid, "")
		s.Twilio.MessageServiceSid = ValOrDefault(remoteConfig.SmsTwilioMessageServiceSid, "")
	case s.TwilioVerify.Enabled:
		if len(s.TwilioVerify.AuthToken.SHA256) > 0 {
			s.TwilioVerify.AuthToken.SHA256 = ValOrDefault(remoteConfig.SmsTwilioVerifyAuthToken, "")
		}
		s.TwilioVerify.AccountSid = ValOrDefault(remoteConfig.SmsTwilioVerifyAccountSid, "")
		s.TwilioVerify.MessageServiceSid = ValOrDefault(remoteConfig.SmsTwilioVerifyMessageServiceSid, "")
	case s.Messagebird.Enabled:
		if len(s.Messagebird.AccessKey.SHA256) > 0 {
			s.Messagebird.AccessKey.SHA256 = ValOrDefault(remoteConfig.SmsMessagebirdAccessKey, "")
		}
		s.Messagebird.Originator = ValOrDefault(remoteConfig.SmsMessagebirdOriginator, "")
	case s.Textlocal.Enabled:
		if len(s.Textlocal.ApiKey.SHA256) > 0 {
			s.Textlocal.ApiKey.SHA256 = ValOrDefault(remoteConfig.SmsTextlocalApiKey, "")
		}
		s.Textlocal.Sender = ValOrDefault(remoteConfig.SmsTextlocalSender, "")
	case s.Vonage.Enabled:
		if len(s.Vonage.ApiSecret.SHA256) > 0 {
			s.Vonage.ApiSecret.SHA256 = ValOrDefault(remoteConfig.SmsVonageApiSecret, "")
		}
		s.Vonage.ApiKey = ValOrDefault(remoteConfig.SmsVonageApiKey, "")
		s.Vonage.From = ValOrDefault(remoteConfig.SmsVonageFrom, "")
	case !s.EnableSignup:
		// Nothing to do if both local and remote providers are disabled.
		return
	}
	if provider := ValOrDefault(remoteConfig.SmsProvider, ""); len(provider) > 0 {
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
		if body.ExternalAppleEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalAppleClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalAppleSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["azure"]; ok {
		if body.ExternalAzureEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalAzureClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalAzureSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
			body.ExternalAzureUrl = nullable.NewNullableWithValue(p.Url)
		}
	}
	if p, ok := e["bitbucket"]; ok {
		if body.ExternalBitbucketEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalBitbucketClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalBitbucketSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["discord"]; ok {
		if body.ExternalDiscordEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalDiscordClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalDiscordSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["facebook"]; ok {
		if body.ExternalFacebookEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalFacebookClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalFacebookSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["figma"]; ok {
		if body.ExternalFigmaEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalFigmaClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalFigmaSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["github"]; ok {
		if body.ExternalGithubEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalGithubClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalGithubSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["gitlab"]; ok {
		if body.ExternalGitlabEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalGitlabClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalGitlabSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
			body.ExternalGitlabUrl = nullable.NewNullableWithValue(p.Url)
		}
	}
	if p, ok := e["google"]; ok {
		if body.ExternalGoogleEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalGoogleClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalGoogleSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
			body.ExternalGoogleSkipNonceCheck = nullable.NewNullableWithValue(p.SkipNonceCheck)
		}
	}
	if p, ok := e["kakao"]; ok {
		if body.ExternalKakaoEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalKakaoClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalKakaoSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["keycloak"]; ok {
		if body.ExternalKeycloakEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalKeycloakClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalKeycloakSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
			body.ExternalKeycloakUrl = nullable.NewNullableWithValue(p.Url)
		}
	}
	if p, ok := e["linkedin_oidc"]; ok {
		if body.ExternalLinkedinOidcEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalLinkedinOidcClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalLinkedinOidcSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["notion"]; ok {
		if body.ExternalNotionEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalNotionClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalNotionSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["slack_oidc"]; ok {
		if body.ExternalSlackOidcEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalSlackOidcClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalSlackOidcSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["spotify"]; ok {
		if body.ExternalSpotifyEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalSpotifyClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalSpotifySecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["twitch"]; ok {
		if body.ExternalTwitchEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalTwitchClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalTwitchSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["twitter"]; ok {
		if body.ExternalTwitterEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalTwitterClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalTwitterSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
		}
	}
	if p, ok := e["workos"]; ok {
		if body.ExternalWorkosEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalWorkosClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalWorkosSecret = nullable.NewNullableWithValue(p.Secret.Value)
			}
			body.ExternalWorkosUrl = nullable.NewNullableWithValue(p.Url)
		}
	}
	if p, ok := e["zoom"]; ok {
		if body.ExternalZoomEnabled = nullable.NewNullableWithValue(p.Enabled); p.Enabled {
			body.ExternalZoomClientId = nullable.NewNullableWithValue(p.ClientId)
			if len(p.Secret.SHA256) > 0 {
				body.ExternalZoomSecret = nullable.NewNullableWithValue(p.Secret.Value)
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
			p.ClientId = ValOrDefault(remoteConfig.ExternalAppleClientId, "")
			if ids := ValOrDefault(remoteConfig.ExternalAppleAdditionalClientIds, ""); len(ids) > 0 {
				p.ClientId += "," + ids
			}
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalAppleSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalAppleEnabled, false)
		e["apple"] = p
	}

	if p, ok := e["azure"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalAzureClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalAzureSecret, "")
			}
			p.Url = ValOrDefault(remoteConfig.ExternalAzureUrl, "")
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalAzureEnabled, false)
		e["azure"] = p
	}

	if p, ok := e["bitbucket"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalBitbucketClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalBitbucketSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalBitbucketEnabled, false)
		e["bitbucket"] = p
	}

	if p, ok := e["discord"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalDiscordClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalDiscordSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalDiscordEnabled, false)
		e["discord"] = p
	}

	if p, ok := e["facebook"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalFacebookClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalFacebookSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalFacebookEnabled, false)
		e["facebook"] = p
	}

	if p, ok := e["figma"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalFigmaClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalFigmaSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalFigmaEnabled, false)
		e["figma"] = p
	}

	if p, ok := e["github"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalGithubClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalGithubSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalGithubEnabled, false)
		e["github"] = p
	}

	if p, ok := e["gitlab"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalGitlabClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalGitlabSecret, "")
			}
			p.Url = ValOrDefault(remoteConfig.ExternalGitlabUrl, "")
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalGitlabEnabled, false)
		e["gitlab"] = p
	}

	if p, ok := e["google"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalGoogleClientId, "")
			if ids := ValOrDefault(remoteConfig.ExternalGoogleAdditionalClientIds, ""); len(ids) > 0 {
				p.ClientId += "," + ids
			}
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalGoogleSecret, "")
			}
			p.SkipNonceCheck = ValOrDefault(remoteConfig.ExternalGoogleSkipNonceCheck, false)
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalGoogleEnabled, false)
		e["google"] = p
	}

	if p, ok := e["kakao"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalKakaoClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalKakaoSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalKakaoEnabled, false)
		e["kakao"] = p
	}

	if p, ok := e["keycloak"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalKeycloakClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalKeycloakSecret, "")
			}
			p.Url = ValOrDefault(remoteConfig.ExternalKeycloakUrl, "")
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalKeycloakEnabled, false)
		e["keycloak"] = p
	}

	if p, ok := e["linkedin_oidc"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalLinkedinOidcClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalLinkedinOidcSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalLinkedinOidcEnabled, false)
		e["linkedin_oidc"] = p
	}

	if p, ok := e["notion"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalNotionClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalNotionSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalNotionEnabled, false)
		e["notion"] = p
	}

	if p, ok := e["slack_oidc"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalSlackOidcClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalSlackOidcSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalSlackOidcEnabled, false)
		e["slack_oidc"] = p
	}

	if p, ok := e["spotify"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalSpotifyClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalSpotifySecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalSpotifyEnabled, false)
		e["spotify"] = p
	}

	if p, ok := e["twitch"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalTwitchClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalTwitchSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalTwitchEnabled, false)
		e["twitch"] = p
	}

	if p, ok := e["twitter"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalTwitterClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalTwitterSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalTwitterEnabled, false)
		e["twitter"] = p
	}

	if p, ok := e["workos"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalWorkosClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalWorkosSecret, "")
			}
			p.Url = ValOrDefault(remoteConfig.ExternalWorkosUrl, "")
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalWorkosEnabled, false)
		e["workos"] = p
	}

	if p, ok := e["zoom"]; ok {
		if p.Enabled {
			p.ClientId = ValOrDefault(remoteConfig.ExternalZoomClientId, "")
			if len(p.Secret.SHA256) > 0 {
				p.Secret.SHA256 = ValOrDefault(remoteConfig.ExternalZoomSecret, "")
			}
		}
		p.Enabled = ValOrDefault(remoteConfig.ExternalZoomEnabled, false)
		e["zoom"] = p
	}
}

func (w web3) toAuthConfigBody(body *v1API.UpdateAuthConfigBody) {
	body.ExternalWeb3SolanaEnabled = nullable.NewNullableWithValue(w.Solana.Enabled)
}

func (w *web3) fromAuthConfig(remoteConfig v1API.AuthConfigResponse) {
	if value, err := remoteConfig.ExternalWeb3SolanaEnabled.Get(); err == nil {
		w.Solana.Enabled = value
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

func ValOrDefault[T any](v nullable.Nullable[T], def T) T {
	if value, err := v.Get(); err == nil {
		return value
	}
	return def
}
