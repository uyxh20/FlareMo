/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Dropping any file on the note composer rests on small hook-ins in two
// upstream files. After an upstream sync that drops one, this fails loudly
// instead of the composer quietly going back to images in the editor only.
// See docs/fork-customizations.md.

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("the file drop hook-ins", () => {
  it.each([
    "../components/memo-composer.tsx",
    "../components/composer/composer-focus-canvas.tsx",
  ])("%s takes a dropped file and shows the overlay", (path) => {
    const text = read(path);
    expect(text).toMatch(/from "@\/fork\/file-drop"/);
    expect(text).toMatch(/const forkDrop = useForkFileDrop\(/);
    expect(text).toContain("{...forkDrop.props}");
    expect(text).toMatch(/<ForkDropOverlay[\s\S]*?show=\{forkDrop\.over\}/);
  });
});
