// House-style extras shared by every Southbag product: themes, and how Kevin is spelt.

/** Light or dark, for this page only. Every page load starts in the default theme. */
export function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
}
