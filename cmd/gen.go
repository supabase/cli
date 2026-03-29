package cmd

import (
	"encoding/json"
	"os"
	"strings"
	"time"

	env "github.com/Netflix/go-env"
	"github.com/go-errors/errors"
	"github.com/go-viper/mapstructure/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/spf13/afero"
	"github.com/spf13/cobra"
	"github.com/supabase/cli/internal/gen/bearerjwt"
	"github.com/supabase/cli/internal/gen/signingkeys"
	"github.com/supabase/cli/internal/gen/types"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/legacy/keys"
	"github.com/supabase/cli/pkg/config"
)

var (
	genCmd = &cobra.Command{
		GroupID: groupLocalDev,
		Use:     "gen",
		Short:   "Run code generation tools",
	}

	keyNames keys.CustomName

	genKeysCmd = &cobra.Command{
		Deprecated: `use "gen signing-key" instead.`,
		Use:        "keys",
		Short:      "Generate keys for preview branch",
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			es, err := env.EnvironToEnvSet(override)
			if err != nil {
				return err
			}
			if err := env.Unmarshal(es, &keyNames); err != nil {
				return err
			}
			cmd.GroupID = groupManagementAPI
			return cmd.Root().PersistentPreRunE(cmd, args)
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			format := utils.OutputFormat.Value
			if format == utils.OutputPretty {
				format = utils.OutputEnv
			}
			return keys.Run(cmd.Context(), flags.ProjectRef, format, keyNames, afero.NewOsFs())
		},
	}

	lang = utils.EnumFlag{
		Allowed: []string{
			types.LangTypescript,
			types.LangGo,
			types.LangSwift,
			types.LangPython,
		},
		Value: types.LangTypescript,
	}
	queryTimeout       time.Duration
	postgrestV9Compat  bool
	swiftAccessControl = utils.EnumFlag{
		Allowed: []string{
			types.SwiftInternalAccessControl,
			types.SwiftPublicAccessControl,
		},
		Value: types.SwiftInternalAccessControl,
	}

	genTypesCmd = &cobra.Command{
		Use:   "types",
		Short: "Generate types from Postgres schema",
		PreRunE: func(cmd *cobra.Command, args []string) error {
			if postgrestV9Compat && !cmd.Flags().Changed("db-url") {
				return errors.New("--postgrest-v9-compat must used together with --db-url")
			}
			// Legacy commands specify language using arg, eg. gen types typescript
			if len(args) > 0 && args[0] != types.LangTypescript && !cmd.Flags().Changed("lang") {
				return errors.New("use --lang flag to specify the typegen language")
			}
			return nil
		},
		RunE: func(cmd *cobra.Command, args []string) error {
			ctx := cmd.Context()
			if flags.DbConfig.Host == "" {
				// If no flag is specified, prompt for project id.
				if err := flags.ParseProjectRef(ctx, afero.NewMemMapFs()); errors.Is(err, utils.ErrNotLinked) {
					return errors.New("Must specify one of --local, --linked, --project-id, or --db-url")
				} else if err != nil {
					return err
				}
			}
			return types.Run(ctx, flags.ProjectRef, flags.DbConfig, lang.Value, schema, postgrestV9Compat, swiftAccessControl.Value, queryTimeout, afero.NewOsFs())
		},
		Example: `  supabase gen types --local
  supabase gen types --linked --lang=go
  supabase gen types --project-id abc-def-123 --schema public --schema private
  supabase gen types --db-url 'postgresql://...' --schema public --schema auth`,
	}

	algorithm = utils.EnumFlag{
		Allowed: signingkeys.GetSupportedAlgorithms(),
		Value:   string(config.AlgES256),
	}
	appendKeys bool

	genSigningKeyCmd = &cobra.Command{
		Use:   "signing-key",
		Short: "Generate a JWT signing key",
		Long: `Securely generate a private JWT signing key for use in the CLI or to import in the dashboard.

Supported algorithms:
	ES256 - ECDSA with P-256 curve and SHA-256 (recommended)
	RS256 - RSA with SHA-256
`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return signingkeys.Run(cmd.Context(), algorithm.Value, appendKeys, afero.NewOsFs())
		},
	}

	claims   config.CustomClaims
	expiry   time.Time
	validFor time.Duration
	payload  string

	genJWTCmd = &cobra.Command{
		Use:   "bearer-jwt",
		Short: "Generate a Bearer Auth JWT for accessing Data API",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			custom := jwt.MapClaims{}
			if err := parseClaims(custom); err != nil {
				return err
			}
			return bearerjwt.Run(cmd.Context(), custom, os.Stdout, afero.NewOsFs())
		},
	}
)

func init() {
	typeFlags := genTypesCmd.Flags()
	typeFlags.Bool("local", false, "Generate types from the local dev database.")
	typeFlags.Bool("linked", false, "Generate types from the linked project.")
	typeFlags.String("db-url", "", "Generate types from a database url.")
	typeFlags.StringVar(&flags.ProjectRef, "project-id", "", "Generate types from a project ID.")
	genTypesCmd.MarkFlagsMutuallyExclusive("local", "linked", "project-id", "db-url")
	typeFlags.Var(&lang, "lang", "Output language of the generated types.")
	typeFlags.StringSliceVarP(&schema, "schema", "s", []string{}, "Comma separated list of schema to include.")
	// Direct connection only flags
	typeFlags.Var(&swiftAccessControl, "swift-access-control", "Access control for Swift generated types.")
	genTypesCmd.MarkFlagsMutuallyExclusive("linked", "project-id", "swift-access-control")
	typeFlags.BoolVar(&postgrestV9Compat, "postgrest-v9-compat", false, "Generate types compatible with PostgREST v9 and below.")
	genTypesCmd.MarkFlagsMutuallyExclusive("linked", "project-id", "postgrest-v9-compat")
	typeFlags.DurationVar(&queryTimeout, "query-timeout", time.Second*15, "Maximum timeout allowed for the database query.")
	genTypesCmd.MarkFlagsMutuallyExclusive("linked", "project-id", "query-timeout")
	genCmd.AddCommand(genTypesCmd)
	keyFlags := genKeysCmd.Flags()
	keyFlags.StringVar(&flags.ProjectRef, "project-ref", "", "Project ref of the Supabase project.")
	keyFlags.StringSliceVar(&override, "override-name", []string{}, "Override specific variable names.")
	genCmd.AddCommand(genKeysCmd)
	signingKeyFlags := genSigningKeyCmd.Flags()
	signingKeyFlags.Var(&algorithm, "algorithm", "Algorithm for signing key generation.")
	signingKeyFlags.BoolVar(&appendKeys, "append", false, "Append new key to existing keys file instead of overwriting.")
	genCmd.AddCommand(genSigningKeyCmd)
	tokenFlags := genJWTCmd.Flags()
	tokenFlags.StringVar(&claims.Role, "role", "", "Postgres role to use.")
	cobra.CheckErr(genJWTCmd.MarkFlagRequired("role"))
	tokenFlags.StringVar(&claims.Subject, "sub", "", "User ID to impersonate.")
	genJWTCmd.Flag("sub").DefValue = "anonymous"
	tokenFlags.TimeVar(&expiry, "exp", time.Time{}, []string{time.RFC3339}, "Expiry timestamp for this token.")
	tokenFlags.DurationVar(&validFor, "valid-for", time.Minute*30, "Validity duration for this token.")
	tokenFlags.StringVar(&payload, "payload", "{}", "Custom claims in JSON format.")
	genCmd.AddCommand(genJWTCmd)
	rootCmd.AddCommand(genCmd)
}

func parseClaims(custom jwt.MapClaims) error {
	// Initialise default claims
	now := time.Now()
	if expiry.IsZero() {
		expiry = now.Add(validFor)
	} else {
		now = expiry.Add(-validFor)
	}
	claims.IssuedAt = jwt.NewNumericDate(now)
	claims.ExpiresAt = jwt.NewNumericDate(expiry)
	// Set is_anonymous = true for authenticated role without explicit user ID
	if strings.EqualFold(claims.Role, "authenticated") && len(claims.Subject) == 0 {
		claims.IsAnon = true
	}
	// Override with custom claims
	if dec, err := mapstructure.NewDecoder(&mapstructure.DecoderConfig{
		TagName: "json",
		Squash:  true,
		Result:  &custom,
	}); err != nil {
		return errors.Errorf("failed to init decoder: %w", err)
	} else if err := dec.Decode(claims); err != nil {
		return errors.Errorf("failed to decode claims: %w", err)
	}
	if err := json.Unmarshal([]byte(payload), &custom); err != nil {
		return errors.Errorf("failed to parse payload: %w", err)
	}
	return nil
}
