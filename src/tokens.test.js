import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { designSystemPolicy } from "../../src/policy/design-system.js";
import { loadDesignSystem, loadPalette } from "../../src/policy/load.js";
import { projectTokens, resolveTokenSet } from "../../src/policy/tokens.js";

const BASE = fileURLToPath(new URL("../..", import.meta.url));
const policyOf = async (css) => designSystemPolicy(await loadDesignSystem(css, { base: BASE }));

/**
 * Yours is your namespace minus Tailwind's stock palette. Each case below is one a scan of
 * the token files' text answered differently, or could not answer at all.
 */
describe("projectTokens", () => {
  let palette;
  beforeAll(async () => {
    palette = designSystemPolicy(await loadPalette({ base: BASE }));
  });

  it("is the namespace minus Tailwind's stock palette", async () => {
    const system = await policyOf(
      '@import "tailwindcss";\n@theme { --color-primary: oklch(0.62 0.19 259); --color-danger-muted: oklch(0.7 0.1 25); }',
    );
    expect(projectTokens(system, palette)).toEqual(new Set(["primary", "danger-muted"]));
  });

  it("counts nothing as yours in a project that defines nothing", async () => {
    expect(projectTokens(await policyOf('@import "tailwindcss";'), palette)).toEqual(new Set());
  });

  it("keeps a redefined palette name out — it is still stock palette", async () => {
    const system = await policyOf(
      '@import "tailwindcss";\n@theme { --color-red-500: oklch(0.6 0.2 25); --color-brand: oklch(0.6 0.2 25); }',
    );
    expect(projectTokens(system, palette)).toEqual(new Set(["brand"]));
  });

  it("still finds yours when the palette has been cleared", async () => {
    const system = await policyOf(
      '@import "tailwindcss";\n@theme { --color-*: initial; --color-brand: oklch(0.6 0.2 25); }',
    );
    expect(projectTokens(system, palette)).toEqual(new Set(["brand"]));
  });
});

describe("resolveTokenSet", () => {
  // A contract case that varies the token set must be able to hand one over without
  // inventing a stylesheet for it.
  it("takes a list a fixture wrote", () => {
    expect(resolveTokenSet({ tokens: ["primary", "card"] })).toEqual(new Set(["primary", "card"]));
  });

  it("takes a Set the plugin bound", () => {
    expect(resolveTokenSet({ tokens: new Set(["primary"]) })).toEqual(new Set(["primary"]));
  });

  it("is empty when given nothing", () => {
    expect(resolveTokenSet()).toEqual(new Set());
    expect(resolveTokenSet({})).toEqual(new Set());
  });
});
