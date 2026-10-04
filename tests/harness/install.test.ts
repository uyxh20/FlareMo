import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS modules without types
import {
  initCmd,
  setTomlMemoriesDisabled,
  tomlMemoriesState,
} from "../../harness/core/install.mjs";
// @ts-expect-error plain-JS modules without types
import { checkoutRoot } from "../../harness/core/paths.mjs";
import { fakeMcpServer, makeEnv, tmpHome } from "./helpers";

describe("setTomlMemoriesDisabled", () => {
  it("creates the [memories] table when absent and preserves everything else", () => {
    const before = 'model = "gpt-6"\n\n[agents]\nenabled = true\n';
    const after = setTomlMemoriesDisabled(before);
    expect(after).toContain('model = "gpt-6"');
    expect(after).toContain("[agents]\nenabled = true");
    expect(after).toContain("[memories]");
    expect(tomlMemoriesState(after)).toEqual({
      generate_memories: "false",
      use_memories: "false",
    });
  });

  it("edits keys inside an existing [memories] table in place", () => {
    const before =
      '[memories]\ngenerate_memories = true\nother_key = 1\n\n[projects."/x"]\ntrust_level = "trusted"\n';
    const after = setTomlMemoriesDisabled(before);
    expect(after).toContain("generate_memories = false");
    expect(after).toContain("use_memories = false");
    expect(after).toContain("other_key = 1");
    expect(after).toContain('trust_level = "trusted"');
    // keys stay inside the [memories] table, before the next header
    expect(after.indexOf("use_memories = false")).toBeLessThan(
      after.indexOf('[projects."/x"]'),
    );
    // idempotent
    expect(setTomlMemoriesDisabled(after)).toBe(after);
  });
});

describe("init", () => {
  it("dry-run prints a plan and writes nothing", async () => {
    const home = tmpHome();
    const zc = join(home, "zcode");
    mkdirSync(join(zc, "cli"), { recursive: true });
    writeFileSync(join(zc, "cli", "config.json"), "{}");
    const env = makeEnv(home, "http://127.0.0.1:1");
    env.ZCODE_HOME = zc;
    env.AGENTS_HOME = join(home, "agents");
    env.FLAREMO_BIN_DIR = join(home, "bin");
    env.GEMINI_HOME = join(home, "gemini");
    env.CODEX_HOME = join(home, "codex");
    env.CODEX_BIN = "/nonexistent-codex";
    const lines: string[] = [];
    await initCmd({
      env,
      home,
      harnesses: ["zcode"],
      dryRun: true,
      log: (m: string) => lines.push(m),
    });
    expect(lines.join("\n")).toContain("plugins.dirs");
    // nothing written
    expect(readFileSync(join(zc, "cli", "config.json"), "utf-8")).toBe("{}");
    expect(existsSync(join(home, "bin", "flaremo-hook"))).toBe(false);
    expect(existsSync(join(home, "bin", "flaremo"))).toBe(false);
  });

  it("real run wires zcode: config merge, hook wrapper, symlink, memoryEnabled=false", async () => {
    const home = tmpHome();
    const zc = join(home, "zcode");
    mkdirSync(join(zc, "cli"), { recursive: true });
    mkdirSync(join(zc, "v2"), { recursive: true });
    writeFileSync(
      join(zc, "cli", "config.json"),
      JSON.stringify({ plugins: { enabledPlugins: { "x@m": true } } }),
    );
    writeFileSync(
      join(zc, "v2", "setting.json"),
      JSON.stringify({ memoryEnabled: true, locale: "zh" }),
    );
    const srv = await fakeMcpServer(); // import succeeds trivially (no memories)
    try {
      const env = makeEnv(home, srv.url);
      env.ZCODE_HOME = zc;
      env.AGENTS_HOME = join(home, "agents");
      env.FLAREMO_BIN_DIR = join(home, "bin");
      env.GEMINI_HOME = join(home, "gemini");
      await initCmd({ env, home, harnesses: ["zcode"], log: () => {} });

      const cfg = JSON.parse(
        readFileSync(join(zc, "cli", "config.json"), "utf-8"),
      );
      expect(cfg.plugins.dirs).toContain(
        join(checkoutRoot(), "harness", "zcode"),
      );
      expect(cfg.plugins.enabledPlugins["x@m"]).toBe(true); // preserved
      const setting = JSON.parse(
        readFileSync(join(zc, "v2", "setting.json"), "utf-8"),
      );
      expect(setting.memoryEnabled).toBe(false);
      expect(setting.locale).toBe("zh");
      // backups exist
      expect(existsSync(join(home, "backup", "zcode", "cli-config.json"))).toBe(
        true,
      );
      expect(existsSync(join(home, "backup", "zcode", "v2-setting.json"))).toBe(
        true,
      );
      // hook wrapper + bin symlink + skill symlink
      const wrapper = join(home, "bin", "flaremo-hook");
      expect(readFileSync(wrapper, "utf-8")).toContain("bin/flaremo");
      expect(lstatSync(join(home, "bin", "flaremo")).isSymbolicLink()).toBe(
        true,
      );
      const skillLink = join(home, "agents", "skills", "flaremo-memory");
      expect(lstatSync(skillLink).isSymbolicLink()).toBe(true);
      expect(realpathSync(skillLink)).toBe(
        realpathSync(join(checkoutRoot(), "skills", "flaremo-memory")),
      );

      // re-run is idempotent
      await initCmd({ env, home, harnesses: ["zcode"], log: () => {} });
      const cfg2 = JSON.parse(
        readFileSync(join(zc, "cli", "config.json"), "utf-8"),
      );
      expect(
        cfg2.plugins.dirs.filter(
          (d: string) => d === join(checkoutRoot(), "harness", "zcode"),
        ).length,
      ).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

describe("skill single source", () => {
  it("antigravity skill symlink resolves to skills/flaremo-memory", () => {
    const root = checkoutRoot();
    const link = join(
      root,
      "harness",
      "antigravity",
      "skills",
      "flaremo-memory",
    );
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../../../skills/flaremo-memory");
    expect(realpathSync(link)).toBe(
      realpathSync(join(root, "skills", "flaremo-memory")),
    );
  });

  it("no other SKILL.md copy exists under harness/", () => {
    const root = checkoutRoot();
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "SKILL.md") found.push(p);
      }
    };
    walk(join(root, "harness"));
    // the symlink itself does not match isDirectory-walk into a file named SKILL.md
    expect(found).toEqual([]);
  });
});
