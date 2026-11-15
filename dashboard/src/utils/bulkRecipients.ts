// The backend caps a bulk batch at 500 messages (ArrayMaxSize on SendBulkMessageDto).
export const BULK_MAX_RECIPIENTS = 500;

// Pre-read cap for the recipients file picker. A phone list is bytes, not media: 2 MiB is roughly
// 100k entries, far past the batch cap, while still stopping a mistaken multi-hundred-MB pick from
// being materialized as a JS string before the textarea ever sees it (same shape as the media
// upload's pre-read check in MessageTester).
export const BULK_RECIPIENTS_FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Parse the bulk-recipients textarea into chat IDs: trims whitespace, drops blanks, de-dupes, and
 * normalizes bare phone numbers to `<digits>@c.us`. An entry with a WhatsApp chat id shape passes
 * through untouched; any other entry containing '@', such as an email column, is dropped. Anything
 * else must carry at least MIN_PHONE_DIGITS digits or it is dropped rather than sent as a
 * meaningless or truncated id.
 *
 * Entries are separated by line endings AND by the comma/semicolon/tab a spreadsheet export writes,
 * because the file picker offers `.csv`. Phone-number formatting (spaces, parentheses, hyphens,
 * a leading plus) is not a separator and is stripped within one entry.
 *
 * All three line endings are accepted. A textarea normalizes CR and CRLF to LF in its own value, but
 * an uploaded file does not go through one: FileReader hands the bytes over as written, so a file
 * saved with classic Mac endings arrives as a single bare-CR line.
 */
import { parseCsvRecipientsWithSummary } from './csvRecipientParser';

export function parseBulkRecipients(text: string): string[] {
  return parseCsvRecipientsWithSummary(text).recipients;
}
