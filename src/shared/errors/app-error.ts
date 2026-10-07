/**
 * Base application error with HTTP status codes
 * All custom errors should extend this class
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly isOperational: boolean;

  constructor(
    message: string,
    statusCode: number = 500,
    code: string = 'INTERNAL_ERROR',
    isOperational: boolean = true
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;

    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);

    // Set the prototype explicitly for proper instanceof checks
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

// ============================================================================
// AUTHENTICATION ERRORS (401)
// ============================================================================

export class UnauthorizedError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class InvalidTokenError extends AppError {
  constructor(message: string = 'Invalid or expired token') {
    super(message, 401, 'INVALID_TOKEN');
  }
}

export class EmailNotVerifiedError extends AppError {
  constructor(message: string = 'Email verification required') {
    super(message, 401, 'EMAIL_NOT_VERIFIED');
  }
}

// ============================================================================
// AUTHORIZATION ERRORS (403)
// ============================================================================

export class ForbiddenError extends AppError {
  constructor(message: string = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class InsufficientRoleError extends AppError {
  constructor(message: string = 'Insufficient permissions for this action') {
    super(message, 403, 'INSUFFICIENT_ROLE');
  }
}

// ============================================================================
// NOT FOUND ERRORS (404)
// ============================================================================

export class NotFoundError extends AppError {
  constructor(resource: string = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

// ============================================================================
// VALIDATION ERRORS (400)
// ============================================================================

export class ValidationError extends AppError {
  public readonly details: Record<string, string[]>;

  constructor(message: string = 'Validation failed', details: Record<string, string[]> = {}) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

export class BadRequestError extends AppError {
  constructor(message: string = 'Bad request') {
    super(message, 400, 'BAD_REQUEST');
  }
}

/** 400: category is referenced by transactions, budgets or recurring (use code CATEGORY_IN_USE for i18n) */
export class CategoryInUseError extends AppError {
  constructor(message: string = 'Category is in use') {
    super(message, 400, 'CATEGORY_IN_USE');
  }
}

// ============================================================================
// CONFLICT ERRORS (409)
// ============================================================================

export class ConflictError extends AppError {
  constructor(message: string = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
  }
}

// ============================================================================
// RATE LIMIT ERRORS (429)
// ============================================================================

export class RateLimitError extends AppError {
  constructor(message: string = 'Too many requests') {
    super(message, 429, 'RATE_LIMIT_EXCEEDED');
  }
}

// ============================================================================
// RATE LIMIT (429)
// ============================================================================

export class TooManyRequestsError extends AppError {
  constructor(
    message: string = 'Too many requests, try again later',
    public readonly retryAfterSeconds: number = 60
  ) {
    super(message, 429, 'RATE_LIMITED');
  }
}
