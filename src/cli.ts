/**
 * 1Password SaaS Manager's AWS Marketplace Skill — command-line front door to the tools in src/tools.ts.
 * This is what the portable SKILL.md drives, so any agent that can run shell
 * commands (Claude Code, Codex) gets the same guided flow without an MCP server.
 *
 *   npm run -s tool -- list                          # tool names + one-line purpose
 *   npm run -s tool -- help <tool>                   # full description + argument schema
 *   npm run -s tool -- <tool> @.cache/tool-args.json  # arguments from a JSON file (the skill's way)
 *   npm run -s tool -- <tool> '{"provider":"1password"}'  # inline JSON (only for fixed values)
 *
 * Agents should write arguments to .cache/tool-args.json with their file-writing tool and pass
 * @.cache/tool-args.json. Arguments can hold application or product names from SaaS Manager or
 * AWS Marketplace; put on a command line, a name containing a quote could break out of the
 * quoting and run as a shell command. A file is never parsed by the shell.
 *
 * Output: the tool's result as JSON on stdout, exit 0. On failure: {"error": "..."}
 * on stdout, exit 1. Progress for long tools goes to stderr.
 */

import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve, isAbsolute } from "node:path";
import { TOOLS, validateArgs } from "./tools.js";
import { DATA_NOTICE, forAgent, safeErrorMessage } from "./untrusted.js";

const out = (v: unknown) => process.stdout.write(JSON.stringify(forAgent(v), null, 2) + "\n");
const fail = (message: string): never => {
  out({ error: message });
  process.exit(1);
};

/** An @file argument must be a .json file inside this project folder (not .env or a credentials file). */
function argsFile(ref: string): string {
  let p: string;
  try {
    p = realpathSync(resolve(ref));
  } catch {
    return fail(`Arguments file "${ref}" doesn't exist. Write the JSON arguments to .cache/tool-args.json and pass @.cache/tool-args.json.`);
  }
  const rel = relative(realpathSync(process.cwd()), p);
  if (!p.toLowerCase().endsWith(".json") || rel.startsWith("..") || isAbsolute(rel) || /(^|[\\/])(config|out)[\\/]/.test(rel) || /credentials/i.test(rel)) {
    return fail("The arguments file must be a .json file in this project folder, such as .cache/tool-args.json.");
  }
  return p;
}

function readArgs(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw === "") return {};
  let text = raw;
  if (raw === "-") text = readFileSync(0, "utf8");
  else if (raw.startsWith("@")) text = readFileSync(argsFile(raw.slice(1)), "utf8");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    // Never echo the parser's message: it can quote the text that was read.
    return fail("Arguments are not valid JSON.");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return fail("Arguments must be a JSON object, e.g. {\"provider\":\"1password\"}.");
  return v as Record<string, unknown>;
}

/** The subset of each tool's JSON schema the agent needs: required/optional arg names + types. */
function argSummary(schema: any): Record<string, string> {
  const req = new Set<string>(schema?.required ?? []);
  const props = schema?.properties ?? {};
  return Object.fromEntries(Object.entries(props).map(([k, v]: [string, any]) =>
    [k, `${v.type ?? "any"}${req.has(k) ? " (required)" : ""}${v.enum ? ` one of ${v.enum.join("|")}` : ""}${v.description ? ` — ${v.description}` : ""}`]));
}

async function main() {
  const [name, rawArgs] = process.argv.slice(2);
  if (!name || name === "list") {
    // "STEP 4a. Get the apps…" → step "4a", purpose = the first real sentence.
    return out(TOOLS.map((t) => {
      const m = t.description.match(/^STEP\s+(\S+?)\.?\s+(?:\([^)]*\)\.?\s*)?(.*)$/s);
      const rest = m ? m[2] : t.description;
      return { tool: t.name, step: m ? m[1] : undefined, purpose: rest.split(/(?<=\.)\s/)[0] };
    }));
  }
  if (name === "help") {
    const t = TOOLS.find((x) => x.name === rawArgs);
    if (!t) return fail(`Unknown tool "${rawArgs}". Run: npm run -s tool -- list`);
    return out({ tool: t.name, description: t.description, args: argSummary(t.inputSchema) });
  }
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return fail(`Unknown tool "${name}". Run: npm run -s tool -- list`);
  const args = readArgs(rawArgs);
  // Same contract as the MCP server: known arguments only, required ones present, every value of its declared type.
  const problems = validateArgs(tool, args);
  if (problems.length) fail(`Invalid arguments for ${name}: ${problems.join("; ")}. Run: npm run -s tool -- help ${name}`);
  try {
    const result = await tool.handler(args);
    process.stderr.write(`Note: ${DATA_NOTICE}\n`);
    out(result);
  } catch (e) {
    fail(safeErrorMessage(e));
  }
}

main();
