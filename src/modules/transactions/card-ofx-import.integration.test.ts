import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../shared/db/prisma.js';
import { buildCardOfxPreview, resolveCardAccount } from './card-ofx-import.service.js';

/**
 * The card invoice preview against a real Postgres: what it reads of the stored invoice payments. Skipped unless
 * IMPORT_DB_TEST_URL points at a SCRATCH database that already has the migrations applied (vitest.config.ts hands that
 * URL to the app's Prisma client):
 *
 *   createdb up_s9 && DATABASE_URL=postgresql://.../up_s9 npx prisma migrate deploy
 *   IMPORT_DB_TEST_URL=postgresql://.../up_s9 npx vitest run src/modules/transactions/card-ofx-import.integration.test.ts
 *
 * Never point it at a database you care about: it creates households and removes them afterwards, but it does write.
 */
const enabled = Boolean(process.env.IMPORT_DB_TEST_URL);

const FILE = Buffer.from(
  [
    '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>',
    '<DTSTART>20251102<DTEND>20251202',
    '<STMTTRN><DTPOSTED>20251110<TRNAMT>-60.00<FITID>fit-market<MEMO>Corner market</STMTTRN>',
    '<STMTTRN><DTPOSTED>20251115<TRNAMT>-40.00<FITID>fit-shoes<MEMO>Shoe store</STMTTRN>',
    '<STMTTRN><DTPOSTED>20251103<TRNAMT>85.00<FITID>fit-pay<MEMO>Pagamento recebido</STMTTRN>',
    '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
  ].join('\n'),
);

// Dates are in 2025 so that every payment is already in the past whenever the test runs.
describe.skipIf(!enabled)('card invoice preview on Postgres', { timeout: 30_000 }, () => {
  const households: string[] = [];
  const newHousehold = async () => {
    const id = (await prisma.household.create({ data: { name: 'Card OFX test' } })).id;
    households.push(id);
    return id;
  };
  const newCard = async (householdId: string) =>
    (await prisma.account.create({ data: { householdId, name: 'Card', type: 'CREDIT', dueDay: 9 } })).id;
  const payment = (householdId: string, accountId: string, tag: string, amount = 85) =>
    prisma.transaction.create({
      data: { householdId, accountId, type: 'EXPENSE', categoryName: 'OTHER_EXPENSES', amount, date: new Date('2025-11-03T00:00:00Z'), attachmentUrl: tag },
    });

  afterAll(async () => {
    for (const id of households) await prisma.household.delete({ where: { id } });
    await prisma.$disconnect();
  });

  beforeAll(() => {
    expect(process.env.DATABASE_URL).toBe(process.env.IMPORT_DB_TEST_URL);
  });

  it('counts the previous invoice payment by its tag, not by its date, and reads nothing else', async () => {
    const householdId = await newHousehold();
    const cardId = await newCard(householdId);
    // The payment of the November invoice is dated 3 Nov (inside the December window) and tagged `2025-10`.
    await payment(householdId, cardId, `invoice_pay:${cardId}:2025-10`);

    const preview = await buildCardOfxPreview({ account: await resolveCardAccount(cardId), buffer: FILE });

    expect(preview.lines.map((l) => [l.memo, l.status])).toEqual([
      ['Corner market', 'new'],
      ['Shoe store', 'new'],
      ['Pagamento recebido', 'payment'],
    ]);
    expect(preview).toMatchObject({ monthKey: '2025-12', ofxTotal: 100, payment: { state: 'matches', recordedTotal: 85 } });
    expect(await prisma.transaction.count({ where: { householdId } })).toBe(1);
  });

  it('does not count payments of another card or household', async () => {
    const mine = await newHousehold();
    const theirs = await newHousehold();
    const myCard = await newCard(mine);
    const otherCard = await newCard(mine);
    const theirCard = await newCard(theirs);
    await payment(mine, otherCard, `invoice_pay:${otherCard}:2025-10`);
    await payment(theirs, theirCard, `invoice_pay:${theirCard}:2025-10`);
    await payment(theirs, theirCard, `invoice_pay:${myCard}:2025-10`);

    const preview = await buildCardOfxPreview({ account: await resolveCardAccount(myCard), buffer: FILE });

    expect(preview.payment).toMatchObject({ state: 'missing', recorded: [], recordedTotal: 0 });
  });
});
