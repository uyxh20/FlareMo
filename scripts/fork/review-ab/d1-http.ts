// A read-only D1 binding over Cloudflare's D1 HTTP API, for the weekly review
// A/B test (fork-owned, docs/fork-review-ab-test.md). It lets the app's own
// review code (plannerReadReviewContext) read the DEV database from a script.
//
// Read-only by construction: only SELECT / WITH / PRAGMA statements are sent,
// and only to a database named in DEV_DATABASES. Production is refused.

const DEV_DATABASES = new Set(["flaremo-dev"]);
const READ_ONLY = /^\s*(select|with|pragma)\b/i;

type Credentials = { accountId: string; apiToken: string };

async function call(
  creds: Credentials,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/d1/database${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${creds.apiToken}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  const json = (await response.json()) as {
    success: boolean;
    errors?: Array<{ message: string }>;
    result: unknown;
  };
  if (!json.success) {
    throw new Error(
      `D1 API: ${json.errors?.map((error) => error.message).join("; ") ?? response.status}`,
    );
  }
  return json.result;
}

/** The id of a dev database by name; refuses anything not on the dev list. */
export async function devDatabaseId(
  creds: Credentials,
  name: string,
): Promise<string> {
  if (!DEV_DATABASES.has(name)) {
    throw new Error(`Refusing database "${name}": the A/B test reads dev only.`);
  }
  const list = (await call(
    creds,
    `?name=${encodeURIComponent(name)}`,
  )) as Array<{ name: string; uuid: string }>;
  const match = list.find((db) => db.name === name);
  if (!match) throw new Error(`No D1 database named ${name}.`);
  return match.uuid;
}

class Statement {
  constructor(
    private readonly run_: (sql: string, params: unknown[], raw: boolean) => Promise<unknown>,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {
    if (!READ_ONLY.test(sql)) {
      throw new Error("The A/B test's D1 adapter only reads.");
    }
  }
  bind(...params: unknown[]) {
    return new Statement(this.run_, this.sql, params);
  }
  async all() {
    const results = (await this.run_(this.sql, this.params, false)) as object[];
    return { results, success: true, meta: {} };
  }
  async raw(options?: { columnNames?: boolean }) {
    const { columns, rows } = (await this.run_(this.sql, this.params, true)) as {
      columns: string[];
      rows: unknown[][];
    };
    return options?.columnNames ? [columns, ...rows] : rows;
  }
  async first(column?: string) {
    const { results } = await this.all();
    const row = (results[0] ?? null) as Record<string, unknown> | null;
    return column && row ? row[column] : row;
  }
  async run(): Promise<never> {
    throw new Error("The A/B test's D1 adapter only reads.");
  }
}

/** A D1Database-shaped object that reads one dev database over HTTP. */
export function readOnlyD1(creds: Credentials, databaseId: string) {
  const exec = async (sql: string, params: unknown[], raw: boolean) => {
    const result = (await call(creds, `/${databaseId}/${raw ? "raw" : "query"}`, {
      sql,
      params,
    })) as Array<{ results: unknown }>;
    return result[0]?.results;
  };
  return {
    prepare: (sql: string) => new Statement(exec, sql),
    batch: (statements: Statement[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    exec: () => Promise.reject(new Error("The A/B test's D1 adapter only reads.")),
    dump: () => Promise.reject(new Error("Not supported.")),
  } as unknown as D1Database;
}
