// Fork-only safety layer for scripts/fork/dev-env.mjs.
//
// Every wrangler call the dev tooling makes goes through
// assertSafeWranglerCall() before it is spawned. The check is pure (argv and a
// parsed config in, verdict or ProdGuardError out) so it can be tested without
// touching Cloudflare. Policy:
//
//   - Read-only commands (list, SELECT, export, object get, secret list,
//     deploy --dry-run) are allowed against anything, including production.
//   - Every other command is write-capable. It must pass --config (wrangler's
//     implicit config lookup finds the tracked root wrangler.json, which names
//     the production Worker), the config must be a dev-only config, and every
//     explicit target must be a flaremo-dev* resource. Production names and ids
//     are refused outright; anything that is merely not dev is refused too.
//   - Anything this module does not recognise (commands, flags, config keys)
//     is refused. The tooling only ever needs a small, known set of wrangler
//     calls, so failing closed costs nothing.

export const PROD = Object.freeze({
  workerName: "flaremo",
  d1Name: "flaremo",
  d1Id: "d4ad3911-7515-4b6d-ac52-b06537ed9c37",
  bucket: "flaremo-attachments",
  queues: Object.freeze(["flaremo-member-removal", "flaremo-data-export"]),
  vectorizeIndexes: Object.freeze(["flaremo-memos", "flaremo-memories"]),
  publicUrl: "https://flaremo.ulysse-ha-19.workers.dev",
  // The namespace id shipped in wrangler.jsonc.example.
  ratelimitNamespaceId: "1001",
});

export const DEV_NAME_PREFIX = "flaremo-dev";

// Vars that make the Worker send mail or push. A dev deployment must never
// carry them (the matching secrets are never set either).
export const OUTBOUND_VARS = Object.freeze([
  "FLAREMO_EMAIL_PROVIDER",
  "FLAREMO_EMAIL_FROM",
  "FLAREMO_VAPID_PUBLIC_KEY",
  "FLAREMO_VAPID_PRIVATE_KEY",
]);

// Top-level wrangler config keys that have been reviewed for dev safety. A key
// outside this list (kv_namespaces, services, routes, env, ...) could bind or
// route to production, so configs carrying one are refused until someone
// reviews it and extends the list.
export const ALLOWED_CONFIG_KEYS = Object.freeze([
  "$schema",
  "name",
  "main",
  "compatibility_date",
  "compatibility_flags",
  "observability",
  "assets",
  "d1_databases",
  "r2_buckets",
  "queues",
  "vectorize",
  "ai",
  "ratelimits",
  "triggers",
  "vars",
]);

export class ProdGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProdGuardError";
  }
}

const normalize = (value) =>
  String(value ?? "")
    .trim()
    .toLowerCase();

export function isDevName(value) {
  const name = normalize(value);
  return name === DEV_NAME_PREFIX || name.startsWith(`${DEV_NAME_PREFIX}-`);
}

export function prodIdentifiers(prod = PROD) {
  return new Set(
    [
      prod.workerName,
      prod.d1Name,
      prod.d1Id,
      prod.bucket,
      ...prod.queues,
      ...prod.vectorizeIndexes,
    ].map(normalize),
  );
}

export function isProdIdentifier(value, prod = PROD) {
  return prodIdentifiers(prod).has(normalize(value));
}

// ---------------------------------------------------------------------------
// SQL classification

// Split SQL into statements. Comments are dropped. `text` keeps string
// literals and quoted identifiers verbatim; `code` blanks their contents so
// keyword checks cannot be fooled by (or trip over) quoted text.
export function scanSqlStatements(sql) {
  const source = String(sql ?? "");
  const statements = [];
  let text = "";
  let code = "";
  let index = 0;
  const flush = () => {
    if (code.trim()) {
      statements.push({ text: text.trim(), code: code.trim() });
    }
    text = "";
    code = "";
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "-" && next === "-") {
      while (index < source.length && source[index] !== "\n") index += 1;
      text += " ";
      code += " ";
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end === -1 ? source.length : end + 2;
      text += " ";
      code += " ";
    } else if (char === "'" || char === '"' || char === "`") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === char) {
          if (source[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          break;
        }
        cursor += 1;
      }
      const last = Math.min(cursor, source.length - 1);
      text += source.slice(index, last + 1);
      code += `${char}${char}`;
      index = last + 1;
    } else if (char === "[") {
      const end = source.indexOf("]", index + 1);
      const last = end === -1 ? source.length - 1 : end;
      text += source.slice(index, last + 1);
      code += "[]";
      index = last + 1;
    } else if (char === ";") {
      flush();
      index += 1;
    } else {
      text += char;
      code += char;
      index += 1;
    }
  }
  flush();
  return statements;
}

export function splitSqlStatements(sql) {
  return scanSqlStatements(sql).map((statement) => statement.text);
}

const SQL_TOKEN_RE = /[A-Za-z_][A-Za-z0-9_$]*|[=();,.*]/g;
const SQL_WRITE_WORDS = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "ATTACH",
  "DETACH",
  "VACUUM",
  "REINDEX",
  "PRAGMA",
  "ANALYZE",
]);
const SQL_READ_PRAGMAS = new Set([
  "TABLE_INFO",
  "TABLE_XINFO",
  "TABLE_LIST",
  "INDEX_LIST",
  "INDEX_INFO",
  "INDEX_XINFO",
  "FOREIGN_KEY_LIST",
]);

function isReadOnlyStatement({ code }) {
  const tokens = (code.match(SQL_TOKEN_RE) ?? []).map((token) =>
    token.toUpperCase(),
  );
  const [first] = tokens;
  // A SELECT cannot write in SQLite; anything chained after it was already
  // split into its own statement.
  if (first === "SELECT") return true;
  if (first === "WITH") {
    // A CTE can front an INSERT/UPDATE/DELETE, so scan the whole statement.
    if (!tokens.includes("SELECT")) return false;
    if (tokens.some((token) => SQL_WRITE_WORDS.has(token))) return false;
    // REPLACE is also a string function; only REPLACE INTO writes.
    return !tokens.some(
      (token, at) => token === "REPLACE" && tokens[at + 1] === "INTO",
    );
  }
  if (first === "PRAGMA") {
    return SQL_READ_PRAGMAS.has(tokens[1]) && !tokens.includes("=");
  }
  return false;
}

// True only when every statement is a plain read. Empty input is not "read".
export function isReadOnlySql(sql) {
  const statements = scanSqlStatements(sql);
  return statements.length > 0 && statements.every(isReadOnlyStatement);
}

// ---------------------------------------------------------------------------
// argv parsing

const VALUE_FLAGS = new Set([
  "--config",
  "--command",
  "--file",
  "--name",
  "--output",
  "--table",
  "--persist-to",
  "--content-type",
  "--dimensions",
  "--metric",
  "--format",
]);
const BOOLEAN_FLAGS = new Set([
  "--remote",
  "--local",
  "--json",
  "--yes",
  "--skip-confirmation",
  "--dry-run",
  "--no-schema",
  "--no-data",
]);
const FLAG_ALIASES = Object.freeze({
  "-c": "--config",
  "-f": "--file",
  "-y": "--yes",
});

// kind: how the guard treats each positional argument after the command words.
const COMMANDS = new Map([
  ["d1 list", { write: false, positionals: [] }],
  ["d1 info", { write: false, positionals: ["d1"] }],
  ["d1 export", { write: false, positionals: ["d1"] }],
  ["d1 execute", { write: "sql", positionals: ["d1"] }],
  ["d1 create", { write: true, positionals: ["d1"] }],
  ["d1 delete", { write: true, positionals: ["d1"] }],
  ["d1 migrations apply", { write: true, positionals: ["d1"] }],
  // `migrations list` runs CREATE TABLE IF NOT EXISTS on the migrations
  // table, so it is not a pure read.
  ["d1 migrations list", { write: true, positionals: ["d1"] }],
  ["r2 bucket list", { write: false, positionals: [] }],
  ["r2 bucket create", { write: true, positionals: ["bucket"] }],
  ["r2 bucket delete", { write: true, positionals: ["bucket"] }],
  ["r2 object get", { write: false, positionals: ["object"] }],
  ["r2 object put", { write: true, positionals: ["object"] }],
  ["r2 object delete", { write: true, positionals: ["object"] }],
  ["queues list", { write: false, positionals: [] }],
  ["queues create", { write: true, positionals: ["queue"] }],
  ["queues delete", { write: true, positionals: ["queue"] }],
  ["vectorize list", { write: false, positionals: [] }],
  ["vectorize get", { write: false, positionals: ["index"] }],
  ["vectorize create", { write: true, positionals: ["index"] }],
  ["vectorize delete", { write: true, positionals: ["index"] }],
  ["secret list", { write: false, positionals: [], worker: true }],
  ["secret put", { write: true, positionals: ["secret"], worker: true }],
  ["secret delete", { write: true, positionals: ["secret"], worker: true }],
  ["deploy", { write: "unless-dry-run", positionals: [], worker: true }],
]);

export function parseWranglerArgv(argv) {
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) {
    throw new ProdGuardError("wrangler argv must be an array of strings");
  }
  const flags = new Map();
  const positionals = [];
  const push = (name, value) => {
    flags.set(name, [...(flags.get(name) ?? []), value]);
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      throw new ProdGuardError("refusing wrangler argv containing a bare --");
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const rawName = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const name = FLAG_ALIASES[rawName] ?? rawName;
    if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === undefined) {
        index += 1;
        if (index >= argv.length) {
          throw new ProdGuardError(`wrangler flag ${rawName} needs a value`);
        }
        value = argv[index];
      }
      push(name, value);
    } else if (BOOLEAN_FLAGS.has(name)) {
      push(name, inline === undefined ? "true" : inline);
    } else {
      throw new ProdGuardError(
        `unsupported wrangler flag ${rawName}; the dev tooling refuses flags it cannot verify`,
      );
    }
  }

  let command = null;
  for (const candidate of COMMANDS.keys()) {
    const words = candidate.split(" ");
    const matches = words.every((word, at) => positionals[at] === word);
    if (matches && (!command || words.length > command.split(" ").length)) {
      command = candidate;
    }
  }
  const commandWords = command ? command.split(" ").length : 0;
  return {
    command,
    positionals: positionals.slice(commandWords),
    allPositionals: positionals,
    flags,
  };
}

export function isFlagOn(flags, name) {
  const values = flags.get(name);
  if (!values || values.length === 0) return false;
  return !["false", "0", "no"].includes(normalize(values.at(-1)));
}

// ---------------------------------------------------------------------------
// config and target checks

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function walkStrings(value, visit) {
  if (typeof value === "string") {
    visit(value);
  } else if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visit);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) walkStrings(item, visit);
  }
}

function resourceProblem(label, name, prod) {
  if (!String(name ?? "").trim()) return `${label} is missing`;
  if (isProdIdentifier(name, prod)) {
    return `${label} "${name}" is a production resource`;
  }
  if (!isDevName(name)) {
    return `${label} "${name}" is not a ${DEV_NAME_PREFIX}* resource`;
  }
  return null;
}

function originOf(value) {
  const text = normalize(value).replace(/\/+$/, "");
  try {
    return new URL(text).origin;
  } catch {
    return text;
  }
}

// Throws unless `config` (a parsed wrangler config) only names dev resources.
export function assertConfigDevOnly(config, options = {}) {
  const prod = options.prod ?? PROD;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ProdGuardError(
      "write-capable wrangler commands need a parsed --config; none was provided",
    );
  }
  const problems = [];
  const report = (problem) => {
    if (problem && !problems.includes(problem)) problems.push(problem);
  };

  const allowedKeys = new Set(ALLOWED_CONFIG_KEYS);
  for (const key of Object.keys(config)) {
    if (!allowedKeys.has(key)) {
      report(
        `config key "${key}" has not been reviewed for dev safety (it could bind or route to production)`,
      );
    }
  }

  report(resourceProblem("Worker name", config.name, prod));
  for (const database of asArray(config.d1_databases)) {
    report(resourceProblem("D1 database_name", database?.database_name, prod));
    if (normalize(database?.database_id) === normalize(prod.d1Id)) {
      report(`D1 database_id ${database.database_id} is the production id`);
    }
  }
  for (const bucket of asArray(config.r2_buckets)) {
    report(resourceProblem("R2 bucket_name", bucket?.bucket_name, prod));
  }
  for (const producer of asArray(config.queues?.producers)) {
    report(resourceProblem("Queue producer", producer?.queue, prod));
  }
  for (const consumer of asArray(config.queues?.consumers)) {
    report(resourceProblem("Queue consumer", consumer?.queue, prod));
  }
  for (const index of asArray(config.vectorize)) {
    report(resourceProblem("Vectorize index_name", index?.index_name, prod));
  }
  for (const limiter of asArray(config.ratelimits)) {
    if (String(limiter?.namespace_id ?? "") === prod.ratelimitNamespaceId) {
      report(
        `rate-limit namespace_id ${prod.ratelimitNamespaceId} is shared with production`,
      );
    }
  }

  const vars = config.vars ?? {};
  const prodOrigin = originOf(prod.publicUrl);
  const origins = [
    vars.FLAREMO_PUBLIC_URL,
    ...String(vars.FLAREMO_TRUSTED_ORIGINS ?? "").split(","),
  ];
  if (origins.some((origin) => originOf(origin) === prodOrigin)) {
    report(`vars point at the production origin ${prodOrigin}`);
  }
  for (const key of OUTBOUND_VARS) {
    if (String(vars[key] ?? "").trim() !== "") {
      report(`vars.${key} must be empty in dev (no real email or push)`);
    }
  }

  // Catch-all: a production name or id hiding anywhere in the config.
  const identifiers = prodIdentifiers(prod);
  const prodHost = normalize(new URL(prod.publicUrl).host);
  const serialized = JSON.stringify(config).toLowerCase();
  if (serialized.includes(normalize(prod.d1Id))) {
    report("config contains the production D1 id");
  }
  if (serialized.includes(prodHost)) {
    report(`config contains the production host ${prodHost}`);
  }
  walkStrings(config, (value) => {
    if (identifiers.has(normalize(value))) {
      report(`config contains the production resource name "${value}"`);
    }
  });

  if (problems.length > 0) {
    throw new ProdGuardError(
      `Refusing to use this wrangler config for a write-capable command:\n- ${problems.join("\n- ")}`,
    );
  }
}

function findD1Entry(config, value) {
  const wanted = normalize(value);
  return asArray(config?.d1_databases).find(
    (entry) =>
      normalize(entry?.binding) === wanted ||
      normalize(entry?.database_name) === wanted ||
      normalize(entry?.database_id) === wanted,
  );
}

function targetProblems(kind, value, config, prod) {
  const text = String(value ?? "");
  switch (kind) {
    case "d1": {
      const entry = findD1Entry(config, text);
      if (entry) {
        // The config check already vetted the entry; re-check what the
        // positional resolves to in case the entry changes shape.
        return [
          resourceProblem("D1 database", entry.database_name, prod),
          normalize(entry.database_id) === normalize(prod.d1Id)
            ? `D1 database id ${entry.database_id} is the production id`
            : null,
        ];
      }
      return [resourceProblem("D1 database", text, prod)];
    }
    case "bucket":
      return [resourceProblem("R2 bucket", text, prod)];
    case "object":
      return [resourceProblem("R2 bucket", text.split("/")[0], prod)];
    case "queue":
      return [resourceProblem("Queue", text, prod)];
    case "index":
      return [resourceProblem("Vectorize index", text, prod)];
    case "secret":
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text)
        ? []
        : [`secret name "${text}" is not a plain variable name`];
    default:
      return [`unknown target kind ${kind}`];
  }
}

function unsupported(parsed, argv, prod) {
  const named = [...parsed.allPositionals, ...[...parsed.flags.values()].flat()]
    .filter((token) => isProdIdentifier(token.split("/")[0], prod))
    .at(0);
  const subject = parsed.allPositionals.slice(0, 3).join(" ") || argv.join(" ");
  return new ProdGuardError(
    `unsupported wrangler command "${subject}"${
      named ? ` (and it names the production resource "${named}")` : ""
    }; the dev tooling only runs a fixed set of commands`,
  );
}

function isWriteCapable(spec, parsed) {
  if (spec.write === true) return true;
  if (spec.write === "unless-dry-run") {
    return !isFlagOn(parsed.flags, "--dry-run");
  }
  if (spec.write === "sql") {
    if (parsed.flags.has("--file")) return true;
    const commands = parsed.flags.get("--command") ?? [];
    return commands.length === 0 || !commands.every(isReadOnlySql);
  }
  return false;
}

/**
 * Inspect a wrangler invocation before it runs.
 *
 * @param {string[]} argv arguments after the `wrangler` binary
 * @param {object | null | undefined} config the parsed wrangler config that
 *   `--config` in argv resolves to
 * @param {{ prod?: typeof PROD }} [options]
 * @returns {{ command: string, writeCapable: boolean }}
 * @throws {ProdGuardError} when the call is unsupported, or write-capable
 *   without a dev-only config and dev-only targets
 */
export function assertSafeWranglerCall(argv, config, options = {}) {
  const prod = options.prod ?? PROD;
  const parsed = parseWranglerArgv(argv);
  const spec = parsed.command ? COMMANDS.get(parsed.command) : null;
  if (!spec) throw unsupported(parsed, argv, prod);

  if (parsed.positionals.length > spec.positionals.length) {
    throw new ProdGuardError(
      `unexpected extra argument "${parsed.positionals[spec.positionals.length]}" for wrangler ${parsed.command}`,
    );
  }
  const writeCapable = isWriteCapable(spec, parsed);
  const verdict = { command: parsed.command, writeCapable };
  if (!writeCapable) return verdict;

  const configFlags = parsed.flags.get("--config") ?? [];
  if (configFlags.length === 0) {
    throw new ProdGuardError(
      `wrangler ${parsed.command} is write-capable and must pass --config <dev config>: without it wrangler resolves the tracked root wrangler.json, which names the production Worker`,
    );
  }
  if (configFlags.length > 1) {
    // Only one parsed config is vetted, so a second path could name anything.
    throw new ProdGuardError(
      `wrangler ${parsed.command} must pass --config exactly once`,
    );
  }
  assertConfigDevOnly(config, { prod });

  const problems = [];
  spec.positionals.forEach((kind, at) => {
    const value = parsed.positionals[at];
    if (value === undefined) {
      problems.push(`wrangler ${parsed.command} is missing its ${kind} target`);
    } else {
      problems.push(...targetProblems(kind, value, config, prod));
    }
  });
  if (spec.worker) {
    const named = parsed.flags.get("--name") ?? [];
    for (const name of named) {
      problems.push(resourceProblem("Worker --name", name, prod));
      if (config.name && normalize(name) !== normalize(config.name)) {
        problems.push(
          `Worker --name "${name}" differs from the config's Worker "${config.name}"`,
        );
      }
    }
  }
  const unique = [...new Set(problems.filter(Boolean))];
  if (unique.length > 0) {
    throw new ProdGuardError(
      `Refusing wrangler ${parsed.command}:\n- ${unique.join("\n- ")}`,
    );
  }
  return verdict;
}
