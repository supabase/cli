package config

import (
	"strings"
	"time"

	v1API "github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/cast"
	"github.com/supabase/cli/pkg/diff"
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

		EnableSignup           bool                `toml:"enable_signup"`
		EnableAnonymousSignIns bool                `toml:"enable_anonymous_sign_ins"`
		Email                  email               `toml:"email"`
		Sms                    sms                 `toml:"sms"`
		External               map[string]provider `toml:"external"`

		// Custom secrets can be injected from .env file
		JwtSecret      string `toml:"-" mapstructure:"jwt_secret"`
		AnonKey        string `toml:"-" mapstructure:"anon_key"`
		ServiceRoleKey string `toml:"-" mapstructure:"service_role_key"`

		ThirdParty thirdParty `toml:"third_party"`
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
		MFAVerificationAttempt      hookConfig `toml:"mfa_verification_attempt"`
		PasswordVerificationAttempt hookConfig `toml:"password_verification_attempt"`
		CustomAccessToken           hookConfig `toml:"custom_access_token"`
		SendSMS                     hookConfig `toml:"send_sms"`
		SendEmail                   hookConfig `toml:"send_email"`
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
	}
	return body
}

func (a *auth) fromRemoteAuthConfig(remoteConfig v1API.AuthConfigResponse) auth {
	result := *a
	result.SiteUrl = cast.Val(remoteConfig.SiteUrl, "")
	result.AdditionalRedirectUrls = strToArr(cast.Val(remoteConfig.UriAllowList, ""))
	result.JwtExpiry = cast.IntToUint(cast.Val(remoteConfig.JwtExp, 0))
	result.EnableRefreshTokenRotation = cast.Val(remoteConfig.RefreshTokenRotationEnabled, false)
	result.RefreshTokenReuseInterval = cast.IntToUint(cast.Val(remoteConfig.SecurityRefreshTokenReuseInterval, 0))
	result.EnableManualLinking = cast.Val(remoteConfig.SecurityManualLinkingEnabled, false)
	result.EnableSignup = !cast.Val(remoteConfig.DisableSignup, false)
	result.EnableAnonymousSignIns = cast.Val(remoteConfig.ExternalAnonymousUsersEnabled, false)
	return result
}

func (a *auth) DiffWithRemote(remoteConfig v1API.AuthConfigResponse) ([]byte, error) {
	// Convert the config values into easily comparable remoteConfig values
	currentValue, err := ToTomlBytes(a)
	if err != nil {
		return nil, err
	}
	remoteCompare, err := ToTomlBytes(a.fromRemoteAuthConfig(remoteConfig))
	if err != nil {
		return nil, err
	}
	return diff.Diff("remote[auth]", remoteCompare, "local[auth]", currentValue), nil
}
