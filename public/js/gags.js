// House-style extras shared by every Southbag product: the promotional strip, themes, and how
// Kevin is spelt.

import { h } from './dom.js';

const promotions = [
  ['Southbag Rewards', 'https://southbag.cc/financial'],
  ['Southbag Office', 'https://office.southbag.cc'],
  ['Southbag Drive', 'https://drive.southbag.cc'],
  ['Southbag Identity', 'https://identity.southbag.cc/home'],
  ['Southbag Social', 'https://social.southbag.cc'],
];

/** The promotional strip. Rotates through Southbag products; closeable for the session. */
export function promoStrip() {
  try { if (sessionStorage.getItem('sb_promo_closed') === '1') return null; } catch {}
  let i = Math.floor(Math.random() * promotions.length);
  const link = h('a', { target: '_blank', rel: 'noopener' });
  const paint = () => { [link.textContent, link.href] = promotions[i]; };
  paint();
  const strip = h('div.promo-strip', { role: 'complementary', 'aria-label': 'Promotion' },
    link,
    h('button.promo-close', { type: 'button', onclick: () => {
      try { sessionStorage.setItem('sb_promo_closed', '1'); } catch {}
      strip.remove();
    } }, 'Close'));
  const timer = setInterval(() => {
    if (!strip.isConnected) return clearInterval(timer);
    i = (i + 1) % promotions.length;
    paint();
  }, 9000);
  return strip;
}

/** Light or dark, remembered per browser. The head script applies it before the page paints. */
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sb_theme', next); } catch {}
}

// Kevin is always written "Kevin". Anything typed into any text field is corrected the moment the
// word is finished, whatever its capitals ("kevin", "KEVIN", "kEvIn" → "Kevin"), keeping the caret
// where it was. Password fields and unfinished IME input are left alone.
const anyKevin = /\bkevin/gi;
const fixKevin = text => text.replace(anyKevin, 'Kevin');
export function capitaliseKevin() {
  document.addEventListener('input', e => {
    const el = e.target;
    if (e.isComposing || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (el instanceof HTMLInputElement && ['password', 'hidden', 'number', 'range', 'color', 'checkbox', 'radio', 'file', 'date', 'datetime-local', 'time', 'month', 'week'].includes(el.type)) return;
    const fixed = fixKevin(el.value);
    if (fixed === el.value) return;
    let start = null, end = null;
    try { ({ selectionStart: start, selectionEnd: end } = el); } catch {}
    el.value = fixed;
    try { if (start != null) el.setSelectionRange(start, end); } catch {}
  }, true);
}
