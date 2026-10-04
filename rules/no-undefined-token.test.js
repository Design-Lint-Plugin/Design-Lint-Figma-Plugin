import { describe, expect, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { fileURLToPath } from "node:url";

import { bindResolved } from "../../src/plugin.js";
import { designSystemPolicy } from "../../src/policy/design-system.js";
import { loadDesignSystem } from "../../src/policy/load.js";
import rule from "../../src/rules/no-undefined-token.js";
import { ruleFor, sparseDesignSystem } from "../harness/options.js";

/**
 * The two promises this rule's contract makes that its corpus cannot express.
 *
 * The corpus asserts what a rule reports, which leaves both of these out of reach: a rule
 * that throws reports nothing at all, and a case counts reports without ever reading one.
 * Both are promises about the rule that reports an *absence*, where a report and its
 * message are the only evidence anything ran.
 */

const create = (options) => rule.create({ options: [options] });

describe("refusing to run", () => {
  /**
   * The failure mode to refuse. A resolver built with `.catch(() => null)` and an early
   * return turns a missing dependency or an unresolvable `@import` into a rule that is off,
   * with no output and exit code 0 — indistinguishable from a codebase with no violations,
   * and quietly weakening `token-constraints` with it.
   *
   * The design system is bound rather than passed as an option, so a severity-only
   * override cannot remove it; what reaches this check is the rule run outside the plugin.
   */
  it("throws without a resolved design system, rather than reporting nothing", () => {
    expect(() => rule.create({ options: [] })).toThrow(/designSystem/);
    expect(() => create({})).toThrow(/designSystem/);
  });

  /**
   * A design system passed as an option instead of bound arrives as a husk — every method
   * gone, `colorPrefixes` an empty object — which would otherwise resolve nothing, report
   * everything, and look like a rule that had simply gone mad.
   */
  it("throws on a design system that did not survive JSON", () => {
    const husk = JSON.parse(JSON.stringify({ designSystem: sparseDesignSystem }));
    expect(() => create(husk)).toThrow(/designSystem/);
  });

  /**
   * The spelling hint is not the diagnostic. Without a token set the rule still answers its
   * own question, so it runs; refusing here would trade a real report for a nicety.
   */
  it("runs without a token set, which only costs it the candidates", () => {
    expect(() => create({ designSystem: sparseDesignSystem })).not.toThrow();
  });
});

/**
 * Suggestions do not render in any CLI output format and `meta.docs.url` is dead under
 * Oxlint, so the message text is the only channel this rule has. The typo candidate must
 * reach that text, and this is where it is checked: `locations.test.js` asserts the suggestion payload, which is the
 * half a terminal never sees.
 */
RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({
  eslintCompat: true,
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run("no-undefined-token — the message a terminal prints", ruleFor("no-undefined-token"), {
  valid: [],
  invalid: [
    {
      name: "names the candidate and the token to add",
      code: '<div className="bg-primry" />;',
      errors: [
        {
          message:
            "bg-primry generates no CSS — primry is not defined; check the spelling — did you mean bg-primary? — or add --color-primry to your token stylesheet",
        },
      ],
    },
    {
      name: "leads with the spelling when the design system has no candidate to offer",
      code: '<div className="text-secondary" />;',
      errors: [
        {
          message:
            "text-secondary generates no CSS — secondary is not defined; check the spelling, or add --color-secondary to your token stylesheet",
        },
      ],
    },
  ],
});

/**
 * A project that clears Tailwind's palette and defines only its own colours has no `red-500`
 * for the prefix probe to find. The rule is gated on that prefix set, so a probe that came
 * back empty would leave it enabled, silent and exit 0 on every typo in the codebase.
 */
const RESET = [
  '@import "tailwindcss";',
  "@theme { --color-*: initial; --color-primary: oklch(0.6 0.2 25); }",
].join("\n");
const resetSystem = designSystemPolicy(
  await loadDesignSystem(RESET, { base: fileURLToPath(new URL("../..", import.meta.url)) }),
);

new RuleTester({
  eslintCompat: true,
  languageOptions: { parserOptions: { lang: "tsx" } },
}).run(
  "no-undefined-token — a stylesheet that resets the stock palette",
  bindResolved(rule, { designSystem: resetSystem, tokens: new Set(["primary"]) }),
  {
    valid: ['<div className="bg-primary text-primary" />;'],
    invalid: [
      {
        name: "still reports a typo",
        code: '<div className="bg-primry" />;',
        errors: [{ messageId: "undefinedColorTokenWithCandidate" }],
      },
    ],
  },
);
