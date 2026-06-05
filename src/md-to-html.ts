/**
 * Markdown → self-contained HTML renderer.
 *
 * Motivation: chat clients that preview a raw `.md` text attachment guess its
 * charset. A BOM-less UTF-8 file with CJK-heavy content is frequently
 * mis-detected (e.g. as GBK/Big5) and rendered as mojibake — ASCII survives,
 * multibyte characters turn into random glyphs. Shipping an HTML document with
 * an explicit `<meta charset="utf-8">` removes the guesswork and previews
 * correctly everywhere, while also rendering markdown structure nicely.
 *
 * Kept dependency-light and brand-neutral on purpose (system fonts, dark-mode
 * aware) so it is safe to use for any deployment.
 */

import { marked } from 'marked';

/** Strip a leading YAML frontmatter block (--- ... ---) if present. */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown;
  const endIdx = markdown.indexOf('\n---', 3);
  if (endIdx === -1) return markdown;
  return markdown.slice(endIdx + 4).trimStart();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render markdown to a complete, self-contained HTML document.
 *
 * Synchronous: `marked.parse` returns a string when no async extensions are
 * registered, which lets callers (e.g. the synchronous outbox reader) convert
 * inline without going async.
 */
export function renderMarkdownToHtml(markdown: string, title?: string): string {
  const stripped = stripFrontmatter(markdown);
  const bodyHtml = marked.parse(stripped, { async: false }) as string;
  const titleTag = title ? `<title>${escapeHtml(title)}</title>` : '';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${titleTag}
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans", sans-serif;
      padding: 16px;
      margin: 0;
      line-height: 1.7;
      color: #1a1a1a;
      font-size: 16px;
      -webkit-text-size-adjust: 100%;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #1c1c1e; color: #e5e5e7; }
      code, pre { background: #2c2c2e; }
      th, td { border-color: #3a3a3c; }
      blockquote { border-color: #48484a; color: #98989d; }
    }
    h1 { font-size: 1.5em; margin-top: 1.2em; }
    h2 { font-size: 1.3em; margin-top: 1.1em; }
    h3 { font-size: 1.1em; margin-top: 1em; }
    p { margin: 0.8em 0; }
    code { background: #f0f0f0; padding: 2px 5px; border-radius: 4px; font-size: 0.9em; }
    pre { background: #f0f0f0; padding: 12px; border-radius: 8px; overflow-x: auto; font-size: 0.85em; line-height: 1.5; }
    pre code { background: none; padding: 0; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.9em; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { font-weight: 600; }
    blockquote { margin: 1em 0; padding: 0.5em 1em; border-left: 3px solid #ddd; color: #666; }
    ul, ol { padding-left: 1.5em; }
    li { margin: 0.3em 0; }
    a { color: #007aff; text-decoration: none; }
    img { max-width: 100%; height: auto; }
    hr { border: none; border-top: 1px solid #ddd; margin: 1.5em 0; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;
}

/** True when the filename should be rendered to HTML before delivery. */
export function isMarkdownAttachment(filename: string): boolean {
  return /\.(md|markdown)$/i.test(filename);
}
