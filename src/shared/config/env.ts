import { z } from 'zod';

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Firebase (either file path or individual credentials)
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  // Redis
  REDIS_URL: z.string().url().optional(),

  // Server
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  // Rate limiting
  // Higher limits for development to avoid issues during development
  RATE_LIMIT_MAX: z.coerce.number().default(process.env.NODE_ENV === 'development' ? 500 : 100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),

  // Swagger Documentation (optional - if not set, Swagger is unprotected)
  SWAGGER_USERNAME: z.string().optional(),
  SWAGGER_PASSWORD: z.string().optional(),

  // First run - run migrations automatically on startup (optional)
  FIRST_RUN: z.coerce.boolean().optional(),
  
  // CORS - Allowed origins (comma-separated list)
  // In production, specify allowed frontend URLs
  // Example: "https://recta.app,https://www.recta.app,http://localhost:5173"
  ALLOWED_ORIGINS: z.string().optional(),

  // Auth mode: 'local' issues its own JWTs (no Firebase); 'firebase' verifies Firebase ID tokens
  AUTH_MODE: z.enum(['local', 'firebase']).default('firebase'),
  AUTH_JWT_SECRET: z.string().min(32).optional(),
  AUTH_TOKEN_TTL_HOURS: z.coerce.number().positive().max(24 * 365).default(720),
  // Set to 'false' to close sign-ups on an instance that already has its users (POST /auth/register answers 403)
  AUTH_ALLOW_REGISTRATION: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  AUTH_FIREBASE_WEB_API_KEY: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.AUTH_MODE === 'local') {
    if (!data.AUTH_JWT_SECRET || data.AUTH_JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_JWT_SECRET'],
        message:
          "AUTH_JWT_SECRET is required (min 32 chars) when AUTH_MODE=local. Generate one with: openssl rand -base64 48",
      });
    }
  }
});

function validateEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    console.error('❌ Invalid environment variables:');
    const fieldErrors = parsed.error.flatten().fieldErrors;
    console.error(JSON.stringify(fieldErrors, null, 2));
    console.error('\n📝 Missing or invalid variables:');
    Object.entries(fieldErrors).forEach(([field, errors]) => {
      console.error(`  - ${field}: ${errors?.join(', ') || 'invalid'}`);
    });
    console.error('\n💡 Please check your environment variables configuration.');
    process.exit(1);
  }

  // Validate Firebase credentials are provided (either file or individual)
  // NOTE: This validation is deferred - we don't fail startup if Firebase is missing
  // The health check should work even without Firebase
  const env = parsed.data;
  
  // Only validate Firebase in production or if explicitly required
  // In Railway, we want the server to start even if Firebase config is missing initially
  if (env.NODE_ENV === 'production') {
    const hasCredentialsFile = !!env.GOOGLE_APPLICATION_CREDENTIALS;
    const hasIndividualCredentials =
      env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY;

    if (!hasCredentialsFile && !hasIndividualCredentials) {
      console.warn('⚠️  Firebase credentials not provided - some features may not work');
      console.warn('   Provide GOOGLE_APPLICATION_CREDENTIALS or all of FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
      // Don't exit - allow server to start for health checks
    }
  }

  return env;
}

export const env = validateEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isDevelopment = env.NODE_ENV === 'development';
export const isTest = env.NODE_ENV === 'test';
export const isLocalAuth = env.AUTH_MODE === 'local';



