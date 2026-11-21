// A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers as the reference on every input {text, header} -> {columns, rows, errors}:
// the text is read once, left to right, with commas and double quotes; a U+FEFF at the very
// start is dropped; a record ends at LF or CRLF and an empty line is no record; outside quotes
// a CR not followed by LF is dropped (stray_cr); a field opening with a quote runs to the next
// quote that is not doubled, "" inside it is one quote, each CRLF or lone CR inside it reads as
// LF, what follows its closing quote up to the next comma or line break is appended as it stands
// (quote_junk when the field ends), and a quote that never closes is a literal character with the
// text after it read again as unquoted (unterminated_quote); a quote inside an unquoted field is
// a literal character; fields stay strings, never trimmed or converted; columns is the first
// record when header is true, else null; rows holds the records after it, each padded with ""
// (short_row) or cut (long_row) to the first record's width; each error is {code, line, row} in
// the order met, line the 1-based line its record starts on, row its record's index in rows
// (null for the header).
//
// How it is fast: the reference walks one character at a time and grows every field a character
// at a time. This reader jumps instead. A record whose line holds no quote and no stray CR is
// taken whole and split on commas in one native call. Every other field is cut with indexOf
// jumps to its next delimiter, so a plain field costs one slice and a quoted field one slice per
// line break or doubled quote inside it, instead of one step per character. Nothing is kept from
// one call to the next, and each case is answered alone.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on, and the index in rows it takes (null: header).
  let recordLine = 1;
  let recordRow = null;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field starting at `start`, with `init` already in it. A CR not followed by
  // LF is dropped (stray_cr) and the field goes on; the field ends at a comma, a line break, or
  // the end of the text. `added` counts the characters kept after `init`.
  function readUnquoted(start, init) {
    let parts = null;
    let scan = start;
    for (;;) {
      const iComma = text.indexOf(',', scan);
      const iLf = text.indexOf('\n', scan);
      const iCr = text.indexOf('\r', scan);
      let idx = -1;
      let kind = COMMA;
      if (iComma !== -1) {
        idx = iComma;
        kind = COMMA;
      }
      if (iLf !== -1 && (idx === -1 || iLf < idx)) {
        idx = iLf;
        kind = BREAK;
      }
      if (iCr !== -1 && (idx === -1 || iCr < idx)) {
        idx = iCr;
        kind = BREAK;
      }
      if (idx === -1) {
        const tail = text.slice(scan);
        const value = parts === null ? init + tail : init + parts.join('') + tail;
        pos = n;
        return { value, ended: END, added: value.length - init.length };
      }
      if (kind === BREAK && text.charCodeAt(idx) === 13 && text.charCodeAt(idx + 1) !== 10) {
        // A lone CR outside quotes: dropped, and the field goes on after it.
        pushError('stray_cr');
        if (parts === null) parts = [];
        parts.push(text.slice(scan, idx));
        scan = idx + 1;
        continue;
      }
      const seg = text.slice(scan, idx);
      const value = parts === null ? init + seg : init + parts.join('') + seg;
      if (kind === COMMA) {
        pos = idx + 1;
        return { value, ended: COMMA, added: value.length - init.length };
      }
      // LF, or a CR followed by LF: one line break, and the record ends.
      pos = idx + (text.charCodeAt(idx) === 13 ? 2 : 1);
      line += 1;
      return { value, ended: BREAK, added: value.length - init.length };
    }
  }

  // Reads a quoted field whose opening quote is at pos. Runs to the next quote that is not
  // doubled; "" inside it is one quote, and each CRLF or lone CR inside it reads as LF.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let scan = open + 1;
    for (;;) {
      const iQuote = text.indexOf('"', scan);
      const iCr = text.indexOf('\r', scan);
      const iLf = text.indexOf('\n', scan);
      let idx = -1;
      let kind = 0; // 0: quote, 1: CR, 2: LF
      if (iQuote !== -1) {
        idx = iQuote;
        kind = 0;
      }
      if (iCr !== -1 && (idx === -1 || iCr < idx)) {
        idx = iCr;
        kind = 1;
      }
      if (iLf !== -1 && (idx === -1 || iLf < idx)) {
        idx = iLf;
        kind = 2;
      }
      if (idx === -1) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as an unquoted field.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        return readUnquoted(open + 1, '"');
      }
      if (kind === 0) {
        if (text.charCodeAt(idx + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(scan, idx + 1));
          scan = idx + 2;
          continue;
        }
        // The closing quote.
        const tail = text.slice(scan, idx);
        const value = parts === null ? tail : parts.join('') + tail;
        pos = idx + 1;
        if (pos >= n) return { value, ended: END };
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          return { value, ended: COMMA };
        }
        if (c === 10) {
          pos += 1;
          line += 1;
          return { value, ended: BREAK };
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          return { value, ended: BREAK };
        }
        // What follows the closing quote is appended as it stands, up to the next comma or
        // line break.
        const junk = readUnquoted(pos, value);
        if (junk.added > 0) pushError('quote_junk');
        return junk;
      }
      if (kind === 1) {
        if (parts === null) parts = [];
        parts.push(text.slice(scan, idx));
        parts.push('\n');
        line += 1;
        scan = idx + 1 + (text.charCodeAt(idx + 1) === 10 ? 1 : 0);
        continue;
      }
      // A LF inside quotes: kept as it stands, and the line count moves on.
      if (parts === null) parts = [];
      parts.push(text.slice(scan, idx + 1));
      line += 1;
      scan = idx + 1;
    }
  }

  while (pos < n) {
    // Lines with no characters are no records.
    for (;;) {
      if (text.charCodeAt(pos) === 10) {
        pos += 1;
        line += 1;
      } else if (text.charCodeAt(pos) === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the whole record is one line with no quote and no stray CR, so its fields are
    // the line split on commas. A CR is allowed only as the last character before the LF.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? n : lf;
    const seg = text.slice(pos, lineEnd);
    const firstCr = seg.indexOf('\r');
    let fields = null;
    let lastQuoted = false;
    if (seg.indexOf('"') === -1 && (firstCr === -1 || (lf !== -1 && firstCr === seg.length - 1))) {
      const body = firstCr === seg.length - 1 ? seg.slice(0, -1) : seg;
      fields = body.split(',');
      pos = lf === -1 ? n : lf + 1;
      if (lf !== -1) line += 1;
    } else {
      fields = [];
      let ended;
      do {
        lastQuoted = text.charCodeAt(pos) === 34;
        const field = lastQuoted ? readQuoted() : readUnquoted(pos, '');
        fields.push(field.value);
        ended = field.ended;
      } while (ended === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr
    // errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
