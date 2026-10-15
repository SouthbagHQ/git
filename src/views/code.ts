// Code views: file table, clone box, branch menu, blob with line numbers, diffs and commit rows.
// Markup only; the data comes from src/git/* via the routes. Classes are in public/css/forge.css.

import { html, raw } from 'hono/html';
import { FEES } from '../lib/fees';
import { money, when, type Child } from './layout';

export interface TreeEntry {
  name: string;
  type: 'tree' | 'blob' | 'commit';
  href: string;
  /** The last commit that touched this path, if known. */
  commit?: { message: string; href: string; time: number } | null;
}

/** Forgejo's file table: directories first is the caller's job. `latest` is the bar above it. */
export function fileTable(entries: TreeEntry[], opts: { latest?: { sha: string; href: string; message: string; author: string; time: number } | null; parentHref?: string | null } = {}) {
  return html`${opts.latest ? latestCommit(opts.latest) : ''}
  <table class="file-table"><tbody>
    ${opts.parentHref ? html`<tr class="dir"><td class="name" colspan="3"><a href="${opts.parentHref}">..</a></td></tr>` : ''}
    ${entries.map(e => html`<tr class="${e.type === 'tree' ? 'dir' : 'file'}">
      <td class="name"><span class="kind">${e.type === 'tree' ? 'Folder' : e.type === 'commit' ? 'Link' : 'File'}</span><a href="${e.href}">${e.name}</a></td>
      <td class="message">${e.commit ? html`<a href="${e.commit.href}">${firstLine(e.commit.message)}</a>` : ''}</td>
      <td class="when">${e.commit ? when(e.commit.time) : ''}</td>
    </tr>`)}
  </tbody></table>`;
}

/** The bar with the latest commit (above a file table or a blob). */
export const latestCommit = (l: { sha: string; href: string; message: string; author: string; time: number }) =>
  html`<div class="latest-commit"><strong>${l.author}</strong><span class="message"><a href="${l.href}">${firstLine(l.message)}</a></span><a class="sha" href="${l.href}">${l.sha.slice(0, 10)}</a><span class="muted">${when(l.time)}</span></div>`;

export const firstLine = (message: string) => message.split('\n', 1)[0];

/** Clone URL with a Copy button and the pull request fee beside it. */
export function cloneBox(url: string) {
  return html`<div class="clone-box"><span class="clone-label">HTTPS</span><input id="clone-url" type="text" value="${url}" readonly aria-label="Clone URL"><button class="btn-small js-only" type="button" data-copy="#clone-url">Copy</button><span class="fee">Clone fee ${money(FEES.clone.amount)}. Pulling afterwards requires a pull request.</span></div>`;
}

/** Branch dropdown (a <details> menu: works without JavaScript; forge.js adds the filter). */
export function branchMenu(current: string, branches: Array<{ name: string; href: string }>) {
  return html`<details class="menu-details left branch-menu">
    <summary class="btn-small">Branch: <span class="ref-name">${current}</span></summary>
    <div class="menu" role="menu">
      <input class="js-only" type="search" placeholder="Filter branches" aria-label="Filter branches" data-filter>
      ${branches.map(b => html`<a role="menuitem" href="${b.href}"${b.name === current ? raw(' aria-current="true"') : ''}>${b.name}</a>`)}
      ${branches.length ? '' : html`<p class="menu-note">No branches yet.</p>`}
    </div>
  </details>`;
}

/** "alice / notes / src / main.ts" with links for every part but the last. */
export function breadcrumbs(parts: Array<{ name: string; href?: string }>) {
  return html`<div class="breadcrumbs">${parts.map((p, i) => html`${i ? html`<span class="sep">/</span>` : ''}${p.href ? html`<a href="${p.href}">${p.name}</a>` : html`<span>${p.name}</span>`}`)}</div>`;
}

/** A file with line numbers (each line is #L<n>). Binary or very large files get a note instead. */
export function blobView(opts: { path: string; text: string | null; size: number; rawHref?: string; historyHref?: string; tooLarge?: boolean }) {
  const lines = opts.text == null ? [] : opts.text.replace(/\n$/, '').split('\n');
  const head = html`<div class="blob-head"><span class="path">${opts.path}</span>
    <span class="muted">${opts.text == null ? '' : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'}, `}${formatSize(opts.size)}</span>
    <span class="spacer"></span>
    ${opts.historyHref ? html`<a class="btn-small" href="${opts.historyHref}">History</a>` : ''}
    ${opts.rawHref ? html`<a class="btn-small" href="${opts.rawHref}">Raw</a>` : ''}
  </div>`;
  if (opts.text == null || opts.tooLarge) {
    return html`<div class="blob">${head}<div class="blob-binary">${opts.tooLarge ? 'This file is too large to display.' : 'Binary file not shown.'}</div></div>`;
  }
  return html`<div class="blob">${head}<div class="blob-body"><table class="code-table"><tbody>${lines.map((line, i) =>
    html`<tr id="L${i + 1}"><td class="ln"><a href="#L${i + 1}">${i + 1}</a></td><td class="lc">${line}</td></tr>`)}</tbody></table></div></div>`;
}

export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

export interface DiffLine { kind: 'add' | 'del' | 'ctx'; text: string; oldNo?: number | null; newNo?: number | null }
export interface DiffHunk { header: string; lines: DiffLine[] }
export interface DiffFile {
  path: string;
  oldPath?: string | null;
  change?: 'added' | 'deleted' | 'modified' | 'renamed';
  binary?: boolean;
  /** Set when the diff was too large to show. */
  note?: string | null;
  hunks: DiffHunk[];
}

const CHANGE_WORDS = { added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed' } as const;

/** One file's diff. Greyscale: +/- prefixes, added lines bold, removed lines struck through. */
export function diffFile(file: DiffFile) {
  let added = 0, deleted = 0;
  for (const h of file.hunks) for (const l of h.lines) { if (l.kind === 'add') added++; else if (l.kind === 'del') deleted++; }
  const sign = { add: '+', del: '-', ctx: ' ' } as const;
  const name = file.oldPath && file.oldPath !== file.path ? `${file.oldPath} to ${file.path}` : file.path;
  return html`<div class="diff-file">
    <div class="diff-head">${file.change ? html`<span class="change">${CHANGE_WORDS[file.change]}</span>` : ''}<span class="path">${name}</span><span class="counts mono">+${added} -${deleted}</span></div>
    <div class="diff-body"><table class="diff-table"><tbody>
      ${file.binary ? html`<tr class="note"><td colspan="4">Binary file not shown.</td></tr>` : ''}
      ${file.note ? html`<tr class="note"><td colspan="4">${file.note}</td></tr>` : ''}
      ${file.hunks.map(h => html`<tr class="hunk"><td colspan="4">${h.header}</td></tr>${h.lines.map(l =>
        html`<tr class="${l.kind}"><td class="ln">${l.oldNo ?? ''}</td><td class="ln">${l.newNo ?? ''}</td><td class="sign">${sign[l.kind]}</td><td class="code">${l.text}</td></tr>`)}`)}
    </tbody></table></div>
  </div>`;
}

/** "3 files changed, 12 additions, 4 deletions" and every file. */
export function diffView(files: DiffFile[]) {
  let added = 0, deleted = 0;
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) { if (l.kind === 'add') added++; else if (l.kind === 'del') deleted++; }
  return html`<p class="diff-stat">${files.length} ${files.length === 1 ? 'file' : 'files'} changed, ${added} ${added === 1 ? 'addition' : 'additions'}, ${deleted} ${deleted === 1 ? 'deletion' : 'deletions'}.</p>${files.map(diffFile)}`;
}

export interface CommitSummary { sha: string; href: string; message: string; author: string; time: number }

/** A commit list (newest first), grouped by day in Sydney time. */
export function commitList(commits: CommitSummary[], dayOf: (ms: number) => string): Child {
  let lastDay = '';
  return html`<ul class="commit-list">${commits.map(c => {
    const day = dayOf(c.time);
    const heading = day !== lastDay ? html`<li class="commit-day">Commits on ${day}</li>` : '';
    lastDay = day;
    return html`${heading}<li class="commit-row"><span class="message"><a href="${c.href}">${firstLine(c.message)}</a></span><span class="meta">${c.author}, ${when(c.time)}</span><a class="sha" href="${c.href}">${c.sha.slice(0, 10)}</a></li>`;
  })}</ul>`;
}
