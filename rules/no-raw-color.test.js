import { describe, expect, it } from "vitest";

import rule from "../../src/rules/no-raw-color.js";
import { designSystem, tokens } from "../harness/options.js";

/**
 * The two ways this rule refuses to run.
 *
 * Neither can be written as a contract case: the corpus asserts what a rule reports, and a
 * rule that throws reports nothing at all — which is exactly the failure mode being guarded
 * against. Under Oxlint neither is reachable from a consumer's config: the plugin binds
 * `designSystem` and `tokens`. They guard a rule run outside the plugin. A rule
 * that returned early there would be enabled, silent and exit 0, which is indistinguishable
 * from a codebase with no raw colours in it.
 */
const create = (options) => rule.create({ options: [options] });

const resolved = { designSystem, tokens };

describe("refusing to run", () => {
  it("throws without a resolved design system, rather than reporting nothing", () => {
    expect(() => create({ tokens })).toThrow(
      /designSystem\.colorPrefixes` is missing or is not a Set/,
    );
    expect(() => rule.create({ options: [] })).toThrow(/is missing or is not a Set/);
  });

  it("throws on a resolved input that arrived as a husk", () => {
    // What a `Set` looks like after a trip through `JSON.stringify` — the plumbing mistake
    // of passing a resolved input as an option instead of binding it around `create`.
    expect(() => create({ designSystem: { colorPrefixes: {} }, tokens: {} })).toThrow(
      /cannot be passed as a JSON option/,
    );
    expect(() => create({ ...resolved, tokens: {} })).toThrow(
      /`tokens` is missing or is not a Set/,
    );
  });

  it("runs on the options a consumer actually writes", () => {
    expect(() =>
      create({
        ...resolved,
        namedColors: false,
        checkStandaloneColorLiterals: false,
        ignoreValues: ["transparent"],
        ignoreGlobs: [],
      }),
    ).not.toThrow();
  });
});
