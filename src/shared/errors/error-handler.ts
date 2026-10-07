import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { AppError, TooManyRequestsError, ValidationError } from './app-error.js';
import { isProduction } from '../config/env.js';

interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, string[]>;
    stack?: string;
  };
}

/**
 * Centralized error handler for Fastify
 * Converts all errors to a consistent format
 */
export function errorHandler(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  // Log error for debugging
  request.log.error(error);

  // Handle JSON parsing errors (SyntaxError from JSON.parse)
  if (error.name === 'SyntaxError' && error.message.includes('JSON')) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: 'BAD_REQUEST',
        message: 'Invalid JSON in request body',
        ...(!isProduction && { 
          details: { 
            _root: [error.message] 
          } 
        }),
      },
    };
    reply.status(400).send(response);
    return;
  }

  // Handle Zod validation errors
  if (error instanceof ZodError) {
    const details = formatZodError(error);
    const response: ErrorResponse = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        details,
      },
    };
    reply.status(400).send(response);
    return;
  }

  // Handle custom AppError
  if (error instanceof AppError) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error instanceof ValidationError && { details: error.details }),
        ...(!isProduction && { stack: error.stack }),
      },
    };
    // AppError resets the prototype, so `instanceof TooManyRequestsError` would be false here
    if (error.statusCode === 429 && 'retryAfterSeconds' in error) {
      reply.header('Retry-After', String((error as TooManyRequestsError).retryAfterSeconds));
    }
    reply.status(error.statusCode).send(response);
    return;
  }

  // @fastify/rate-limit throws a plain { statusCode: 429, message } object, which none of the branches above match
  if ((error as { statusCode?: number }).statusCode === 429) {
    reply.status(429).send({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later' },
    } satisfies ErrorResponse);
    return;
  }

  // Handle Fastify validation errors (from schema validation)
  if ('validation' in error && error.validation) {
    const response: ErrorResponse = {
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: error.message || 'Validation failed',
      },
    };
    reply.status(400).send(response);
    return;
  }

  // Handle unknown errors (return generic message in production)
  const response: ErrorResponse = {
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'An unexpected error occurred' : error.message,
      ...(!isProduction && { stack: error.stack }),
    },
  };
  reply.status(500).send(response);
}

/**
 * Format Zod errors into a user-friendly structure
 */
function formatZodError(error: ZodError): Record<string, string[]> {
  const details: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    if (!details[path]) {
      details[path] = [];
    }
    details[path].push(issue.message);
  }

  return details;
}





