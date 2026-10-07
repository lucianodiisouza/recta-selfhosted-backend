import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { getFirebaseAuth } from '../config/firebase.js';
import { isLocalAuth } from '../config/env.js';
import { verifyJwt } from '../../modules/auth/local.service.js';
import { UnauthorizedError, InvalidTokenError, EmailNotVerifiedError } from '../errors/index.js';

/**
 * Authenticated user context injected into requests
 */
export interface AuthUser {
  uid: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Extend Fastify request to include auth user
 */
declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

/**
 * Extract Bearer token from Authorization header
 */
function extractBearerToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (!authHeader) {
    return null;
  }

  const [scheme, token] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }

  return token;
}

/**
 * Authentication middleware
 * Verifies Firebase ID token and injects authUser into request
 *
 * Options:
 * - requireEmailVerified: Require email to be verified (default: true)
 */
export function authMiddleware(options: { requireEmailVerified?: boolean } = {}) {
  const { requireEmailVerified = true } = options;

  return async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<void> {
    // Extract token from header
    const token = extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedError('Bearer token required');
    }

    // Local mode: verify self-signed JWT, skip Firebase and email_verified
    if (isLocalAuth) {
      const payload = verifyJwt(token);
      request.authUser = {
        uid: payload.sub,
        email: payload.email,
        emailVerified: true,
      };
      return;
    }

    // Verify token with Firebase
    let decodedToken: DecodedIdToken;
    try {
      const auth = getFirebaseAuth();
      decodedToken = await auth.verifyIdToken(token);
    } catch (error) {
      request.log.warn({ error }, 'Token verification failed');
      throw new InvalidTokenError();
    }

    // Check email verification if required
    if (requireEmailVerified && !decodedToken.email_verified) {
      throw new EmailNotVerifiedError();
    }

    // Validate email is present (required for user creation)
    if (!decodedToken.email) {
      throw new UnauthorizedError('Email is required for authentication');
    }

    // Inject auth user into request
    request.authUser = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified || false,
    };
  };
}

/**
 * Get authenticated user from request
 * Throws if user is not authenticated
 */
export function getAuthUser(request: FastifyRequest): AuthUser {
  if (!request.authUser) {
    throw new UnauthorizedError('Authentication required');
  }
  return request.authUser;
}







