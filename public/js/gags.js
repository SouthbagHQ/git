// House-style extras shared by every Southbag product: themes, and how Kevin is spelt.

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
