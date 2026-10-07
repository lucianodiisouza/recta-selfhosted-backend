import { BadRequestError } from '../../../shared/errors/app-error.js';
import {
  buildUtcDate,
  cleanDescription,
  parseAmountText,
  toRow,
  type ParseResult,
  type SkipReason,
} from './statement.common.js';

type Column = 'date' | 'description' | 'amount';

// Header names are compared lower-case and without accents.
const HEADER_ALIASES: Record<Column, string[]> = {
  date: ['date', 'data', 'dt', 'data lancamento', 'posted'],
  description: ['description', 'descricao', 'historico', 'memo', 'lancamento', 'details', 'detalhes'],
  amount: ['amount', 'valor', 'value', 'montante'],
};
const COLUMNS = Object.keys(HEADER_ALIASES) as Column[];

const normalizeHeader = (cell: string) =>
  cell
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();

/** Splits one line, honouring double quotes so `"1.234,56"` or `"Smith, John"` stay in one cell. */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i] as string;
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/** `dd/MM/yyyy`, `dd-MM-yyyy` or `yyyy-MM-dd`, optionally followed by a time that is ignored. */
function parseCsvDate(raw: string): Date | null {
  const value = raw.trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?Z?$/, '');
  const dayFirst = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(value);
  if (dayFirst) return buildUtcDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return iso ? buildUtcDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) : null;
}

/** Looks like money, valid or not: used only to tell a header from a data line with a bad cell. */
const looksNumeric = (cell: string) => /\d/.test(cell) && /^[\s\-+()R$\d.,]+$/.test(cell);

export function parseCsv(text: string): ParseResult {
  const result: ParseResult = { rows: [], skipped: [], warnings: [] };
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return result;

  const delimiter = (lines[first] as string).includes(';') ? ';' : ',';
  const firstCells = splitLine(lines[first] as string, delimiter);

  // The header is optional: a first line that holds a date or a number is already data.
  const hasHeader = parseCsvDate(firstCells[0] ?? '') === null && !firstCells.some(looksNumeric);
  let columns: Record<Column, number> = { date: 0, description: 1, amount: 2 };
  let exactCells: number | null = 3;

  if (hasHeader) {
    const names = firstCells.map(normalizeHeader);
    const found = COLUMNS.map((column) => names.findIndex((name) => HEADER_ALIASES[column].includes(name)));
    if (found.every((index) => index >= 0)) {
      columns = { date: found[0] as number, description: found[1] as number, amount: found[2] as number };
      exactCells = null; // columns chosen by name: extra columns after the amount are not part of the value
    } else if (firstCells.length !== 3) {
      throw new BadRequestError(
        'The CSV header must name the date, description and amount columns (for example "Date;Description;Amount").',
      );
    }
  }

  const needed = Math.max(columns.date, columns.description, columns.amount) + 1;

  for (let index = hasHeader ? first + 1 : first; index < lines.length; index++) {
    const line = (lines[index] as string).trim();
    if (line.length === 0) continue;
    const skip = (reason: SkipReason) => result.skipped.push({ line: index + 1, reason });

    const cells = splitLine(line, delimiter);
    if (cells.length < needed || (exactCells !== null && cells.length !== exactCells)) {
      skip('column-count');
      continue;
    }

    const date = parseCsvDate(cells[columns.date] as string);
    if (date === null) {
      skip('invalid-date');
      continue;
    }
    const amount = parseAmountText(cells[columns.amount] as string);
    if ('error' in amount) {
      skip(amount.error);
      continue;
    }
    result.rows.push(toRow(date, cleanDescription(cells[columns.description]), amount.cents, amount.negative));
  }

  return result;
}
