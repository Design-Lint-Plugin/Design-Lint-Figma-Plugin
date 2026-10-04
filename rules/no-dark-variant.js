import { sweepVisitors } from "../extract/index.js";
import { IGNORE_GLOBS_SCHEMA, ignoredFile, STORY_GLOBS } from "../policy/ignore.js";
import { classTokens } from "../policy/tokenize.js";
import { parseClass, stripGroupName } from "../policy/variants.js";

/**
 * no-dark-variant — theming happens in the token file, and nowhere else.
 *
 * The specification is `test/contracts/no-dark-variant.js`, whose cases the Oxlint adapter runs
 * against this object; `docs/rules/no-dark-variant.md` is the guide for the people using it.
 *
 * Two forms of the same defect, a second theming mechanism:
 *
 * - the `dark:` variant, which re-decides the theme at one element, and
 * - `light-dark()` in an arbitrary value, which re-decides it inside one declaration.
 *
 * Both are caught wherever a class string is written, because the rule is **context-free**:
 * `dark:bg-card` is a theme fork in a `cva()` variant map and in a `.ts` constants file
 * exactly as much as on a `className`, and none of those need parsing to see it. That is
 * why it runs over `sweepVisitors` — every string literal and every static template segment
 * in the file — and gets every wrapper, from `cn()` to an object map, for free.
 *
 * ## Why segmentation rather than a regex
 *
 * Testing the raw class against `/(?:^|:)dark:/` is right for the wrong reason: it allows `bg-dark-muted` because a `-` precedes `dark:`, and misses
 * `not-dark:` for the same reason. Here `dark` is matched as a **variant segment** — split
 * on `:` at bracket depth zero by `/policy`, group name stripped — so `bg-dark-muted` is a
 * utility body, `[@media(prefers-color-scheme:dark)]:` is one arbitrary segment, and
 * position in `md:dark:hover:` is irrelevant by construction rather than by luck.
 *
 * The one segment this rule adds to `/policy`'s family predicate is the negation.
 * `inFamily` excludes `not-` deliberately, because a `not-hover:` colour would name a
 * `-hover` token backwards; there is no such reading for a theme. `not-dark:` depends on
 * the same `.dark` root class this design system does not use, so it is the same fork seen
 * from the other side — which is why the predicate is local here rather than a change to
 * the shared one.
 *
 * ## The one thing it declines to call a violation
 *
 * `` `dark:${utility}` `` reports and `"dark:" + utility` does not, and the difference is
 * not the operator. A template literal is one class token whose static half spells out the
 * variant and whose hole is the utility — the fork is fully visible. A `+` hands the sweep
 * the string `"dark:"` on its own: a prefix with no class attached, which is a fragment
 * rather than a defect. So a static token whose utility is empty is left alone, and the
 * contract records it as a blind spot.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "The `dark:` variant and `light-dark()` must not appear in application code.",
    },
    messages: {
      darkVariant:
        "{{className}} — dark: variant not allowed; theming is resolved by your --color-* tokens, so use a semantic token for {{utility}}",
      // A token is no answer for a utility that is not a colour: `dark:hidden` is a theme
      // branch with nothing for a token to resolve, so the advice has to be different.
      darkVariantNonColor:
        "{{className}} — dark: variant not allowed; theming is resolved by your --color-* tokens, and {{utility}} is not a colour, so no token replaces it — drop the theme branch, or for a light/dark asset pair use one component that picks the file",
      lightDarkFunction:
        "{{source}} — light-dark() is a second theming mechanism; a --color-* token already resolves per theme, so give the property both values in your token stylesheet and reference the token here",
    },
    // The JSON half only. `designSystem` is bound around `create` rather than written in a
    // config, so it never reaches the validator — and a consumer who tries to write one by
    // hand should be told it is not theirs to write.
    schema: [
      {
        type: "object",
        properties: {
          flagNonColorUtilities: { type: "boolean" },
          flagLightDark: { type: "boolean" },
          ignoreGlobs: IGNORE_GLOBS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],

    // The recommended policy. Every value is a boolean or a list, which Oxlint's deep
    // `defaultOptions` merge replaces whole rather than unioning — so carrying them here is
    // safe, and a consumer who wipes the factory's options by writing
    // `"design/no-dark-variant": "error"` lands on the recommended behaviour rather than on
    // nothing. The same values are the destructuring defaults in `create`, because
    // `RuleTester` does not apply `defaultOptions`.
    defaultOptions: [
      {
        flagNonColorUtilities: true,
        flagLightDark: true,
        ignoreGlobs: [...STORY_GLOBS],
      },
    ],
  },

  create(context) {
    const {
      designSystem,
      flagNonColorUtilities = true,
      flagLightDark = true,
      ignoreGlobs = STORY_GLOBS,
    } = context.options[0] ?? {};

    // The default reading needs no design system: `dark:` is a theme fork whatever it
    // modifies, and segmentation answers that on its own. Narrowing to colour-carrying
    // classes is the one mode that has to ask Tailwind a question, so it is the one mode
    // that requires the bound policy view — loudly, because a narrowed rule that silently
    // reported nothing would be indistinguishable from a clean codebase.
    if (!flagNonColorUtilities && !designSystem?.isColorClass) {
      throw new Error(
        "no-dark-variant: flagNonColorUtilities: false needs the resolved design system — `designLint()` builds it from its tokenFiles and the plugin binds it around `create` at load; it cannot be passed as a JSON option. Load the plugin through `designLint()`.",
      );
    }

    if (ignoredFile(context.filename, ignoreGlobs)) return {};

    // The token stylesheets' exemption — `light-dark()` and `.dark &` are legitimate in the
    // file that gives a `--color-*` property its per-theme value — is not implemented:
    // nothing needs it while `.css` is out of scope, and it lands with the CSS surface.

    /**
     * Is there a defect here to point at?
     *
     * Two gates, and they fail in opposite directions on purpose. A token with no utility
     * is the bare `"dark:"` a `+` concatenation leaves behind — a fragment, and the
     * contract's blind spot. `flagNonColorUtilities: false` is the opposite: a project that
     * has weighed the asset-swap idiom and wants the narrower boundary, where `dark:hidden`
     * is out and `dark:bg-card` stays in.
     */
    const reportable = (base) => {
      if (base === "") return false;
      if (flagNonColorUtilities) return true;
      return designSystem.isColorClass(base);
    };

    /**
     * Is this a utility that generates CSS and sets no colour?
     *
     * Only then is the token advice wrong. A class that generates nothing — `dark:text-muted`
     * where `muted` was never defined — is still under a colour prefix and still wants a
     * token, so it keeps the colour message. Without a bound design system the question has
     * no answer, and the colour message is the one this rule always gave.
     */
    const nonColorUtility = (base) =>
      Boolean(designSystem?.resolves && designSystem.resolves(base) && !designSystem.isColorClass(base));

    let calls;

    return sweepVisitors((source) => {
      calls = lightDarkCalls(source);
      for (const token of classTokens(source)) {
        // A class with an interpolation in it is never judged, by this rule or any other:
        // what it becomes is unknowable, and guessing from half a class is where rules
        // start to disagree. Complete classes around it in the same template still are.
        if (token.dynamic) continue;
        const className = token.text;

        // The class token, not the string that contains it: two offending classes in one
        // `className` are two separate spans. A token whose offsets cannot be trusted —
        // written with an escape — carries no range, and the literal is the honest fallback.
        const node = spanOf(token, source);

        const { variants, base } = parseClass(className);

        if (variants.some(isDarkVariant) && reportable(base)) {
          context.report({
            node,
            messageId: nonColorUtility(base) ? "darkVariantNonColor" : "darkVariant",
            data: { className, utility: base },
          });
        }

        if (flagLightDark && className.includes(LIGHT_DARK)) {
          // A call spread over several tokens is reported where it is written, whole — the
          // same text the message quotes — rather than at its first token.
          const call = calls.callFor(className);
          context.report({
            node: call.range ? { range: call.range } : node,
            messageId: "lightDarkFunction",
            data: { source: call.source },
          });
        }
      }
    });
  },
};


/** The call, matched with its open paren so the bare word `light-dark` is not a match. */
const LIGHT_DARK = "light-dark(";

/**
 * The `light-dark()` calls written in one class source, handed out in order.
 *
 * A class token stops at whitespace, and a call in a `style` value or a CSS string does not:
 * `"light-dark(#000, #fff)"` is the tokens `light-dark(#000,` and `#fff)`, so quoting the
 * token would print half a call, and point at half of one. `callFor` answers with the class
 * itself when the call closes inside it — `bg-[light-dark(var(--a),var(--b))]` is the thing
 * to edit, so its `range` is left to the caller — and otherwise with the whole call and its
 * span, recovered from the text around it. Calls are consumed in the order tokens meet them,
 * so two different calls in one string are each quoted as written. A call never spans a
 * hole: the static text on each side of one is scanned alone.
 */
function lightDarkCalls(source) {
  const found = [];
  for (const segment of source.segments) {
    const { text } = segment;
    let at = text.indexOf(LIGHT_DARK);
    while (at !== -1) {
      const call = balancedCall(text, at).text;
      // An escape makes the segment's offsets untrustworthy, as it does a token's.
      const trusted = segment.exact && segment.start !== undefined;
      found.push({
        text: call,
        range: trusted ? [segment.start + at, segment.start + at + call.length] : null,
      });
      at = text.indexOf(LIGHT_DARK, at + LIGHT_DARK.length);
    }
  }

  let next = 0;
  return {
    callFor(className) {
      const first = found[next] ?? null;
      next += className.split(LIGHT_DARK).length - 1;
      const { closed } = balancedCall(className, className.indexOf(LIGHT_DARK));
      return closed || first === null
        ? { source: className, range: null }
        : { source: first.text, range: first.range };
    },
  };
}

/** The call starting at `at`, through its matching paren — or to the end if it never closes. */
function balancedCall(text, at) {
  let depth = 0;
  for (let i = at + LIGHT_DARK.length - 1; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return { text: text.slice(at, i + 1), closed: true };
  }
  return { text: text.slice(at).trim(), closed: false };
}

/**
 * Does this variant segment branch on the theme?
 *
 * An **arbitrary variant** never does, whatever it spells inside the brackets:
 * `[.dark_&]:` and `[@media(prefers-color-scheme:dark)]:` reconstruct the fork out of a
 * selector this rule declines to model, and both are declared blind spots. Everything else
 * is the segment's own name with any group name stripped, so `group-hover/nav:dark:` is two
 * segments of which the second matches.
 */
function isDarkVariant(segment) {
  if (segment.startsWith("[")) return false;
  const name = stripGroupName(segment);
  return name === "dark" || name === "not-dark";
}

/**
 * Where to report: the class itself when the tokenizer could place it, the string that
 * holds it when it could not.
 */
function spanOf(token, source) {
  return token.range ? { range: token.range } : source.node;
}
