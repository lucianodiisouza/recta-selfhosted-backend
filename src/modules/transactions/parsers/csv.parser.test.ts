import { describe, expect, it } from 'vitest';

import { parseCsv } from './csv.parser.js';

const summary = (text: string) => parseCsv(text).rows.map((r) => [r.description, r.amount, r.type]);

describe('parseCsv', () => {
  it('parses rows with a ; delimiter and skips the header', () => {
    const { rows, skipped } = parseCsv('data;descricao;valor\n15/01/2024;Salario;2500.00\n16/01/2024;Café;-12.50\n');

    expect(rows.map((r) => [r.description, r.amount, r.type])).toEqual([
      ['Salario', 2500, 'INCOME'],
      ['Café', 12.5, 'EXPENSE'],
    ]);
    expect(rows[0]?.date.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    expect(skipped).toEqual([]);
  });

  it('parses rows with a , delimiter and ISO dates', () => {
    expect(summary('date,description,amount\n2024-02-01,Freelance,800.00\n')).toEqual([['Freelance', 800, 'INCOME']]);
  });

  it('works without a header and keeps the first line', () => {
    expect(summary('15/01/2024;Salary;100,00\n16/01/2024;Rent;-50,00\n')).toEqual([
      ['Salary', 100, 'INCOME'],
      ['Rent', 50, 'EXPENSE'],
    ]);
  });

  it('does not mistake a first line with a bad date for a header', () => {
    const { rows, skipped } = parseCsv('32/13/2024;Typo;-10,00\n16/01/2024;Fine;-5,00\n');

    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([{ line: 1, reason: 'invalid-date' }]);
  });

  it('takes the columns named in the header, in any order, and ignores the extra ones', () => {
    const text = 'Valor;Data;Saldo;Descrição\n-100;05/11/2026;250;Rent\n';

    expect(summary(text)).toEqual([['Rent', 100, 'EXPENSE']]);
  });

  it('does not glue an extra column to the amount when there is no header names (100 and 250 stay apart)', () => {
    const { rows, skipped } = parseCsv('05/11/2026;Rent;-100;250\n');

    expect(rows).toEqual([]);
    expect(skipped).toEqual([{ line: 1, reason: 'column-count' }]);
  });

  it('rejects a header that names neither the columns nor three columns', () => {
    expect(() => parseCsv('a;b;c;d\n1;2;3;4\n')).toThrow(/header must name/);
  });

  it('reads quoted amounts with the same separator as the delimiter', () => {
    expect(summary('date,description,amount\n2024-03-10,"Rent, March","-1.234,56"\n')).toEqual([['Rent, March', 1234.56, 'EXPENSE']]);
  });

  it('reads English grouping and refuses ambiguous amounts, reporting the line', () => {
    const { rows, skipped } = parseCsv('date;description;amount\n2024-03-10;A;-1,234.50\n2024-03-11;B;1.234\n2024-03-12;C;abc\n');

    expect(rows.map((r) => r.amount)).toEqual([1234.5]);
    expect(skipped).toEqual([
      { line: 3, reason: 'ambiguous-amount' },
      { line: 4, reason: 'invalid-amount' },
    ]);
  });

  it('accepts dd-MM-yyyy and a time after the date, dropping the time', () => {
    const { rows } = parseCsv('data;descricao;valor\n10-03-2024;Luz;100.00\n11/03/2024 23:59:59;Mercado;200.00\n');

    expect(rows.map((r) => r.date.toISOString())).toEqual(['2024-03-10T00:00:00.000Z', '2024-03-11T00:00:00.000Z']);
  });

  it('ignores blank lines and tolerates CRLF', () => {
    expect(summary('data;descricao;valor\r\n\r\n15/01/2024;A;1,50\r\n')).toEqual([['A', 1.5, 'INCOME']]);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('\n\n').rows).toEqual([]);
  });
});
