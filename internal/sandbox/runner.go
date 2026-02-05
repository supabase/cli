package sandbox

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"text/template"
	"time"

	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/process-compose.yaml.tmpl
var processComposeTemplate string

// OAuthProviderConfig holds configuration for an OAuth provider.
type OAuthProviderConfig struct {
	Name           string
	Enabled        bool
	ClientId       string
	Secret         string
	RedirectUri    string
	Url            string
	SkipNonceCheck bool
	EmailOptional  bool
}

// processComposeConfig holds the template variables for process-compose.yaml generation.
type processComposeConfig struct {
	LogLocation        string
	PostgresPort       int
	DbPassword         string
	DbSchemas          string
	DbExtraSearchPath  string
	DbMaxRows          uint
	APIPort            int
	GoTruePort         int
	PostgRESTPort      int
	PostgRESTAdminPort int
	GotruePath         string
	PostgrestPath      string

	// Native PostgreSQL configuration
	PostgresBinDir        string // Path to postgres bin directory
	PostgresDataDir       string // Path to pgdata directory
	PostgresLibDir        string // Path to postgres lib directory (for DYLD_LIBRARY_PATH)
	PostgresMigrateScript string // Path to bundled migrate.sh

	// Proxy configuration
	SupabaseBin    string
	ServiceRoleKey string
	ServiceRoleJWT string
	AnonKey        string
	AnonJWT        string

	// JWT configuration
	JwtSecret     string
	JwtExpiry     uint
	JwtIssuer     string
	JwtKeys       string
	JwtMethods    string
	PostgRESTJwks string // JWKS for PostgREST JWT verification

	// Site configuration
	SiteUrl                string
	AdditionalRedirectUrls string
	EnableSignup           bool

	// Email/Mailer configuration
	EmailEnabled            bool
	MailerAutoconfirm       bool
	MailerSecureEmailChange bool
	MailerOtpLength         uint
	MailerOtpExp            uint
	SmtpMaxFrequency        time.Duration
	MailerUrlPathsInvite    string
	MailerUrlPathsConfirm   string
	MailerUrlPathsRecovery  string
	MailerUrlPathsChange    string
	RateLimitEmailSent      uint

	// SMTP configuration
	SmtpEnabled    bool
	SmtpHost       string
	SmtpPort       uint16
	SmtpUser       string
	SmtpPass       string
	SmtpAdminEmail string
	SmtpSenderName string

	// Phone/SMS configuration
	PhoneEnabled    bool
	SmsAutoconfirm  bool
	SmsMaxFrequency time.Duration
	SmsTemplate     string
	SmsTestOtp      string

	// SMS Providers
	SmsTwilioEnabled       bool
	SmsTwilioAccountSid    string
	SmsTwilioAuthToken     string
	SmsTwilioMsgSvcSid     string
	SmsTwilioVerifyEnabled bool
	SmsTwilioVerifyAcctSid string
	SmsTwilioVerifyToken   string
	SmsTwilioVerifyMsgSid  string
	SmsMessagebirdEnabled  bool
	SmsMessagebirdKey      string
	SmsMessagebirdOrig     string
	SmsTextlocalEnabled    bool
	SmsTextlocalApiKey     string
	SmsTextlocalSender     string
	SmsVonageEnabled       bool
	SmsVonageApiKey        string
	SmsVonageApiSecret     string
	SmsVonageFrom          string

	// Anonymous users
	EnableAnonymousSignIns bool

	// Password configuration
	PasswordMinLength    uint
	PasswordRequirements string

	// Security configuration
	RefreshTokenRotation      bool
	RefreshTokenReuseInterval uint
	ManualLinkingEnabled      bool
	SecurePasswordChange      bool

	// Captcha configuration
	CaptchaEnabled  bool
	CaptchaProvider string
	CaptchaSecret   string

	// MFA configuration
	MfaPhoneEnrollEnabled    bool
	MfaPhoneVerifyEnabled    bool
	MfaTotpEnrollEnabled     bool
	MfaTotpVerifyEnabled     bool
	MfaWebAuthnEnrollEnabled bool
	MfaWebAuthnVerifyEnabled bool
	MfaMaxEnrolledFactors    uint
	MfaPhoneTemplate         string
	MfaPhoneOtpLength        uint
	MfaPhoneMaxFrequency     time.Duration

	// Rate limits
	RateLimitAnonymousUsers uint
	RateLimitTokenRefresh   uint
	RateLimitOtp            uint
	RateLimitVerify         uint
	RateLimitSmsSent        uint
	RateLimitWeb3           uint

	// Sessions
	SessionsTimebox           time.Duration
	SessionsInactivityTimeout time.Duration

	// Web3
	Web3SolanaEnabled   bool
	Web3EthereumEnabled bool

	// OAuth providers
	OAuthProviders []OAuthProviderConfig

	// Hooks
	HookMfaVerificationEnabled      bool
	HookMfaVerificationUri          string
	HookMfaVerificationSecrets      string
	HookPasswordVerificationEnabled bool
	HookPasswordVerificationUri     string
	HookPasswordVerificationSecrets string
	HookCustomAccessTokenEnabled    bool
	HookCustomAccessTokenUri        string
	HookCustomAccessTokenSecrets    string
	HookSendSmsEnabled              bool
	HookSendSmsUri                  string
	HookSendSmsSecrets              string
	HookSendEmailEnabled            bool
	HookSendEmailUri                string
	HookSendEmailSecrets            string
	HookBeforeUserCreatedEnabled    bool
	HookBeforeUserCreatedUri        string
	HookBeforeUserCreatedSecrets    string

	// OAuth Server
	OAuthServerEnabled           bool
	OAuthServerAuthorizationPath string
	OAuthServerAllowDynamicReg   bool
}

// GenerateProcessComposeConfig generates the process-compose.yaml from the template.
func GenerateProcessComposeConfig(goCtx context.Context, ctx *SandboxContext, postgresVersion string) (string, error) {
	// Create template with custom functions
	funcMap := template.FuncMap{
		"upper": strings.ToUpper,
	}
	tmpl, err := template.New("process-compose").Funcs(funcMap).Parse(processComposeTemplate)
	if err != nil {
		return "", fmt.Errorf("failed to parse process-compose template: %w", err)
	}

	// Build test OTP map for SMS in envconfig format: "phone1:otp1,phone2:otp2"
	var testOTPParts []string
	for phone, otp := range utils.Config.Auth.Sms.TestOTP {
		testOTPParts = append(testOTPParts, phone+":"+otp)
	}
	testOTPEnvConfig := strings.Join(testOTPParts, ",")

	// Serialise signing keys
	var jwtKeys, jwtMethods string
	if keys, err := json.Marshal(utils.Config.Auth.SigningKeys); err == nil {
		jwtKeys = string(keys)
		jwtMethods = "HS256,RS256,ES256"
	}

	// Resolve JWKS for PostgREST (includes both signing keys and fallback to JWT secret)
	postgRESTJwks, err := utils.Config.Auth.ResolveJWKS(goCtx)
	if err != nil {
		return "", fmt.Errorf("failed to resolve JWKS: %w", err)
	}

	// Build OAuth providers list
	var oauthProviders []OAuthProviderConfig
	for name, config := range utils.Config.Auth.External {
		redirectUri := config.RedirectUri
		if redirectUri == "" {
			redirectUri = utils.Config.Auth.JwtIssuer + "/callback"
		}
		oauthProviders = append(oauthProviders, OAuthProviderConfig{
			Name:           name,
			Enabled:        config.Enabled,
			ClientId:       config.ClientId,
			Secret:         config.Secret.Value,
			RedirectUri:    redirectUri,
			Url:            config.Url,
			SkipNonceCheck: config.SkipNonceCheck,
			EmailOptional:  config.EmailOptional,
		})
	}

	// Determine SMTP configuration
	var smtpEnabled bool
	var smtpHost string
	var smtpPort uint16
	var smtpUser, smtpPass, smtpAdminEmail, smtpSenderName string
	var rateLimitEmailSent uint = 360000 // default

	if utils.Config.Auth.Email.Smtp != nil && utils.Config.Auth.Email.Smtp.Enabled {
		smtpEnabled = true
		smtpHost = utils.Config.Auth.Email.Smtp.Host
		smtpPort = utils.Config.Auth.Email.Smtp.Port
		smtpUser = utils.Config.Auth.Email.Smtp.User
		smtpPass = utils.Config.Auth.Email.Smtp.Pass.Value
		smtpAdminEmail = string(utils.Config.Auth.Email.Smtp.AdminEmail)
		smtpSenderName = utils.Config.Auth.Email.Smtp.SenderName
		rateLimitEmailSent = utils.Config.Auth.RateLimit.EmailSent
	}

	// Build postgres paths
	postgresDir := GetPostgresDir(ctx.BinDir, postgresVersion)

	data := processComposeConfig{
		LogLocation:        filepath.Join(ctx.LogDir(), "process-compose.log"),
		PostgresPort:       ctx.Ports.Postgres,
		DbPassword:         utils.Config.Db.Password,
		DbSchemas:          strings.Join(utils.Config.Api.Schemas, ","),
		DbExtraSearchPath:  strings.Join(utils.Config.Api.ExtraSearchPath, ","),
		DbMaxRows:          utils.Config.Api.MaxRows,
		APIPort:            ctx.Ports.API,
		GoTruePort:         ctx.Ports.GoTrue,
		PostgRESTPort:      ctx.Ports.PostgREST,
		PostgRESTAdminPort: ctx.Ports.PostgRESTAdmin,
		GotruePath:         GetGotruePath(ctx.BinDir),
		PostgrestPath:      GetPostgrestPath(ctx.BinDir),

		// Native PostgreSQL configuration
		PostgresBinDir:        filepath.Join(postgresDir, "bin"),
		PostgresDataDir:       ctx.PgDataDir(),
		PostgresLibDir:        filepath.Join(postgresDir, "lib"),
		PostgresMigrateScript: filepath.Join(postgresDir, "share", "supabase-cli", "migrations", "migrate.sh"),

		// Proxy configuration - use absolute path to handle --workdir flag
		SupabaseBin:    getExecutablePath(),
		ServiceRoleKey: utils.Config.Auth.SecretKey.Value,
		ServiceRoleJWT: utils.Config.Auth.ServiceRoleKey.Value,
		AnonKey:        utils.Config.Auth.PublishableKey.Value,
		AnonJWT:        utils.Config.Auth.AnonKey.Value,

		// JWT configuration
		JwtSecret:     utils.Config.Auth.JwtSecret.Value,
		JwtExpiry:     utils.Config.Auth.JwtExpiry,
		JwtIssuer:     utils.Config.Auth.JwtIssuer,
		JwtKeys:       jwtKeys,
		JwtMethods:    jwtMethods,
		PostgRESTJwks: postgRESTJwks,

		// Site configuration
		SiteUrl:                utils.Config.Auth.SiteUrl,
		AdditionalRedirectUrls: strings.Join(utils.Config.Auth.AdditionalRedirectUrls, ","),
		EnableSignup:           utils.Config.Auth.EnableSignup,

		// Email/Mailer configuration
		EmailEnabled:            utils.Config.Auth.Email.EnableSignup,
		MailerAutoconfirm:       !utils.Config.Auth.Email.EnableConfirmations,
		MailerSecureEmailChange: utils.Config.Auth.Email.DoubleConfirmChanges,
		MailerOtpLength:         utils.Config.Auth.Email.OtpLength,
		MailerOtpExp:            utils.Config.Auth.Email.OtpExpiry,
		SmtpMaxFrequency:        utils.Config.Auth.Email.MaxFrequency,
		MailerUrlPathsInvite:    utils.Config.Auth.JwtIssuer + "/verify",
		MailerUrlPathsConfirm:   utils.Config.Auth.JwtIssuer + "/verify",
		MailerUrlPathsRecovery:  utils.Config.Auth.JwtIssuer + "/verify",
		MailerUrlPathsChange:    utils.Config.Auth.JwtIssuer + "/verify",
		RateLimitEmailSent:      rateLimitEmailSent,

		// SMTP configuration
		SmtpEnabled:    smtpEnabled,
		SmtpHost:       smtpHost,
		SmtpPort:       smtpPort,
		SmtpUser:       smtpUser,
		SmtpPass:       smtpPass,
		SmtpAdminEmail: smtpAdminEmail,
		SmtpSenderName: smtpSenderName,

		// Phone/SMS configuration
		PhoneEnabled:    utils.Config.Auth.Sms.EnableSignup,
		SmsAutoconfirm:  !utils.Config.Auth.Sms.EnableConfirmations,
		SmsMaxFrequency: utils.Config.Auth.Sms.MaxFrequency,
		SmsTemplate:     utils.Config.Auth.Sms.Template,
		SmsTestOtp:      testOTPEnvConfig,

		// SMS Providers
		SmsTwilioEnabled:       utils.Config.Auth.Sms.Twilio.Enabled,
		SmsTwilioAccountSid:    utils.Config.Auth.Sms.Twilio.AccountSid,
		SmsTwilioAuthToken:     utils.Config.Auth.Sms.Twilio.AuthToken.Value,
		SmsTwilioMsgSvcSid:     utils.Config.Auth.Sms.Twilio.MessageServiceSid,
		SmsTwilioVerifyEnabled: utils.Config.Auth.Sms.TwilioVerify.Enabled,
		SmsTwilioVerifyAcctSid: utils.Config.Auth.Sms.TwilioVerify.AccountSid,
		SmsTwilioVerifyToken:   utils.Config.Auth.Sms.TwilioVerify.AuthToken.Value,
		SmsTwilioVerifyMsgSid:  utils.Config.Auth.Sms.TwilioVerify.MessageServiceSid,
		SmsMessagebirdEnabled:  utils.Config.Auth.Sms.Messagebird.Enabled,
		SmsMessagebirdKey:      utils.Config.Auth.Sms.Messagebird.AccessKey.Value,
		SmsMessagebirdOrig:     utils.Config.Auth.Sms.Messagebird.Originator,
		SmsTextlocalEnabled:    utils.Config.Auth.Sms.Textlocal.Enabled,
		SmsTextlocalApiKey:     utils.Config.Auth.Sms.Textlocal.ApiKey.Value,
		SmsTextlocalSender:     utils.Config.Auth.Sms.Textlocal.Sender,
		SmsVonageEnabled:       utils.Config.Auth.Sms.Vonage.Enabled,
		SmsVonageApiKey:        utils.Config.Auth.Sms.Vonage.ApiKey,
		SmsVonageApiSecret:     utils.Config.Auth.Sms.Vonage.ApiSecret.Value,
		SmsVonageFrom:          utils.Config.Auth.Sms.Vonage.From,

		// Anonymous users
		EnableAnonymousSignIns: utils.Config.Auth.EnableAnonymousSignIns,

		// Password configuration
		PasswordMinLength:    utils.Config.Auth.MinimumPasswordLength,
		PasswordRequirements: string(utils.Config.Auth.PasswordRequirements.ToChar()),

		// Security configuration
		RefreshTokenRotation:      utils.Config.Auth.EnableRefreshTokenRotation,
		RefreshTokenReuseInterval: utils.Config.Auth.RefreshTokenReuseInterval,
		ManualLinkingEnabled:      utils.Config.Auth.EnableManualLinking,
		SecurePasswordChange:      utils.Config.Auth.Email.SecurePasswordChange,

		// MFA configuration
		MfaPhoneEnrollEnabled:    utils.Config.Auth.MFA.Phone.EnrollEnabled,
		MfaPhoneVerifyEnabled:    utils.Config.Auth.MFA.Phone.VerifyEnabled,
		MfaTotpEnrollEnabled:     utils.Config.Auth.MFA.TOTP.EnrollEnabled,
		MfaTotpVerifyEnabled:     utils.Config.Auth.MFA.TOTP.VerifyEnabled,
		MfaWebAuthnEnrollEnabled: utils.Config.Auth.MFA.WebAuthn.EnrollEnabled,
		MfaWebAuthnVerifyEnabled: utils.Config.Auth.MFA.WebAuthn.VerifyEnabled,
		MfaMaxEnrolledFactors:    utils.Config.Auth.MFA.MaxEnrolledFactors,
		MfaPhoneTemplate:         utils.Config.Auth.MFA.Phone.Template,
		MfaPhoneOtpLength:        utils.Config.Auth.MFA.Phone.OtpLength,
		MfaPhoneMaxFrequency:     utils.Config.Auth.MFA.Phone.MaxFrequency,

		// Rate limits
		RateLimitAnonymousUsers: utils.Config.Auth.RateLimit.AnonymousUsers,
		RateLimitTokenRefresh:   utils.Config.Auth.RateLimit.TokenRefresh,
		RateLimitOtp:            utils.Config.Auth.RateLimit.SignInSignUps,
		RateLimitVerify:         utils.Config.Auth.RateLimit.TokenVerifications,
		RateLimitSmsSent:        utils.Config.Auth.RateLimit.SmsSent,
		RateLimitWeb3:           utils.Config.Auth.RateLimit.Web3,

		// Sessions
		SessionsTimebox:           utils.Config.Auth.Sessions.Timebox,
		SessionsInactivityTimeout: utils.Config.Auth.Sessions.InactivityTimeout,

		// Web3
		Web3SolanaEnabled:   utils.Config.Auth.Web3.Solana.Enabled,
		Web3EthereumEnabled: utils.Config.Auth.Web3.Ethereum.Enabled,

		// OAuth providers
		OAuthProviders: oauthProviders,

		// OAuth Server
		OAuthServerEnabled:           utils.Config.Auth.OAuthServer.Enabled,
		OAuthServerAuthorizationPath: utils.Config.Auth.OAuthServer.AuthorizationUrlPath,
		OAuthServerAllowDynamicReg:   utils.Config.Auth.OAuthServer.AllowDynamicRegistration,
	}

	// Captcha configuration
	if captcha := utils.Config.Auth.Captcha; captcha != nil {
		data.CaptchaEnabled = captcha.Enabled
		data.CaptchaProvider = string(captcha.Provider)
		data.CaptchaSecret = captcha.Secret.Value
	}

	// Hooks configuration
	if hook := utils.Config.Auth.Hook.MFAVerificationAttempt; hook != nil && hook.Enabled {
		data.HookMfaVerificationEnabled = true
		data.HookMfaVerificationUri = hook.URI
		data.HookMfaVerificationSecrets = hook.Secrets.Value
	}
	if hook := utils.Config.Auth.Hook.PasswordVerificationAttempt; hook != nil && hook.Enabled {
		data.HookPasswordVerificationEnabled = true
		data.HookPasswordVerificationUri = hook.URI
		data.HookPasswordVerificationSecrets = hook.Secrets.Value
	}
	if hook := utils.Config.Auth.Hook.CustomAccessToken; hook != nil && hook.Enabled {
		data.HookCustomAccessTokenEnabled = true
		data.HookCustomAccessTokenUri = hook.URI
		data.HookCustomAccessTokenSecrets = hook.Secrets.Value
	}
	if hook := utils.Config.Auth.Hook.SendSMS; hook != nil && hook.Enabled {
		data.HookSendSmsEnabled = true
		data.HookSendSmsUri = hook.URI
		data.HookSendSmsSecrets = hook.Secrets.Value
	}
	if hook := utils.Config.Auth.Hook.SendEmail; hook != nil && hook.Enabled {
		data.HookSendEmailEnabled = true
		data.HookSendEmailUri = hook.URI
		data.HookSendEmailSecrets = hook.Secrets.Value
	}
	if hook := utils.Config.Auth.Hook.BeforeUserCreated; hook != nil && hook.Enabled {
		data.HookBeforeUserCreatedEnabled = true
		data.HookBeforeUserCreatedUri = hook.URI
		data.HookBeforeUserCreatedSecrets = hook.Secrets.Value
	}

	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("failed to execute process-compose template: %w", err)
	}

	return buf.String(), nil
}

// WriteProcessComposeConfig generates and writes process-compose.yaml to the sandbox directory.
func WriteProcessComposeConfig(goCtx context.Context, ctx *SandboxContext, fsys afero.Fs, postgresVersion string) (string, error) {
	content, err := GenerateProcessComposeConfig(goCtx, ctx, postgresVersion)
	if err != nil {
		return "", err
	}

	configPath := filepath.Join(ctx.ConfigDir, "process-compose.yaml")
	if err := afero.WriteFile(fsys, configPath, []byte(content), 0644); err != nil {
		return "", fmt.Errorf("failed to write process-compose config: %w", err)
	}

	return configPath, nil
}

// RunProject starts all services using process-compose as a background server.
// It spawns a detached server process and waits for postgres to be healthy.
func RunProject(configPath string, sandboxCtx *SandboxContext, fsys afero.Fs) error {
	return runDetached(configPath, sandboxCtx, fsys)
}

// runDetached spawns a background server process and waits for postgres to be healthy.
// Returns after postgres is ready so migrations can run. Call WaitForAllServices after migrations.
// The server process runs the HTTP API for graceful shutdown via 'supabase stop'.
func runDetached(configPath string, sandboxCtx *SandboxContext, fsys afero.Fs) error {
	// Spawn the server as a detached background process
	// Use absolute path to handle --workdir flag
	serverCmd := exec.Command(getExecutablePath(), "_sandbox-server",
		"--config", configPath,
		"--port", fmt.Sprintf("%d", sandboxCtx.Ports.ProcessCompose),
	)

	// Redirect output to log file
	logPath := filepath.Join(sandboxCtx.LogDir(), "server.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return fmt.Errorf("failed to create server log file: %w", err)
	}
	serverCmd.Stdout = logFile
	serverCmd.Stderr = logFile

	// Platform-specific detachment
	if runtime.GOOS != "windows" {
		serverCmd.SysProcAttr = &syscall.SysProcAttr{
			Setpgid: true, // Create new process group so it survives parent exit
		}
	}

	if err := serverCmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("failed to start server process: %w", err)
	}
	logFile.Close()

	// Save state with server PID for fallback shutdown
	state := &SandboxState{
		PID:   serverCmd.Process.Pid,
		Ports: *sandboxCtx.Ports,
	}
	if err := sandboxCtx.SaveState(fsys, state); err != nil {
		// Kill server if we can't save state
		serverCmd.Process.Kill()
		return fmt.Errorf("failed to save state: %w", err)
	}

	// Wait for postgres to be healthy (so migrations can run)
	// Other services continue starting in background
	if err := WaitForPostgresReady(sandboxCtx.Ports.ProcessCompose, DefaultServiceTimeout); err != nil {
		// Try to kill the server process
		if serverCmd.Process != nil {
			_ = serverCmd.Process.Kill()
		}
		return err
	}

	return nil
}

// WaitForAllServices waits for all services to be healthy.
func WaitForAllServices(processComposePort int, timeout time.Duration) error {
	return WaitForServerReady(processComposePort, timeout)
}

// getExecutablePath returns the absolute path to the current executable.
// This is needed for --workdir support since os.Args[0] may be relative.
func getExecutablePath() string {
	if path, err := os.Executable(); err == nil {
		return path
	}
	// Fallback to os.Args[0] if os.Executable() fails
	return os.Args[0]
}
