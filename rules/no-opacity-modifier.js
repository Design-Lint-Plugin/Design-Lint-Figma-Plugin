import { sweepVisitors } from "../extract/index.js";
import { IGNORE_GLOBS_SCHEMA, ignoredFile, STORY_GLOBS } from "../policy/ignore.js";
import { classTokens } from "../policy/tokenize.js";
import { parseClass } from "../policy/variants.js";

/**
 * no-opacity-modifier — a colour class must not carry an opacity modifier.
 *
 * The specification is `test/contracts/no-opacity-modifier.js`, whose cases the Oxlint adapter runs
 * against this object; `docs/rules/no-opacity-modifier.md` is the guide for the people using it.
 *
 * The rule is **context-free**: `bg-primary/50` is derived at the call site wherever it is
 * written, so which element the string reaches is not a question it has to ask. That is why
 * it runs over `sweepVisitors` — every string literal and every static template segment in
 * the file — and gets `cn()` arguments, `cva()` variant maps and `.ts` constants for free,
 * without parsing a single wrapper.
 *
 * The breadth is only safe because the *decision* is narrow, and all of it comes from
 * `/policy` rather than from where the string was found:
 *
 * 1. **A modifier is present**, split off with bracket depth respected, so the slash in
 *    `bg-[url(a/b.png)]` is not one and neither is the one in `group-hover/nav:`.
 * 2. **It is opacity syntax** — a bare number or a bracketed value. `bg-primary/auto` is
 *    meaningless rather than translucent, and belongs to `no-undefined-token`.
 * 3. **The utility sits under a derived colour prefix**, so `w-1/2` and `aspect-16/9` are
 *    never looked at twice.
 * 4. **The body is not a resolvable non-colour.** This is the gate that separates
 *    `text-primary/50` from `text-sm/6` — the same shape, opposite verdicts, and the false
 *    positive a prefix check alone would produce. See {@link isColorBody} for why the test is
 *    written as a double negative rather than as `isColorClass` alone.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Color classes must not carry an opacity modifier.",
    },
    messages: {
      opacityModifierOnColor:
        "{{className}} — opacity modifier on a color class; define a token for {{base}} at {{modifier}} instead of deriving it here",
      // A full-opacity modifier changes nothing, so the fix is to delete it — not to define a
      // token for a colour at 100%.
      fullOpacityModifier: "{{className}} — /{{modifier}} changes nothing; delete the modifier",
    },
    schema: [
      {
        type: "object",
        properties: {
          // The resolved policy view from `designSystemPolicy()`. Required: the two gates
          // that keep the sweep quiet are both questions only Tailwind can answer.
          designSystem: { type: "object" },
          allowFullOpacity: { type: "boolean" },
          colorPrefixes: { type: "array", items: { type: "string" } },
          ignoreGlobs: IGNORE_GLOBS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ allowFullOpacity: false, ignoreGlobs: [...STORY_GLOBS] }],
  },

  create(context) {
    const {
      designSystem,
      allowFullOpacity = false,
      colorPrefixes = [],
      ignoreGlobs = STORY_GLOBS,
    } = context.options[0] ?? {};

    // Without the design system there is no colour test, and without a colour test this
    // rule is either `text-sm/6` reported or nothing reported. A quiet degraded mode would
    // be indistinguishable from a clean codebase, so it says so instead.
    if (!designSystem) {
      throw new Error(
        "no-opacity-modifier: options.designSystem is required — designLint() builds it once from its tokenFiles, and the plugin binds it around `create`; it cannot be passed as a JSON option.",
      );
    }

    if (ignoredFile(context.filename, ignoreGlobs)) return {};

    // A Tailwind plugin can introduce a colour utility that `getClassList()` never
    // enumerates, so the option *adds* to the derived set. It never replaces it:
    // hand-maintaining that set is the bug the derivation exists to avoid.
    const prefixes =
      colorPrefixes.length === 0
        ? designSystem.colorPrefixes
        : new Set([...designSystem.colorPrefixes, ...colorPrefixes]);

    // The design system's own colour test knows only the derived set, so a plugin utility
    // the option adds — `glow-primary/50` — would pass it and go unreported, which is the
    // one case the option exists for. For those roots the question is asked the way the
    // design system asks it of a named value: is the name a colour in the theme?
    const added = new Set(colorPrefixes.filter((p) => !designSystem.colorPrefixes.has(p)));
    const namesAColor = (base, root) => {
      if (!added.has(root)) return false;
      const name = base.slice(root.length + 1);
      return designSystem.colorNames.has(name) || COLOR_KEYWORDS.has(name);
    };

    /** The class carries an opacity modifier on a colour, or it does not. */
    const violationIn = (written) => {
      const { base, opacity } = parseClass(written);
      if (opacity === null || base === "") return null;
      if (!OPACITY_MODIFIER.test(opacity)) return null;
      if (allowFullOpacity && isFullOpacity(opacity)) return null;

      const root = designSystem.parseRoot(base);
      if (!root || !prefixes.has(root)) return null;
      if (!isColorBody(designSystem, base) && !namesAColor(base, root)) return null;

      return { base, modifier: opacity, full: isFullOpacity(opacity) };
    };

    return sweepVisitors((source) => {
      for (const token of classTokens(source)) {
        // A class with an interpolation in it is not judged: what it becomes is unknowable,
        // and every rule in the package draws that line in the same place.
        if (token.dynamic) continue;

        const written = token.text;
        const violation = violationIn(written);
        if (!violation) continue;

        context.report({
          // The class token, not the string that contains it: four offending classes in one
          // `className` are four separate spans. A token the tokenizer could not place —
          // one written with an escape — has no range, and the literal is the fallback.
          node: token.range ? { range: token.range } : source.node,
          messageId: violation.full ? "fullOpacityModifier" : "opacityModifierOnColor",
          data: {
            className: written,
            base: violation.base,
            modifier: violation.modifier,
          },
        });
      }
    });
  },
};

/**
 * Every spelling of an opacity modifier: a bare number, and any bracketed value —
 * `/[0.5]`, `/[50%]`, `/[var(--overlay-alpha)]`. All four mean the same thing.
 *
 * What it excludes is the point. `bg-primary/auto` is not translucent, it is meaningless,
 * and reporting it here would say the wrong thing about it — `no-undefined-token` owns a
 * class that resolves to nothing.
 */
const OPACITY_MODIFIER = /^(?:\d+(?:\.\d+)?|\[[^\]]*\])$/;

/**
 * The colour keywords Tailwind handles itself rather than through the theme — the same three
 * the design system's colour test accepts for a named value.
 */
const COLOR_KEYWORDS = new Set(["transparent", "current", "inherit"]);

/**
 * Is `/100` — or `/[100%]`, or `/[1]` — the same no-op alpha under a different spelling?
 *
 * Tailwind reads a bare number as a percentage and a bracketed decimal as a fraction, so
 * "fully opaque" is `100`, `[100%]` and `[1]`. `allowFullOpacity` turns off a no-op alpha,
 * not one particular way of typing it.
 */
function isFullOpacity(modifier) {
  if (!modifier.startsWith("[")) return Number(modifier) === 100;
  const value = modifier.slice(1, -1);
  if (value.endsWith("%")) return Number(value.slice(0, -1)) === 100;
  return Number(value) === 1;
}

/**
 * Does the body of this class name a colour?
 *
 * The obvious spelling — `isColorClass(base)` — is *too* narrow, because it answers "no"
 * to two different questions at once: `text-sm` is not a colour, and `border-input` is not
 * a colour *here*, in a design system whose stylesheet never defined `--color-input`. The
 * first is the near-miss this rule must stay off; the second is a colour class whose token
 * is missing, which is `no-undefined-token`'s subject and not a reason to let the modifier
 * through. Deriving `bg-nonesuch/50` at a call site is wrong twice over, and the contract
 * says both rules report it.
 *
 * So the test is the double negative: under a colour prefix, a class is *not* a colour only
 * when the design system resolves it to something else. `text-sm` generates a `font-size`
 * declaration and is excluded; `border-input` generates nothing and is not.
 */
function isColorBody(designSystem, base) {
  return !designSystem.resolves(base) || designSystem.isColorClass(base);
}
