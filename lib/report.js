/** @typedef {import('./finding.js').Finding} Finding */

const ORDER = { fail: 0, unknown: 1, pass: 2 };
const ICON = { fail: "✗", unknown: "?", pass: "✓" };

/** @param {Finding[]} findings */
function summarize(findings) {
  return {
    fail: findings.filter((f) => f.status === "fail").length,
    unknown: findings.filter((f) => f.status === "unknown").length,
    pass: findings.filter((f) => f.status === "pass").length,
  };
}

/**
 * @param {Finding[]} findings
 * @returns {string}
 */
export function renderMarkdown(findings) {
  const sorted = [...findings].sort(
    (a, b) => ORDER[a.status] - ORDER[b.status] || a.id.localeCompare(b.id),
  );
  const s = summarize(findings);

  const out = [
    "# AI-coding readiness",
    "",
    `${s.fail} fail · ${s.unknown} unknown · ${s.pass} pass`,
    "",
    "> `unknown` means the check could not determine an answer — never that " +
      "the repository passed.",
    "",
  ];

  for (const f of sorted) {
    out.push(`## ${ICON[f.status]} \`${f.id}\` — ${f.status} (T${f.tier})`);
    out.push("");
    out.push(f.evidence);
    out.push("");
    if (f.status === "fail") {
      out.push(`**Why it matters.** ${f.why}`);
      out.push("");
      if (f.precondition) {
        out.push(`**Before applying the fix.** ${f.precondition}`);
        out.push("");
      }
      out.push(`**Fix.** ${f.fix}`);
      out.push("");
      if (!f.autoFixable) {
        out.push("_This finding has no automatic fix; it needs a person._");
        out.push("");
      }
    }
  }
  return out.join("\n");
}

/**
 * @param {Finding[]} findings
 * @returns {string}
 */
export function renderJson(findings) {
  return JSON.stringify({ summary: summarize(findings), findings }, null, 2);
}
