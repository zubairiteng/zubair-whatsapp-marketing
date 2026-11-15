/**
 * Advanced CSV & recipient parser with smart column detection,
 * RFC 4180 quote parsing, phone normalization, and row-level validation.
 */

export interface CsvRowValidation {
  rowNumber: number;
  companyOrName?: string;
  rawValue: string;
  status: 'valid' | 'invalid' | 'skipped';
  reason?: string;
  normalized?: string;
}

export interface CsvParseSummary {
  recipients: string[]; // Normalized as digits@c.us
  totalRows: number;
  validCount: number;
  invalidCount: number;
  detectedColumnName?: string;
  detectedColumnIndex?: number;
  rowDetails: CsvRowValidation[];
}

/**
 * Tokenize a single CSV line according to RFC 4180 rules, correctly respecting
 * quotes, escaped quotes, and commas inside quoted fields.
 */
function tokenizeCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          // Escaped quote ("")
          current += '"';
          i += 2;
          continue;
        } else {
          // Closing quote
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        current += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ',' || char === '\t' || char === ';') {
        fields.push(current.trim());
        current = '';
        i++;
      } else {
        current += char;
        i++;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Common column names that indicate phone numbers across business spreadsheets.
 */
const PHONE_COLUMN_REGEX = /^(whatsapp_?number|whatsapp|phone_?number|phone|mobile_?number|mobile|contact_?number|contact|cell_?number|cell|tel|telephone)$/i;

/**
 * Clean and normalize a phone string to Pakistani / E.164 standard digits.
 * Returns null if the value is not a plausible phone number.
 */
export function normalizePhoneNumber(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // If it already has WhatsApp JID format
  if (trimmed.endsWith('@c.us') || trimmed.endsWith('@s.whatsapp.net')) {
    const digitsOnly = trimmed.split('@')[0].replace(/[^0-9]/g, '');
    if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
      return digitsOnly;
    }
  }

  // Reject URLs, emails, query strings, and hashes
  if (
    trimmed.includes('http://') ||
    trimmed.includes('https://') ||
    trimmed.includes('www.') ||
    trimmed.includes('/') ||
    trimmed.includes('?') ||
    trimmed.includes('=') ||
    trimmed.includes('&') ||
    /[a-zA-Z]/.test(trimmed)
  ) {
    return null;
  }

  // Strip all formatting symbols: +, -, spaces, parentheses, dots
  let digits = trimmed.replace(/[^0-9]/g, '');

  // Reject short codes, postal codes, and huge numbers (< 10 or > 15 digits)
  if (digits.length < 10 || digits.length > 15) {
    return null;
  }

  // Pakistani phone normalization:
  // Case 1: starts with 03xx (e.g. 03001234567 -> 923001234567)
  if (digits.startsWith('03') && digits.length === 11) {
    digits = '92' + digits.substring(1);
  }
  // Case 2: starts with 3xx (e.g. 3001234567 -> 923001234567)
  else if (digits.startsWith('3') && digits.length === 10) {
    digits = '92' + digits;
  }
  // Case 3: starts with 9203xx (extra 0 error -> 923xx)
  else if (digits.startsWith('9203') && digits.length === 13) {
    digits = '92' + digits.substring(3);
  }

  // Final check: standard length 10 to 15 digits
  if (/^[1-9][0-9]{9,14}$/.test(digits)) {
    return digits;
  }

  return null;
}

/**
 * Parse raw CSV or multi-line text input with full column detection and error reporting.
 */
export function parseCsvRecipientsWithSummary(text: string): CsvParseSummary {
  const lines = text.split(/\r\n?|\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return {
      recipients: [],
      totalRows: 0,
      validCount: 0,
      invalidCount: 0,
      rowDetails: [],
    };
  }

  // Check if first line is a header
  const firstLineTokens = tokenizeCsvLine(lines[0]);
  let phoneColIndex = -1;
  let detectedColumnName: string | undefined;

  for (let colIdx = 0; colIdx < firstLineTokens.length; colIdx++) {
    const colName = firstLineTokens[colIdx].trim();
    if (PHONE_COLUMN_REGEX.test(colName)) {
      phoneColIndex = colIdx;
      detectedColumnName = colName;
      break;
    }
  }

  // If no obvious header by name, check if row 0 has non-numeric headers and other rows have numbers
  const hasHeader = phoneColIndex !== -1 || (
    firstLineTokens.some(t => /[a-zA-Z_]/.test(t)) &&
    lines.length > 1 &&
    tokenizeCsvLine(lines[1]).some(t => normalizePhoneNumber(t) !== null)
  );

  // If header exists but wasn't matched by regex, find the column with the highest ratio of phone numbers
  if (hasHeader && phoneColIndex === -1 && lines.length > 1) {
    const colScores = new Array(firstLineTokens.length).fill(0);
    const sampleRows = lines.slice(1, Math.min(lines.length, 10));
    for (const row of sampleRows) {
      const tokens = tokenizeCsvLine(row);
      tokens.forEach((t, idx) => {
        if (normalizePhoneNumber(t)) colScores[idx]++;
      });
    }
    const maxScore = Math.max(...colScores);
    if (maxScore > 0) {
      phoneColIndex = colScores.indexOf(maxScore);
      detectedColumnName = firstLineTokens[phoneColIndex];
    }
  }

  const startRowIndex = hasHeader ? 1 : 0;
  const rowDetails: CsvRowValidation[] = [];
  const validSet = new Set<string>();

  for (let i = startRowIndex; i < lines.length; i++) {
    const rowNumber = i + 1;
    const tokens = tokenizeCsvLine(lines[i]);
    const companyOrName = tokens[0] || undefined;

    let targetValue = '';
    if (phoneColIndex !== -1 && phoneColIndex < tokens.length) {
      targetValue = tokens[phoneColIndex];
    } else {
      // Single column or fallback: find first token that looks like a number
      targetValue = tokens.find(t => normalizePhoneNumber(t) !== null) || tokens[0] || '';
    }

    if (!targetValue) {
      rowDetails.push({
        rowNumber,
        companyOrName,
        rawValue: '',
        status: 'skipped',
        reason: 'Empty phone number field',
      });
      continue;
    }

    const normalized = normalizePhoneNumber(targetValue);
    if (normalized) {
      const fullJid = `${normalized}@c.us`;
      validSet.add(fullJid);
      rowDetails.push({
        rowNumber,
        companyOrName,
        rawValue: targetValue,
        status: 'valid',
        normalized: fullJid,
      });
    } else {
      rowDetails.push({
        rowNumber,
        companyOrName,
        rawValue: targetValue,
        status: 'invalid',
        reason: `Invalid phone format '${targetValue.length > 25 ? targetValue.slice(0, 22) + '...' : targetValue}'`,
      });
    }
  }

  const recipients = Array.from(validSet);
  const validCount = rowDetails.filter(r => r.status === 'valid').length;
  const invalidCount = rowDetails.filter(r => r.status === 'invalid' || r.status === 'skipped').length;

  return {
    recipients,
    totalRows: lines.length - startRowIndex,
    validCount,
    invalidCount,
    detectedColumnName,
    detectedColumnIndex: phoneColIndex,
    rowDetails,
  };
}
