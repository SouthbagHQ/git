// A small, safe Markdown renderer for READMEs: headings, paragraphs, lists, block quotes, fenced and
// indented code, rules, inline code, bold, italic and links. Everything is escaped; raw HTML in the
// source is shown as text. Links must be http(s), mailto, an #anchor or a relative path.

import { raw } from 'hono/html';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const unescapeHtml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

export interface MarkdownOptions {
  /** Prefix for relative links, e.g. "/alice/notes/src/main". */
  base?: string;
}

/** Returns an escaped URL for href, or null when the link isn't allowed. `url` is already HTML-escaped. */
function safeHref(url: string, opts: MarkdownOptions): string | null {
  const plain = unescapeHtml(url).trim();
  if (/^(https?:\/\/|mailto:)/i.test(plain)) return escapeHtml(plain);
  if (plain.startsWith('#')) return escapeHtml(plain);
  // Relative paths only: no scheme, no protocol-relative //host.
  if (/^[a-z][a-z0-9+.-]*:/i.test(plain) || plain.startsWith('//') || plain.startsWith('\\')) return null;
  if (plain.startsWith('/')) return escapeHtml(plain);
  const base = (opts.base ?? '').replace(/\/+$/, '');
  return escapeHtml(base ? `${base}/${plain.replace(/^\.\//, '')}` : plain);
}

function inline(text: string, opts: MarkdownOptions): string {
  // Code spans first, kept out of every other rule.
  const codes: string[] = [];
  let s = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, _ticks: string, code: string) => {
    codes.push(`<code>${escapeHtml(code.trim())}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  const links: string[] = [];
  const keep = (htmlText: string) => { links.push(htmlText); return `\u0001${links.length - 1}\u0001`; };
  // Images become links to the image (no images inline).
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^]*?&quot;)?\)/g, (all, alt: string, url: string) => {
    const href = safeHref(url, opts);
    return href ? keep(`<a href="${href}" rel="nofollow noopener">${alt || 'Image'}</a>`) : alt;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^]*?&quot;)?\)/g, (all, label: string, url: string) => {
    const href = safeHref(url, opts);
    return href ? keep(`<a href="${href}" rel="nofollow noopener">${label}</a>`) : label;
  });
  s = s.replace(/&lt;(https?:\/\/[^\s&]+(?:&amp;[^\s&]+)*)&gt;/g, (all, url: string) => {
    const href = safeHref(url, opts);
    return href ? keep(`<a href="${href}" rel="nofollow noopener">${url}</a>`) : all;
  });
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>').replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\*)/g, '$1<em>$2</em>').replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => links[Number(i)]);
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

/** Renders Markdown to safe HTML (wrapped in raw(), so it can go straight into an html`` template). */
export function renderMarkdown(source: string, opts: MarkdownOptions = {}) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;
  const isBlank = (l: string) => /^\s*$/.test(l);
  const listItem = /^\s{0,6}([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const startsBlock = (l: string) => /^\s{0,3}(#{1,6}\s|```|~~~|>|(-\s*){3,}$|(\*\s*){3,}$|(_\s*){3,}$)/.test(l) || listItem.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = line.match(/^\s{0,3}(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^( {4}|\t)/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (isBlank(lines[i]) && /^( {4}|\t)/.test(lines[i + 1] ?? '')))) {
        body.push(lines[i].replace(/^( {4}|\t)/, ''));
        i++;
      }
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2], opts)}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s{0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${renderMarkdownString(body.join('\n'), opts)}</blockquote>`);
      continue;
    }

    const item = line.match(listItem);
    if (item) {
      const ordered = /\d/.test(item[1]);
      const items: string[] = [];
      let current: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(listItem);
        if (m && /\d/.test(m[1]) === ordered) {
          if (current.length) items.push(current.join(' '));
          current = [m[2]];
        } else if (m) {
          break;
        } else if (!isBlank(l) && !startsBlock(l) && current.length) {
          current.push(l.trim());
        } else break;
        i++;
      }
      if (current.length) items.push(current.join(' '));
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(t => `<li>${inline(t, opts)}</li>`).join('')}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i]))) para.push(lines[i++].trim());
    out.push(`<p>${inline(para.join('\n'), opts).replace(/\n/g, ' ')}</p>`);
  }
  return out.join('\n');
}

function renderMarkdownString(source: string, opts: MarkdownOptions): string {
  return renderMarkdown(source, opts);
}

/** renderMarkdown, ready for a template slot. */
export const markdown = (source: string, opts: MarkdownOptions = {}) => raw(renderMarkdown(source, opts));
