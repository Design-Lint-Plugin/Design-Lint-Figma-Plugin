import { RuleTester } from "oxlint/plugins-dev";
import { describe, expect, it } from "vitest";

import { ruleFor } from "../harness/options.js";

/**
 * A replacement is named only when the project defines it.
 *
 * The contract corpus asserts how many reports a case produces, not which message — so the
 * difference between "use bg-danger instead" and a plain report cannot be a contract case.
 * The fixture stylesheet defines `danger-muted` but no `danger`, which is exactly the
 * project the default map is wrong for.
 */
RuleTester.describe = describe;
RuleTester.it = it;

const config = { eslintCompat: true, languageOptions: { parserOptions: { lang: "tsx" } } };

new RuleTester(config).run("no-spectral-color — replacements", ruleFor("no-spectral-color"), {
  valid: [],
  invalid: [
    {
      name: "a default replacement the project does not define is not suggested",
      code: '<div className="bg-red-500" />',
      errors: [{ messageId: "spectralColor" }],
    },
    {
      name: "a replacement the project defines is named, and offered as a suggestion",
      code: '<div className="bg-red-500" />',
      options: [{ replacement: { bg: [{ "red-400...600": "danger-muted" }] } }],
      errors: [
        {
          messageId: "spectralColorWithReplacement",
          suggestions: [{ messageId: "useReplacement", output: '<div className="bg-danger-muted" />' }],
        },
      ],
    },
    {
      name: "a consumer's map naming a missing token is not suggested either",
      code: '<div className="bg-red-500" />',
      options: [{ replacement: { bg: [{ "red-400...600": "nonesuch" }] } }],
      errors: [{ messageId: "spectralColor" }],
    },
  ],
});

/**
 * The message names what the class drew from: a palette for a scaled colour, the stock colour
 * itself for `white` and `black`, which have no palette to name.
 */
new RuleTester(config).run("no-spectral-color — message", ruleFor("no-spectral-color"), {
  valid: [],
  invalid: [
    {
      name: "a scaled colour names its palette",
      code: '<div className="text-slate-500" />',
      errors: [
        {
          message:
            "text-slate-500 — spectral color class; use a semantic token instead of the slate palette",
        },
      ],
    },
    {
      name: "an unscaled colour names the stock colour, not a palette",
      code: '<div className="text-white" />',
      errors: [
        {
          message:
            "text-white — spectral color class; use a semantic token instead of the stock white",
        },
      ],
    },
  ],
});

/**
 * A `replacement` map of the wrong shape is a configuration error. Without the schema it
 * validates, matches nothing, and the rule quietly names no token — indistinguishable from a
 * map that simply has no entry for the class.
 */
describe("no-spectral-color — replacement shape", () => {
  it("rejects a map whose prefix holds an object rather than a list", () => {
    const previous = { describe: RuleTester.describe, it: RuleTester.it };
    RuleTester.describe = (_name, fn) => fn();
    RuleTester.it = (_name, fn) => fn();
    try {
      expect(() =>
        new RuleTester(config).run("shape", ruleFor("no-spectral-color"), {
          valid: [
            {
              code: '<div className="p-2" />',
              options: [{ replacement: { bg: { "red-500": "danger" } } }],
            },
          ],
          invalid: [],
        }),
      ).toThrow(/Options validation failed/);
    } finally {
      Object.assign(RuleTester, previous);
    }
  });
});
