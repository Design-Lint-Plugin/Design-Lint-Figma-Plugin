import { describe, expect, it } from "vitest";

import rule from "../../src/rules/no-dark-variant.js";
import { designSystem } from "../harness/options.js";

/**
 * The one way this rule refuses to run, and the one way it must not.
 *
 * Neither can be written as a contract case: the corpus asserts what a rule reports, and a
 * rule that throws reports nothing at all — which is the failure mode being guarded
 * against. The asymmetry is the point. `flagNonColorUtilities: false` narrows reporting to
 * classes that carry a colour, a question only the resolved design system can answer, so
 * without it the rule would fall silent in exactly the configuration a project chose to
 * make it quieter — indistinguishable from a clean codebase. The default reading needs no
 * such answer, and demanding one there would make a rule that works fine refuse to start.
 */
const create = (options) => rule.create({ options: [options], filename: "a.tsx" });

describe("refusing to run", () => {
  it("throws when narrowed to colour utilities without a resolved design system", () => {
    expect(() => create({ flagNonColorUtilities: false })).toThrow(/needs the resolved design system/);
  });

  it("throws when the design system arrived as a JSON husk with its methods gone", () => {
    expect(() =>
      create({ flagNonColorUtilities: false, designSystem: JSON.parse('{"colorPrefixes":{}}') }),
    ).toThrow(/needs the resolved design system/);
  });

  it("starts on the widest reading with nothing bound, because it asks Tailwind nothing", () => {
    expect(() => rule.create({ options: [], filename: "a.tsx" })).not.toThrow();
  });

  it("starts when narrowed and the design system is bound", () => {
    expect(() => create({ flagNonColorUtilities: false, designSystem })).not.toThrow();
  });
});

/**
 * What the messages quote and advise. The corpus asserts counts, not text, so the two ways a
 * message could mislead are asserted here.
 */
describe("messages", () => {
  const run = (code) => {
    const reports = [];
    const visitors = rule.create({
      options: [{ designSystem }],
      filename: "a.tsx",
      report: (descriptor) => reports.push(descriptor),
    });
    return { reports, visitors };
  };

  const literal = (value) => ({
    type: "Literal",
    value,
    raw: JSON.stringify(value),
    range: [0, value.length + 2],
    parent: { type: "ExpressionStatement" },
  });

  const reportsFor = (value) => {
    const { reports, visitors } = run();
    visitors.Literal?.(literal(value));
    return reports;
  };

  it("quotes a whole light-dark() call, not the half before its first space", () => {
    const [report] = reportsFor("light-dark(#000, #fff)");
    expect(report.messageId).toBe("lightDarkFunction");
    expect(report.data.source).toBe("light-dark(#000, #fff)");
  });

  it("quotes the class when the call closes inside it", () => {
    const [report] = reportsFor("bg-[light-dark(var(--a),var(--b))]");
    expect(report.data.source).toBe("bg-[light-dark(var(--a),var(--b))]");
  });

  it("does not advise a token for a utility that is not a colour", () => {
    const [report] = reportsFor("dark:hidden");
    expect(report.messageId).toBe("darkVariantNonColor");
  });

  it("keeps the token advice for a colour utility", () => {
    const [report] = reportsFor("dark:bg-card");
    expect(report.messageId).toBe("darkVariant");
  });
});
