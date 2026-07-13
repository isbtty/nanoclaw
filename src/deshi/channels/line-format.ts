/**
 * Markdown → LINE-native plain text formatting.
 *
 * LINE Messaging API text messages have zero markup support (no bold, no
 * headings, no tables) — unlike Slack/WhatsApp, which have their own
 * lightweight syntax. Sending raw Claude-style markdown through verbatim
 * (as `deliver()` used to do) leaves literal `**`, `##`, and `|---|` in the
 * chat, which is what prompted this module (see the LINE screenshot in the
 * originating conversation).
 *
 * Strategy: strip markup entirely and reflow structure into readable plain
 * text, using `【】` for bold (idiomatic Japanese chat emphasis — the ASCII
 * bracket a Japanese LINE audience actually reads as emphasis) and stacked
 * lines for tables (LINE has no fixed-width font to align columns with).
 */

/** Fenced code blocks are passed through unmodified (fence markers stripped) so literal `**`/`#`/`|` inside code aren't mangled. */
function splitFencedCode(text: string): Array<{ content: string; isCode: boolean }> {
  const segments: Array<{ content: string; isCode: boolean }> = [];
  const regex = /```[\s\S]*?```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ content: text.slice(lastIndex, match.index), isCode: false });
    }
    segments.push({ content: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ content: text.slice(lastIndex), isCode: false });
  }
  return segments;
}

function stripCodeFence(block: string): string {
  return block.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '');
}

function splitTableRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Convert markdown tables into stacked "▼ title / detail" blocks — LINE has no monospace font to align pipe-delimited columns. */
function formatMarkdownTables(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const headerLine = lines[i];
    const separatorLine = lines[i + 1];
    if (
      headerLine !== undefined &&
      TABLE_ROW_RE.test(headerLine) &&
      separatorLine !== undefined &&
      TABLE_SEPARATOR_RE.test(separatorLine)
    ) {
      const headers = splitTableRow(headerLine);
      i += 2;
      while (i < lines.length && TABLE_ROW_RE.test(lines[i]!)) {
        const cells = splitTableRow(lines[i]!);
        const title = cells[0] ?? '';
        out.push(`▼ ${title}`);
        for (let c = 1; c < headers.length; c++) {
          const value = cells[c] ?? '';
          if (!value) continue;
          out.push(headers.length > 2 && headers[c] ? `　${headers[c]}: ${value}` : `　${value}`);
        }
        out.push('');
        i++;
      }
      continue;
    }
    out.push(headerLine!);
    i++;
  }
  return out.join('\n');
}

/** Strip/reflow inline markdown markers into plain text LINE can render. */
function transformForLine(text: string): string {
  // Bold: **text** / __text__ → 【text】 (Japanese-idiomatic emphasis; LINE text messages have no bold styling)
  text = text.replace(/\*\*(?=[^\s*])([^*]+?)(?<=[^\s*])\*\*/g, '【$1】');
  text = text.replace(/__(?=[^\s_])([^_]+?)(?<=[^\s_])__/g, '【$1】');
  // Italic (single marker) → strip, keep text
  text = text.replace(/(?<!\*)\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?!\*)/g, '$1');
  text = text.replace(/(?<!_)_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?!_)/g, '$1');
  // Headings: ## Title → Title (source content already carries an emoji marker for hierarchy)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');
  // Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  // Horizontal rules
  text = text.replace(/^(-{3,}|\*{3,}|_{3,})\s*$/gm, '');
  // Inline code: `code` → code (no monospace support on LINE)
  text = text.replace(/`([^`\n]+)`/g, '$1');
  return text;
}

/**
 * Convert Claude's markdown into LINE-readable plain text: tables become
 * stacked blocks, bold becomes 【bracketed】, headings/links/rules/inline
 * code lose their markup, and fenced code blocks pass through untouched.
 */
export function formatLine(text: string): string {
  const segments = splitFencedCode(text);
  const out = segments
    .map(({ content, isCode }) => (isCode ? stripCodeFence(content) : transformForLine(formatMarkdownTables(content))))
    .join('');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
