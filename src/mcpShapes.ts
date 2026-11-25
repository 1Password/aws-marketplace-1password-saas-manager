/**
 * Shape checks for AWS Marketplace MCP responses.
 *
 * The MCP is a public service the bundle doesn't control: a field could be renamed, change type or
 * disappear without notice. Every response from the three tools the bundle uses is checked here
 * (mcpClient.ts calls normalizeToolResult on each one):
 *
 *   • Items missing what the bundle needs (a valid listing id) are dropped, not passed on half-built.
 *   • Optional fields of the wrong type are removed, so the dashboard shows "–" instead of
 *     "undefined", "NaN" or "[object Object]".
 *   • Every problem is counted per tool and field, and written to out/<provider>/mcp-health.json at
 *     the end of each pipeline step. The report reads it: the dashboard shows a notice, and
 *     get_consolidation_report tells the agent, so a format change is visible instead of silent.
 *
 * `npm run check-mcp` runs the same checks against the live MCP with fixed inputs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MCP_TOOLS = ["search_aws_marketplace_solutions", "get_aws_marketplace_solution", "get_aws_marketplace_related_solutions"] as const;
type McpTool = (typeof MCP_TOOLS)[number];

const LISTING_ID = /^prodview-[a-z0-9]{6,40}$/;

// ── Collector ────────────────────────────────────────────────────────────────
/** Problems seen in this process: "tool · problem" → count. */
const issues = new Map<string, number>();
let itemsChecked = 0;
let itemsDropped = 0;

function note(tool: string, problem: string) {
  const k = `${tool} · ${problem}`;
  issues.set(k, (issues.get(k) ?? 0) + 1);
}

/** Forget what this process has seen (check-mcp uses it between its offline and live checks). */
export function resetShapeSummary() {
  issues.clear();
  itemsChecked = 0;
  itemsDropped = 0;
}

/** What this process has seen so far. */
export function shapeSummary() {
  return {
    itemsChecked,
    itemsDropped,
    issues: [...issues.entries()].map(([problem, count]) => ({ problem, count })).sort((a, b) => b.count - a.count),
  };
}

// ── Field checks ─────────────────────────────────────────────────────────────
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Keep `key` only if it passes `ok`; otherwise delete it and note the problem. Absent is fine. */
function keepIf(tool: string, o: Obj, key: string, ok: (v: unknown) => boolean, want: string) {
  if (o[key] === undefined || o[key] === null) return;
  if (!ok(o[key])) {
    note(tool, `${key} is not ${want}`);
    delete o[key];
  }
}
const str = (v: unknown) => typeof v === "string";
const bool = (v: unknown) => typeof v === "boolean";
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const strArr = (v: unknown) => Array.isArray(v) && v.every(str);
const https = (v: unknown) => typeof v === "string" && v.startsWith("https://");

/** Keep only the array items that pass `ok`; note how many were dropped. */
function filterArr(tool: string, o: Obj, key: string, ok: (v: unknown) => boolean, want: string) {
  if (o[key] === undefined || o[key] === null) return;
  if (!Array.isArray(o[key])) {
    note(tool, `${key} is not a list`);
    delete o[key];
    return;
  }
  const arr = o[key] as unknown[];
  const kept = arr.filter(ok);
  if (kept.length !== arr.length) note(tool, `${key} has ${arr.length - kept.length} item(s) that aren't ${want}`);
  o[key] = kept;
}

/** A listing as returned by search or get: valid id required, everything else type-checked. */
function checkSolution(tool: string, raw: unknown, detailed: boolean): Obj | null {
  itemsChecked++;
  if (!isObj(raw)) { note(tool, "an item is not an object"); itemsDropped++; return null; }
  const s: Obj = { ...raw };
  if (!str(s.solution_id) || !LISTING_ID.test(s.solution_id as string)) {
    note(tool, "an item has no valid solution_id");
    itemsDropped++;
    return null;
  }
  keepIf(tool, s, "solution_name", str, "text");
  if (s.solution_name === undefined) note(tool, "solution_name is missing");
  keepIf(tool, s, "vendor_name", str, "text");
  keepIf(tool, s, "deployed_on_aws", bool, "true/false");
  keepIf(tool, s, "solution_url", https, "an https link");
  if (!detailed) return s;

  if (s.call_to_action !== undefined && s.call_to_action !== null) {
    if (!isObj(s.call_to_action)) { note(tool, "call_to_action is not an object"); delete s.call_to_action; }
    else {
      const cta: Obj = { ...s.call_to_action };
      for (const k of Object.keys(cta)) keepIf(tool, cta, k, https, "an https link");
      s.call_to_action = cta;
    }
  }
  filterArr(tool, s, "rankings", (r) => isObj(r) && str(r.category) && num(r.rank), "{category, rank}");
  if (s.reviews_summary !== undefined && s.reviews_summary !== null) {
    if (!isObj(s.reviews_summary)) { note(tool, "reviews_summary is not an object"); delete s.reviews_summary; }
    else {
      const rv: Obj = { ...s.reviews_summary };
      keepIf(tool, rv, "average_rating", num, "a number");
      keepIf(tool, rv, "reviews_count", num, "a number");
      s.reviews_summary = rv;
    }
  }
  filterArr(tool, s, "review_sentiments", (r) => isObj(r) && str(r.sentiment_category) && str(r.overall_polarity), "{sentiment_category, overall_polarity}");
  filterArr(tool, s, "highlights", str, "text");
  filterArr(tool, s, "pricing_options", (p) => isObj(p) && (p.name === undefined || str(p.name)) && (p.description === undefined || str(p.description)), "{name, description}");
  keepIf(tool, s, "has_standard_contract", bool, "true/false");
  keepIf(tool, s, "free_trial_available", bool, "true/false");
  keepIf(tool, s, "fulfillment_options_types", strArr, "a list of text");
  keepIf(tool, s, "categories", strArr, "a list of text");
  return s;
}

/**
 * Check one tool result and return a cleaned copy with the shape callers rely on. A result with
 * the wrong top-level shape becomes an empty result (and is noted), never an exception.
 */
export function normalizeToolResult(tool: string, result: unknown): unknown {
  if (!(MCP_TOOLS as readonly string[]).includes(tool)) return result;
  const t = tool as McpTool;
  const r: Obj = isObj(result) ? { ...result } : {};
  if (!isObj(result)) note(t, "the response is not an object");

  if (t === "search_aws_marketplace_solutions") {
    if (!Array.isArray(r.results)) { note(t, "results is missing or not a list"); r.results = []; }
    r.results = (r.results as unknown[]).map((x) => checkSolution(t, x, false)).filter(Boolean);
    if (r.next_cursor !== undefined && r.next_cursor !== null && !str(r.next_cursor)) { note(t, "next_cursor is not text"); delete r.next_cursor; }
  } else if (t === "get_aws_marketplace_solution") {
    if (!Array.isArray(r.solutions)) { note(t, "solutions is missing or not a list"); r.solutions = []; }
    r.solutions = (r.solutions as unknown[]).map((x) => checkSolution(t, x, true)).filter(Boolean);
  } else {
    if (!Array.isArray(r.results)) { note(t, "results is missing or not a list"); r.results = []; }
    r.results = (r.results as unknown[]).map((x) => {
      if (!isObj(x)) { note(t, "an item is not an object"); return { related_solutions: [] }; }
      const o: Obj = { ...x };
      filterArr(t, o, "related_solutions", (y) => isObj(y) && str(y.solution_id) && LISTING_ID.test(y.solution_id as string), "{solution_id}");
      if (o.related_solutions === undefined) o.related_solutions = [];
      return o;
    });
  }
  return r;
}

// ── Health file ──────────────────────────────────────────────────────────────
export interface McpHealth {
  /** Per pipeline step: what its MCP responses looked like. */
  steps: Record<string, { at: string; itemsChecked: number; itemsDropped: number; issues: { problem: string; count: number }[] }>;
}

export function readMcpHealth(path: string): McpHealth {
  try {
    const h = JSON.parse(readFileSync(path, "utf8"));
    return isObj(h) && isObj(h.steps) ? (h as unknown as McpHealth) : { steps: {} };
  } catch {
    return { steps: {} };
  }
}

/** Record this process's results under `step` (replacing that step's earlier entry). */
export function writeMcpHealth(path: string, step: string) {
  const sum = shapeSummary();
  if (!existsSync(path) && sum.itemsChecked === 0 && sum.issues.length === 0) return;
  const h = readMcpHealth(path);
  h.steps[step] = { at: new Date().toISOString(), ...sum };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(h, null, 2), { mode: 0o600 });
}

/** Start a fresh health file for a new run. */
export function resetMcpHealth(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ steps: {} }, null, 2), { mode: 0o600 });
}

/** Totals across steps, for the report and the agent. */
export function healthTotals(h: McpHealth) {
  const issues = new Map<string, number>();
  let dropped = 0, checked = 0;
  for (const s of Object.values(h.steps)) {
    checked += s.itemsChecked; dropped += s.itemsDropped;
    for (const i of s.issues) issues.set(i.problem, (issues.get(i.problem) ?? 0) + i.count);
  }
  return { checked, dropped, issues: [...issues.entries()].map(([problem, count]) => ({ problem, count })) };
}
