/**
 * Count lines the way `wc -l` does: newlines, not segments. Text with no
 * trailing newline therefore counts one fewer than it has visible rows.
 *
 * This lives alone because two independent copies of it drifted — one counted
 * `"a\nb"` as 2, the other as 1 — and a size a tool reports must not depend on
 * which module asked.
 * @param {string} text
 */
export function countLines(text) {
  return (text.match(/\n/g) ?? []).length;
}
