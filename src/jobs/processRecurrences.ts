/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Este script é executado EXCLUSIVAMENTE pelo Cron Job nativo do Railway.
 * NÃO inicia servidor HTTP - apenas processa recorrências e encerra.
 * 
 * Fluxo:
 * 1. Busca recorrências ativas com nextRunAt <= hoje (usando índice otimizado)
 * 2. Para cada recorrência:
 *    - Garante idempotência (não cria duplicações)
 *    - Cria UMA transação correspondente ao período atual
 *    - Se cartão: cria confirmada (paid: true) e consome limite
 *    - Se conta: cria pendente (paid: false) para revisão
 *    - Atualiza lastRunDate e nextRunAt
 *    - Se nextRunAt > endDate: marca como inativa
 * 3. Loga recurrence_id + data processada
 * 4. Encerra processo
 */

// Load environment variables from .env file
import 'dotenv/config';

// Import env to validate environment variables (required for prisma)
// This will validate DATABASE_URL and other required variables
import '../shared/config/env.js';

import { prisma } from '../shared/db/prisma.js';
import { AccountType } from '../shared/enums/index.js';
import { executeRecurringTransaction } from '../modules/recurring-transactions/recurring-transactions.service.js';

/**
 * Calculate next run date based on frequency
 */
function calculateNextRunDate(
  currentDate: Date,
  frequency: 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY'
): Date {
  const next = new Date(currentDate);

  switch (frequency) {
    case 'DAILY':
      next.setDate(next.getDate() + 1);
      break;
    case 'WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'BIWEEKLY':
      next.setDate(next.getDate() + 14);
      break;
    case 'MONTHLY':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'YEARLY':
      next.setFullYear(next.getFullYear() + 1);
      break;
  }

  return next;
}

/**
 * Process all due recurring transactions
 */
async function processDueRecurringTransactions() {
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Normalize to start of day

  console.log(`[CronJob] Starting processing at ${today.toISOString().split('T')[0]}`);

  try {
    // REGRA DE NEGÓCIO: Buscar APENAS recorrências com nextRunAt <= hoje
    // Usa índice otimizado em nextRunAt para performance
    const dueRecurring = await prisma.recurringTransaction.findMany({
      where: {
        isActive: true,
        nextRunAt: {
          lte: today, // nextRunAt is today or in the past
        },
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
      },
      orderBy: { nextRunAt: 'asc' },
    });

    if (dueRecurring.length === 0) {
      console.log(`[CronJob] No recurring transactions due on ${today.toISOString().split('T')[0]}`);
      return;
    }

    console.log(`[CronJob] Found ${dueRecurring.length} recurring transaction(s) due today`);

    let processedCount = 0;
    let skippedCount = 0;
    const errors: Array<{ recurringId: string; error: string }> = [];

    for (const recurring of dueRecurring) {
      try {
        // REGRA DE NEGÓCIO: Idempotência - verificar se transação já existe
        const existingTransaction = await prisma.transaction.findFirst({
          where: {
            householdId: recurring.householdId,
            recurringTransactionId: recurring.id,
            date: today,
          },
        });

        if (existingTransaction) {
          // Transaction already exists - skip (idempotent behavior)
          console.log(
            `[CronJob] ⏭️  Skipping recurring ${recurring.id} - transaction already exists for ${today.toISOString().split('T')[0]}`
          );
          skippedCount++;
          
          // Still update nextRunAt and lastRunDate to prevent reprocessing
          const nextRunAt = calculateNextRunDate(today, recurring.frequency);
          const shouldDeactivate = recurring.endDate && nextRunAt > new Date(recurring.endDate);
          
          await prisma.recurringTransaction.update({
            where: { id: recurring.id },
            data: { 
              nextRunAt,
              lastRunDate: today,
              ...(shouldDeactivate && { isActive: false }),
            },
          });
          continue;
        }

        // Check if today is within the recurring period
        const startDate = new Date(recurring.startDate);
        startDate.setHours(0, 0, 0, 0);
        
        if (today < startDate) {
          // Not yet in the period - skip
          console.log(
            `[CronJob] ⏭️  Skipping recurring ${recurring.id} - startDate is ${startDate.toISOString().split('T')[0]}`
          );
          skippedCount++;
          continue;
        }

        // REGRA DE NEGÓCIO: Criar transação baseada no tipo de conta
        // Cartão de crédito: paid: true (consome limite imediatamente)
        // Conta bancária: paid: false (pendente para revisão)
        const isCreditCard = recurring.account.type === AccountType.CREDIT;
        const shouldCreateAsPaid = isCreditCard;

        // Execute recurring transaction (creates transaction, updates balance if paid, and updates nextRunAt/lastRunDate)
        const result = await executeRecurringTransaction(recurring.id, recurring.householdId, {
          date: today,
          paid: shouldCreateAsPaid,
        });

        // Check if nextRunAt exceeds endDate
        const nextRunAt = result.nextRunAt;
        const shouldDeactivate = recurring.endDate && nextRunAt > new Date(recurring.endDate);

        // Deactivate if needed (lastRunDate and nextRunAt already updated by executeRecurringTransaction)
        if (shouldDeactivate) {
          await prisma.recurringTransaction.update({
            where: { id: recurring.id },
            data: { isActive: false },
          });
        }

        if (result.skipped) {
          // The month already holds an occurrence of this recurrence (idempotency guard): nothing was created.
          skippedCount++;
          console.log(`[CronJob] ⏭️  Skipping recurring ${recurring.id} - the month already has its occurrence`);
          continue;
        }

        processedCount++;
        console.log(
          `[CronJob] ✅ Processed recurring ${recurring.id} (${recurring.description || 'N/A'}) - ` +
          `Account: ${recurring.account.name} (${recurring.account.type}) - ` +
          `Date: ${today.toISOString().split('T')[0]} - ` +
          `Paid: ${shouldCreateAsPaid} - ` +
          `Next: ${nextRunAt.toISOString().split('T')[0]}`
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ recurringId: recurring.id, error: errorMessage });
        console.error(
          `[CronJob] ❌ Error processing recurring ${recurring.id}:`,
          errorMessage
        );
      }
    }

    // Log summary
    console.log(
      `[CronJob] Processing finished. Processed: ${processedCount}, Skipped: ${skippedCount}`
    );
    if (errors.length > 0) {
      console.error('[CronJob] Errors:', errors);
    }
  } catch (error) {
    console.error('[CronJob] Fatal error processing recurring transactions:', error);
    throw error; // Re-throw to exit with error code
  }
}

/**
 * Main entry point for Railway Cron Job
 * This script should be executed directly: node dist/jobs/processRecurrences.js
 */
async function main() {
  try {
    console.log('[CronJob] Connecting to database...');
    // Database connection is handled by prisma client
    
    await processDueRecurringTransactions();
    
    console.log('[CronJob] ✅ Processing completed successfully');
  } catch (error) {
    console.error('[CronJob] ❌ Fatal error:', error);
    process.exit(1);
  } finally {
    // Close database connection
    await prisma.$disconnect();
    console.log('[CronJob] Database connection closed');
    process.exit(0);
  }
}

// Execute if run directly (check if this is the main module)
// In ES modules, import.meta.url contains the file URL
// We check if this file is being executed directly (not imported)
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule || process.argv[1]?.includes('processRecurrences')) {
  main();
}

// Export main function to be called when imported (for Railway cron service)
export { main as runCronJob };

