import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';

import { env, isProduction } from './shared/config/env.js';
import { initializeFirebase } from './shared/config/firebase.js';
import { connectDatabase, disconnectDatabase } from './shared/db/prisma.js';
import { runMigrations } from './shared/db/migrations.js';
import { errorHandler } from './shared/errors/error-handler.js';

// Routes
import { authRoutes } from './modules/auth/index.js';
import { userRoutes } from './modules/users/index.js';
import { householdRoutes } from './modules/households/index.js';
import { accountRoutes } from './modules/accounts/index.js';
import { categoryRoutes } from './modules/categories/index.js';
import { transactionRoutes } from './modules/transactions/index.js';
import { importRoutes, IMPORT_MULTIPART_LIMITS } from './modules/transactions/import.routes.js';
import { budgetRoutes } from './modules/budgets/index.js';
import { savingsGoalRoutes } from './modules/savings-goals/index.js';
import { recurringTransactionRoutes } from './modules/recurring-transactions/index.js';
import { feedbackRoutes } from './modules/feedback/index.js';
import { notificationRoutes } from './modules/notifications/index.js';
import { dashboardRoutes } from './modules/dashboard/index.js';

/**
 * Build the Fastify application
 */
export async function buildApp(): Promise<FastifyInstance> {
  console.log('🔨 Building Fastify application...');
  
  const app = Fastify({
    logger: {
      level: isProduction ? 'info' : 'debug',
      transport: isProduction
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          },
    },
    trustProxy: true,
  });

  console.log('✅ Fastify instance created');

  // ============================================================================
  // HEALTH CHECK (registered FIRST, before any plugins or routes)
  // ============================================================================

  console.log('📋 Registering health check endpoint...');
  app.get('/health', {
    schema: {
      description: 'Health check endpoint',
      tags: ['Health'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            timestamp: { type: 'string', format: 'date-time' },
            uptime: { type: 'number', description: 'Server uptime in seconds' },
          },
        },
      },
    },
  }, async (request, reply) => {
    return reply.code(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });
  console.log('✅ Health check endpoint registered at /health');

  // ============================================================================
  // PLUGINS
  // ============================================================================

  // Swagger/OpenAPI Documentation
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Recta API',
        description: 'Personal finance backend with household collaboration support',
        version: '1.0.0',
      },
      servers: [
        {
          url: isProduction
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'your-railway-app.up.railway.app'}`
            : `http://localhost:${env.PORT}`,
          description: isProduction ? 'Production server' : 'Development server',
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Firebase ID Token',
          },
        },
      },
      tags: [
        { name: 'Health', description: 'Health check endpoints' },
        { name: 'Auth', description: 'Authentication endpoints' },
        { name: 'Users', description: 'User management endpoints' },
        { name: 'Households', description: 'Household management endpoints' },
        { name: 'Accounts', description: 'Account management endpoints' },
        { name: 'Categories', description: 'Transaction category endpoints' },
        { name: 'Transactions', description: 'Transaction management endpoints' },
        { name: 'Budgets', description: 'Budget management endpoints' },
        { name: 'Savings Goals', description: 'Savings goal endpoints' },
        { name: 'Recurring Transactions', description: 'Recurring transaction endpoints' },
        { name: 'Feedback', description: 'User feedback endpoints' },
      ],
    },
  });

  // Swagger UI with optional authentication
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
    uiHooks: {
      onRequest: function (request, reply, next) {
        next();
      },
      preHandler: function (request, reply, next) {
        // Protect Swagger UI with basic auth if credentials are provided
        if (env.SWAGGER_USERNAME && env.SWAGGER_PASSWORD) {
          const auth = request.headers.authorization;
          
          if (!auth || !auth.startsWith('Basic ')) {
            reply.header('WWW-Authenticate', 'Basic realm="Swagger UI"');
            reply.code(401).send({ error: 'Unauthorized' });
            return;
          }

          const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
          const [username, password] = credentials.split(':');

          if (username !== env.SWAGGER_USERNAME || password !== env.SWAGGER_PASSWORD) {
            reply.header('WWW-Authenticate', 'Basic realm="Swagger UI"');
            reply.code(401).send({ error: 'Unauthorized' });
            return;
          }
        }
        next();
      },
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject, request, reply) => {
      return swaggerObject;
    },
    transformSpecificationClone: true,
  });

  // CORS
  // Allow localhost (any port) and any domain containing "recta.app"
  await app.register(cors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl requests)
      if (!origin) {
        if (isProduction) {
          console.log('[CORS] Allowing request with no origin');
        }
        callback(null, true);
        return;
      }
      
      // Allow localhost (any protocol, any port)
      if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
        if (isProduction) {
          console.log(`[CORS] Allowing localhost origin: ${origin}`);
        }
        callback(null, true);
        return;
      }
      
      // Allow any domain containing "recta.app"
      if (origin.includes('recta.app')) {
        if (isProduction) {
          console.log(`[CORS] Allowing recta.app origin: ${origin}`);
        }
        callback(null, true);
        return;
      }
      
      // In development, allow all origins
      if (!isProduction) {
        callback(null, true);
        return;
      }
      
      // In production, check ALLOWED_ORIGINS env var for additional origins
      const allowedOrigins = env.ALLOWED_ORIGINS;
      if (allowedOrigins) {
        const allowedList = allowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
        if (allowedList.includes(origin)) {
          console.log(`[CORS] Allowing origin from ALLOWED_ORIGINS: ${origin}`);
          callback(null, true);
          return;
        }
      }
      
      // Reject if none of the above conditions match
      console.warn(`[CORS] Rejecting origin: ${origin}`);
      callback(new Error('Not allowed by CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  // Security headers
  await app.register(helmet, {
    contentSecurityPolicy: isProduction ? {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    } : false,
  });

  // Rate limiting
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (request) => {
      // Use Firebase UID if available, otherwise IP
      return request.authUser?.uid || request.ip;
    },
  });

  // Multipart (file uploads — used by POST /transactions/import/preview)
  await app.register(multipart, {
    limits: IMPORT_MULTIPART_LIMITS,
  });

  // ============================================================================
  // ERROR HANDLING
  // ============================================================================

  app.setErrorHandler(errorHandler);

  // Protect Swagger endpoints (UI and JSON spec) with basic auth if configured
  if (env.SWAGGER_USERNAME && env.SWAGGER_PASSWORD) {
    app.addHook('onRequest', async (request, reply) => {
      // Protect all /docs/* routes
      if (request.url.startsWith('/docs')) {
        const auth = request.headers.authorization;
        
        if (!auth || !auth.startsWith('Basic ')) {
          reply.header('WWW-Authenticate', 'Basic realm="Swagger Documentation"');
          reply.code(401).send({ error: 'Unauthorized' });
          return;
        }

        const credentials = Buffer.from(auth.slice(6), 'base64').toString('utf-8');
        const [username, password] = credentials.split(':');

        if (username !== env.SWAGGER_USERNAME || password !== env.SWAGGER_PASSWORD) {
          reply.header('WWW-Authenticate', 'Basic realm="Swagger Documentation"');
          reply.code(401).send({ error: 'Unauthorized' });
          return;
        }
      }
    });
  }

  app.get('/', async () => {
    return {
      name: 'Recta API',
      version: '1.0.0',
      documentation: '/docs',
      openApiSpec: '/docs/json',
    };
  });

  // ============================================================================
  // ROUTES
  // ============================================================================

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(userRoutes, { prefix: '/users' });
  await app.register(householdRoutes, { prefix: '/households' });
  await app.register(accountRoutes, { prefix: '/accounts' });
  await app.register(categoryRoutes, { prefix: '/categories' });
  await app.register(transactionRoutes, { prefix: '/transactions' });
  await app.register(importRoutes, { prefix: '/transactions' });
  await app.register(budgetRoutes, { prefix: '/budgets' });
  await app.register(savingsGoalRoutes, { prefix: '/savings-goals' });
  await app.register(recurringTransactionRoutes, { prefix: '/recurring-transactions' });
  await app.register(feedbackRoutes, { prefix: '/feedback' });
  await app.register(notificationRoutes, { prefix: '/notifications' });
  await app.register(dashboardRoutes, { prefix: '/dashboard' });

  return app;
}

/**
 * Start the server
 */
export async function startServer(): Promise<void> {
  let app: FastifyInstance | null = null;

  try {
    // Build app FIRST - this registers /health route immediately
    app = await buildApp();

    // Railway provides PORT via environment variable
    const port = Number(process.env.PORT) || env.PORT;
    
    console.log(`📡 Starting server on port ${port}...`);
    console.log(`   PORT env var: ${process.env.PORT || 'not set'}`);
    console.log(`   Using port: ${port}`);
    
    // Start server IMMEDIATELY so health check can respond
    await app.listen({
      port,
      host: '0.0.0.0',
    });

    console.log(`
🚀 Recta API is running!
   
   Port:       ${port}
   Health:     http://0.0.0.0:${port}/health
   Swagger UI: http://0.0.0.0:${port}/docs
   Environment: ${env.NODE_ENV}
`);

    // Initialize services AFTER server is listening (non-blocking)
    // This allows health check to work even if these fail
    setImmediate(async () => {
      // Run migrations automatically in production or when FIRST_RUN=true
      // This ensures new migrations are applied on every deploy
      const shouldRunMigrations = isProduction || process.env.FIRST_RUN === 'true';
      
      if (shouldRunMigrations) {
        try {
          console.log('🚀 Running database migrations...');
          await runMigrations();
          console.log('✅ Migrations completed successfully');
        } catch (error) {
          console.error('❌ Failed to run migrations:', error);
          if (error instanceof Error) {
            console.error('Migration error details:', error.message);
            console.error('Stack:', error.stack);
          }
          // Don't exit - allow server to start and respond to health checks
          // Migrations can be retried manually or on next deploy
          console.warn('⚠️  Server will continue running despite migration failure');
          console.warn('⚠️  Health check will still respond, but some features may not work');
        }
      }

      try {
        console.log('🔧 Initializing Firebase...');
        initializeFirebase();
        console.log('✅ Firebase initialized');
      } catch (error) {
        console.error('⚠️  Firebase initialization failed:', error);
        // Don't exit - server can still respond to health checks
      }

      try {
        console.log('🔧 Connecting to database...');
        await connectDatabase();
        console.log('✅ Database connected');
      } catch (error) {
        console.error('⚠️  Database connection failed:', error);
        // Don't exit - server can still respond to health checks
      }
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    if (error instanceof Error) {
      console.error('Error details:', error.message);
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n📴 Shutting down gracefully...');

    if (app) {
      await app.close();
    }
    await disconnectDatabase();

    console.log('👋 Server stopped');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}


