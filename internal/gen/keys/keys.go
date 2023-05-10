package keys

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/go-git/go-git/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

type CustomClaims struct {
	Ref  string `json:"ref"`
	Role string `json:"role"`
	jwt.RegisteredClaims
}

func NewJWTToken(ref, role string, expiry time.Time) (string, error) {
	claims := CustomClaims{
		ref,
		role,
		jwt.RegisteredClaims{
			ExpiresAt: jwt.NewNumericDate(expiry),
			Issuer:    "supabase",
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SigningString()
}

type CustomName struct {
	DbHost         string `env:"db.host,default=NEXT_PUBLIC_SUPABASE_URL"`
	DbPassword     string `env:"db.password,default=SUPABASE_DB_PASSWORD"`
	AnonKey        string `env:"auth.anon_key,default=SUPABASE_AUTH_ANON_KEY"`
	ServiceRoleKey string `env:"auth.service_role_key,default=SUPABASE_AUTH_SERVICE_ROLE_KEY"`
}

func Run(ctx context.Context, names CustomName, format string, fsys afero.Fs) error {
	// Sanity checks
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	branch := getGitBranch(fsys)
	// Generate database password
	key := strings.Join([]string{
		projectRef,
		utils.Config.Auth.JwtSecret,
		branch,
	}, ":")
	hash := sha256.Sum256([]byte(key))
	password := hex.EncodeToString(hash[:])
	// Generate JWT tokens
	expiry := time.Now().AddDate(10, 0, 0)
	utils.Config.Auth.AnonKey, err = NewJWTToken(projectRef, "anon", expiry)
	if err != nil {
		return err
	}
	utils.Config.Auth.ServiceRoleKey, err = NewJWTToken(projectRef, "service_role", expiry)
	if err != nil {
		return err
	}
	return utils.EncodeOutput(format, os.Stdout, map[string]string{
		names.DbHost:         fmt.Sprintf("%s-%s.fly.dev", projectRef, branch),
		names.DbPassword:     password,
		names.AnonKey:        utils.Config.Auth.AnonKey,
		names.ServiceRoleKey: utils.Config.Auth.ServiceRoleKey,
	})
}

func getGitBranch(fsys afero.Fs) string {
	branch := "main"
	if gitRoot, err := utils.GetGitRoot(fsys); err == nil {
		if repo, err := git.PlainOpen(*gitRoot); err == nil {
			if ref, err := repo.Head(); err == nil {
				branch = ref.Name().Short()
			}
		}
	}
	return branch
}
