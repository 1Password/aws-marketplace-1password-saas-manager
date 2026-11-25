/**
 * Render check for the dashboard (report.ts runs it on every page it builds; check-mcp tests it).
 */

/**
 * Problems a reader would see on the finished page: values that rendered as "undefined", "NaN" or
 * "[object Object]" (a field missing or of the wrong type), non-numeric ACVs the page's totals add
 * up, or a tab with no panel. Scripts and styles are left out of the scan.
 */
export function renderProblems(html: string, tabIds: string[]): string[] {
  const problems: string[] = [];
  const visible = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
  const bad = /\b(undefined|NaN)\b|\[object Object\]/g;
  const seen = new Set<string>();
  for (const m of visible.matchAll(bad)) {
    const around = visible.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 40).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    const key = `"${m[0]}" near "${around.slice(0, 80)}"`;
    if (!seen.has(key)) { seen.add(key); problems.push(`shows ${key}`); }
    if (seen.size >= 5) break;
  }
  const badAcv = [...visible.matchAll(/data-acv="([^"]*)"/g)].filter((m) => !/^-?\d+$/.test(m[1])).length;
  if (badAcv) problems.push(`${badAcv} row(s) have no numeric ACV, so the page's totals would be wrong`);
  for (const id of tabIds) if (!visible.includes(`id="panel-${id}"`)) problems.push(`the ${id} tab has no content`);
  return problems;
}
