import type { LocalJwtSigningMaterial } from "./LocalCredentials.ts";

export type PasswordRequirements =
  | ""
  | "letters_digits"
  | "lower_upper_letters_digits"
  | "lower_upper_letters_digits_symbols";

export interface AuthEmailConfig {
  readonly enableSignup: boolean;
  readonly doubleConfirmChanges: boolean;
  readonly enableConfirmations: boolean;
  readonly securePasswordChange: boolean;
  readonly maxFrequency: string;
  readonly otpLength: number;
  readonly otpExpiry: number;
  readonly smtp?: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly pass: string;
    readonly adminEmail: string;
    readonly senderName?: string;
  };
}

export interface AuthSmsConfig {
  readonly enableSignup: boolean;
  readonly enableConfirmations: boolean;
  readonly template: string;
  readonly maxFrequency: string;
  readonly testOtp?: Readonly<Record<string, string>>;
  readonly provider?:
    | {
        readonly _tag: "twilio";
        readonly accountSid: string;
        readonly messageServiceSid: string;
        readonly authToken: string;
      }
    | {
        readonly _tag: "twilio-verify";
        readonly accountSid: string;
        readonly messageServiceSid: string;
        readonly authToken: string;
      }
    | {
        readonly _tag: "messagebird";
        readonly originator: string;
        readonly accessKey: string;
      }
    | {
        readonly _tag: "textlocal";
        readonly sender: string;
        readonly apiKey: string;
      }
    | {
        readonly _tag: "vonage";
        readonly from: string;
        readonly apiKey: string;
        readonly apiSecret: string;
      };
}

export interface AuthExternalProviderConfig {
  readonly enabled: boolean;
  readonly clientId: string;
  readonly secret?: string;
  readonly url: string;
  readonly redirectUri?: string;
  readonly skipNonceCheck: boolean;
  readonly emailOptional: boolean;
}

export interface AuthHookConfig {
  readonly enabled: boolean;
  readonly uri?: string;
  readonly secrets?: string;
}

export interface AuthRuntimeConfig {
  readonly port?: number;
  readonly siteUrl?: string;
  readonly additionalRedirectUrls?: ReadonlyArray<string>;
  readonly jwtExpiry?: number;
  readonly jwtIssuer?: string;
  readonly externalUrl?: string;
  readonly enableSignup?: boolean;
  readonly enableAnonymousSignIns?: boolean;
  readonly enableRefreshTokenRotation?: boolean;
  readonly refreshTokenReuseInterval?: number;
  readonly enableManualLinking?: boolean;
  readonly minimumPasswordLength?: number;
  readonly passwordRequirements?: PasswordRequirements;
  readonly email?: AuthEmailConfig;
  readonly sms?: AuthSmsConfig;
  readonly externalProviders?: Readonly<Record<string, AuthExternalProviderConfig>>;
  readonly hooks?: Readonly<Record<string, AuthHookConfig>>;
  readonly version?: string;
}

export interface ResolvedAuthRuntimeConfig {
  readonly port: number;
  readonly siteUrl: string;
  readonly additionalRedirectUrls: ReadonlyArray<string>;
  readonly jwtExpiry: number;
  readonly jwtIssuer: string;
  readonly externalUrl: string;
  readonly enableSignup: boolean;
  readonly enableAnonymousSignIns: boolean;
  readonly enableRefreshTokenRotation: boolean;
  readonly refreshTokenReuseInterval: number;
  readonly enableManualLinking: boolean;
  readonly minimumPasswordLength: number;
  readonly passwordRequirements: PasswordRequirements;
  readonly email: AuthEmailConfig;
  readonly sms: AuthSmsConfig;
  readonly externalProviders: Readonly<Record<string, AuthExternalProviderConfig>>;
  readonly hooks: Readonly<Record<string, AuthHookConfig>>;
  readonly version: string;
}

export interface AuthEnvironmentInput {
  readonly config: ResolvedAuthRuntimeConfig;
  readonly signing: LocalJwtSigningMaterial;
  readonly jwtSecret: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly smtpFallback?: {
    readonly host: string;
    readonly port: number;
    readonly adminEmail: string;
    readonly senderName: string;
  };
}
