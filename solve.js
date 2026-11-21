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
// at a time. This reader jumps instead: an unquoted field is cut with two indexOf jumps (comma,
// line feed) and one slice, and a CR in it is found through one list of every CR in the text,
// walked once up front, instead of a search per field that would walk past the field's end
// whenever the next CR sits far away. A quoted field jumps the same way between its quotes and
// line breaks, with each CR inside it found only inside the span up to the next quote or break.
// Nothing is kept from one call to the next, and each case is answered alone.

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

  // Where every CR in the text sits, in order, with a pointer to the first one not yet passed:
  // an unquoted field holds a CR exactly when that pointer is before the field's end. One scan
  // up front replaces a search for a CR in every field, which would walk past each field's end
  // whenever the next CR sits far away.
  const crList = [];
  {
    let ci = text.indexOf('\r');
    while (ci !== -1) {
      crList.push(ci);
      ci = text.indexOf('\r', ci + 1);
    }
  }
  const crLen = crList.length;
  let crPtr = 0;

  // How the last quoted field read ended (readQuoted writes it; the record loop reads it).
  let qEnded = COMMA;

  function pushError(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // `seg` with every stray CR dropped (one stray_cr error each); a CR that ends the segment as
  // part of a CRLF is dropped with no error. Used only when a field's slice holds a CR.
  function cleanStray(seg, ended) {
    let parts = null;
    let scan = 0;
    for (;;) {
      const i = seg.indexOf('\r', scan);
      if (i === -1) {
        const tail = seg.slice(scan);
        return parts === null ? tail : parts.join('') + tail;
      }
      if (i === seg.length - 1 && ended === BREAK) {
        // The CRLF that ends the field: dropped, no error.
        const tail = seg.slice(scan, i);
        return parts === null ? tail : parts.join('') + tail;
      }
      pushError('stray_cr');
      if (parts === null) parts = [];
      parts.push(seg.slice(scan, i));
      scan = i + 1;
    }
  }

  // Reads an unquoted field starting at `start`, with `init` already in it. A CR not followed by
  // LF is dropped (stray_cr) and the field goes on; the field ends at a comma, a line break, or
  // the end of the text. `added` counts the characters kept after `init`. Only used for quote
  // junk and unterminated quotes; the common unquoted field is inlined in the record loop.
  function readUnquoted(start, init) {
    let parts = null;
    let scan = start;
    for (;;) {
      const iComma = text.indexOf(',', scan);
      const iLf = text.indexOf('\n', scan);
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
      if (idx === -1) {
        const tail = cleanStray(text.slice(scan), END);
        const value = parts === null ? init + tail : init + parts.join('') + tail;
        pos = n;
        return { value, ended: END, added: value.length - init.length };
      }
      const seg = text.slice(scan, idx);
      const cr = seg.indexOf('\r');
      if (cr !== -1) {
        // A CR inside the field: drop it (stray_cr) unless it is the CRLF ending the field,
        // and keep reading from after it.
        if (cr === seg.length - 1 && kind === BREAK) {
          const value = parts === null ? init + seg.slice(0, -1) : init + parts.join('') + seg.slice(0, -1);
          pos = idx + 1;
          line += 1;
          return { value, ended: BREAK, added: value.length - init.length };
        }
        pushError('stray_cr');
        if (parts === null) parts = [];
        parts.push(seg.slice(0, cr));
        scan = scan + cr + 1;
        continue;
      }
      const value = parts === null ? init + seg : init + parts.join('') + seg;
      if (kind === COMMA) {
        pos = idx + 1;
        return { value, ended: COMMA, added: value.length - init.length };
      }
      pos = idx + 1;
      line += 1;
      return { value, ended: BREAK, added: value.length - init.length };
    }
  }

  // Reads a quoted field whose opening quote is at pos, and returns its value; how it ended is
  // left in qEnded. Runs to the next quote that is not doubled; "" inside it is one quote, and
  // each CRLF or lone CR inside it reads as LF.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let parts = null;
    let scan = open + 1;
    for (;;) {
      const iQuote = text.indexOf('"', scan);
      const iLf = text.indexOf('\n', scan);
      let idx = -1;
      let kind = 0; // 0: quote, 1: LF
      if (iQuote !== -1) {
        idx = iQuote;
        kind = 0;
      }
      if (iLf !== -1 && (idx === -1 || iLf < idx)) {
        idx = iLf;
        kind = 1;
      }
      // A CR before that quote or line break, if any: inside quotes it reads as LF.
      const bound = idx === -1 ? n : idx;
      const crAt = text.slice(scan, bound).indexOf('\r');
      if (crAt !== -1) {
        if (parts === null) parts = [];
        parts.push(text.slice(scan, scan + crAt));
        parts.push('\n');
        line += 1;
        scan = scan + crAt + 1 + (text.charCodeAt(scan + crAt + 1) === 10 ? 1 : 0);
        continue;
      }
      if (idx === -1) {
        // The quote never closes: it is a literal character, and the text after it is read
        // again as an unquoted field.
        pos = open + 1;
        line = openLine;
        pushError('unterminated_quote');
        const again = readUnquoted(open + 1, '"');
        qEnded = again.ended;
        return again.value;
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
        if (pos >= n) {
          qEnded = END;
          return value;
        }
        const c = text.charCodeAt(pos);
        if (c === 44) {
          pos += 1;
          qEnded = COMMA;
          return value;
        }
        if (c === 10) {
          pos += 1;
          line += 1;
          qEnded = BREAK;
          return value;
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          qEnded = BREAK;
          return value;
        }
        // What follows the closing quote is appended as it stands, up to the next comma or
        // line break.
        const junk = readUnquoted(pos, value);
        if (junk.added > 0) pushError('quote_junk');
        qEnded = junk.ended;
        return junk.value;
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
    const fields = [];
    let ended;
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        lastQuoted = true;
        fields.push(readQuoted());
        ended = qEnded;
      } else {
        lastQuoted = false;
        // An unquoted field, inlined: two jumps to its end, one slice, and a CR looked for
        // only through the CR pointer, never by searching past the field's end.
        while (crPtr < crLen && crList[crPtr] < pos) crPtr++;
        const iComma = text.indexOf(',', pos);
        const iLf = text.indexOf('\n', pos);
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
        let seg;
        if (idx === -1) {
          seg = text.slice(pos);
          pos = n;
          ended = END;
        } else {
          seg = text.slice(pos, idx);
          pos = idx + 1;
          ended = kind;
          if (kind === BREAK) line += 1;
        }
        const fieldEnd = idx === -1 ? n : idx;
        if (crPtr >= crLen || crList[crPtr] >= fieldEnd) {
          fields.push(seg);
        } else if (crList[crPtr] === fieldEnd - 1) {
          if (ended === BREAK) {
            fields.push(seg.slice(0, -1));
          } else {
            // A trailing CR that is not followed by LF: dropped (stray_cr).
            pushError('stray_cr');
            fields.push(seg.slice(0, -1));
          }
        } else {
          fields.push(cleanStray(seg, ended));
        }
      }
    } while (ended === COMMA);

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
