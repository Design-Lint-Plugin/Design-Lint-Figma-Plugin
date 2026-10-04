import { sweepVisitors } from "../extract/index.js";
import { IGNORE_GLOBS_SCHEMA, ignoredFile, STORY_GLOBS } from "../policy/ignore.js";
import { classTokens } from "../policy/tokenize.js";
import { parseClass } from "../policy/variants.js";

/**
 * no-spectral-color — Tailwind's built-in palette must not colour anything.
 *
 * The specification is `test/contracts/no-spectral-color.js`, whose cases the Oxlint adapter runs
 * against this object; `docs/rules/no-spectral-color.md` is the guide for the people using it.
 *
 * The rule is **context-free**: it asks "is this string a forbidden class?" and never needs
 * to know which element the string reaches. So it runs over `sweepVisitors` — every string
 * literal and every static template segment in the file — and a `cn()` argument, a `cva()`
 * variant map and a `.ts` constants file are one string each, with no plumbing that has to
 * know about any of them.
 *
 * ## What makes a class spectral
 *
 * Not a list of family names, and not a regular expression over `-\d+`. A class carries a
 * colour when some suffix of it is a name in the theme's `--color` namespace and what
 * stands in front of that name begins with a colour-carrying utility. Both of those come
 * from probing the design system at load, so `inset-ring-`, `text-shadow-`, the per-side
 * border families and every palette family Tailwind ships arrive without anyone maintaining
 * a list.
 *
 * That colour is **spectral** when the project's own token file did not define it. The
 * subtraction is the whole idea: the namespace holds `red-500` and `primary` as the same
 * kind of thing, and the token set is exactly the half the project chose. It also settles
 * three cases that would otherwise each need a rule of their own — `text-sm` and `border-2`
 * are not colours at all, `transparent` and `current` are keywords Tailwind handles rather
 * than theme colours, and `bg-brand` is a name this project defined, which is the declared
 * blind spot.
 *
 * ## Prefix in, prefix out
 *
 * The prefix the message names is whatever the author wrote before the colour, so
 * `divide-x-red-500` is answered with `divide-x-<token>` and not `divide-<token>` — the
 * former is the text they have to edit. The gate only asks that this text *begin* with a
 * declared colour prefix, which is why the class is caught at all: `divide-x-*` takes a
 * width, so it generates nothing, and the contract still wants the evident attempt at a
 * palette colour reported.
 *
 * ## Where its inputs come from
 *
 * Both halves are read from `context.options[0]`, and they get there by different routes.
 * `replacement`, `flagFixedColors` and `ignoreGlobs` are JSON a consumer writes.
 * `designSystem` and `tokens` are not JSON — they cross that boundary as husks — so
 * `designLint()` builds them once from the `tokenFiles` passed to it, and the plugin module binds them around `create`
 * with `bindResolved` in [`src/plugin.js`](../plugin.js). The rule cannot tell the
 * difference, which is the point.
 */
export default {
  meta: {
    type: "problem",
    hasSuggestions: true,
    docs: {
      description: "Tailwind's built-in color palette must not be used to color anything.",
    },
    messages: {
      spectralColorWithReplacement:
        "{{className}} — spectral color class; use {{prefix}}-{{replacement}} instead",
      spectralColor:
        "{{className}} — spectral color class; use a semantic token instead of {{palette}}",
      useReplacement: "Replace {{className}} with {{prefix}}-{{replacement}}",
    },
    // The JSON half only. `designSystem` and `tokens` are bound around `create` rather than
    // written in a config, so they never reach the validator — and a consumer who tries to
    // write one by hand should be told it is not theirs to write.
    schema: [
      {
        type: "object",
        properties: {
          flagFixedColors: { type: "boolean" },
          // `{ bg: [{ "red-400...600": "danger" }, …], text: [...] }`. A map of the wrong shape
          // would otherwise validate and quietly name no token at all.
          replacement: {
            type: "object",
            additionalProperties: {
              type: "array",
              items: { type: "object", additionalProperties: { type: "string" } },
            },
          },
          ignoreGlobs: IGNORE_GLOBS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],

    // The recommended policy, minus `replacement`. Oxlint merges `defaultOptions` **deeply**
    // for an object-valued option, so a consumer who supplies a `replacement` map with
    // `text` deliberately left out gets the default's `text` back and never learns why.
    // Booleans and arrays are replaced whole and are safe here; the map is applied in
    // `create` instead, where "no map supplied" and "this map" are the only two outcomes.
    defaultOptions: [
      {
        flagFixedColors: true,
        ignoreGlobs: [...STORY_GLOBS],
      },
    ],
  },

  create(context) {
    const {
      designSystem,
      tokens,
      flagFixedColors = true,
      replacement = recommendedReplacement(),
      ignoreGlobs = STORY_GLOBS,
    } = context.options[0] ?? {};

    // Silence is indistinguishable from a clean codebase, so a rule that cannot do its job
    // says so rather than reporting nothing. These three are the load step's output, not a
    // consumer's typing: their absence means the plugin bound nothing, and the shape they
    // arrive in says which mistake it was — a husk means they were passed as options and
    // did not survive the JSON boundary.
    const colorPrefixes = requiredSet(designSystem?.colorPrefixes, "designSystem.colorPrefixes");
    const colorNames = requiredSet(designSystem?.colorNames, "designSystem.colorNames");
    const semantic = requiredSet(tokens, "tokens");

    if (ignoredFile(context.filename, ignoreGlobs)) return {};

    return sweepVisitors((source) => {

      for (const token of classTokens(source)) {
        // Every token advances the cursor, reported or not, so a class written twice in one
        // string is located twice rather than reported at its first occurrence both times.
        const range = token.range;
        const at = range ? { loc: spanOf(context, range) } : { node: source.node };

        // A class with an interpolation in it is never judged: nothing says what it becomes.
        if (token.dynamic) continue;

        const found = spectralIn(token.text, designSystem, colorPrefixes, colorNames, semantic, flagFixedColors);
        if (!found) continue;

        const { prefix, color, family, scale } = found;
        // A replacement is named only when the project defines it. The default map assumes a
        // success/info/warning/danger vocabulary, and a suggestion to write `bg-danger` in a
        // project without that token hands the author a class `no-undefined-token` reports.
        const mapped = replacementFor(replacement, prefix, family, scale);
        const replacementToken = mapped && semantic.has(mapped) ? mapped : null;
        // `white` and `black` have no scale, so "the white palette" would name something that
        // does not exist; they are the stock colour itself.
        const palette = scale ? `the ${family} palette` : `the stock ${family}`;
        const data = { className: token.text, prefix, family, scale: scale ?? "", palette };

        if (!replacementToken) {
          context.report({ ...at, messageId: "spectralColor", data });
          continue;
        }

        context.report({
          ...at,
          messageId: "spectralColorWithReplacement",
          data: { ...data, replacement: replacementToken },
          // A suggestion in addition to the message, never instead of it: suggestions do
          // not render in any CLI output, so the token has to be in the text as well. It is
          // offered only where the class was located in the source, because a fix that
          // cannot point at the characters it replaces is not a fix.
          suggest: range
            ? [
                {
                  messageId: "useReplacement",
                  data: { className: token.text, prefix, replacement: replacementToken },
                  fix: (fixer) =>
                    fixer.replaceTextRange(
                      range,
                      token.text.replace(`${prefix}-${color}`, `${prefix}-${replacementToken}`),
                    ),
                },
              ]
            : undefined,
        });
      }
    });
  },
};

/**
 * A required resolved input, which is always a live `Set`.
 *
 * The `Set` check is not pedantry: an empty object is exactly what one of these looks like
 * after a trip through `JSON.stringify`, so the failure this catches is the plumbing
 * mistake of passing a resolved input as an option instead of binding it. Nothing is
 * defaulted — a rule that shrugged would report nothing and look like a clean codebase.
 */
function requiredSet(value, name) {
  if (!(value instanceof Set)) {
    throw new Error(
      `no-spectral-color: \`${name}\` is missing or is not a Set — \`designLint()\` resolves it from its \`tokenFiles\` and the plugin module binds it around \`create\`; it cannot be passed as a JSON option.`,
    );
  }
  return value;
}

/**
 * The recommended spectral→semantic map: keyed by utility prefix, then a list of
 * `{ "<family>-<lo>...<hi>": "<token>" }` entries.
 *
 * The list-of-single-key-objects shape is not one anybody would choose from scratch — a
 * single object per prefix would do — but it is the `replacement` option's public shape,
 * and changing it is a major.
 *
 * Built fresh on each call rather than shared as a constant: `meta.defaultOptions` and the
 * destructuring fallback both hand it out, and a mutable default two rule instances share
 * is a bug waiting for someone to write it.
 */
function recommendedReplacement() {
  return {
    text: [
      { "green-400...600": "success-content" },
      { "emerald-400...600": "success-content" },
      { "blue-400...600": "info-content" },
      { "sky-400...600": "info-content" },
      { "yellow-400...500": "warning-content" },
      { "amber-400...500": "warning-content" },
      { "orange-400...500": "warning-content" },
      { "red-400...500": "danger-content" },
      { "rose-400...500": "danger-content" },
    ],
    bg: [
      { "green-100...200": "success-weak" },
      { "green-400...600": "success" },
      { "emerald-100...200": "success-weak" },
      { "emerald-400...600": "success" },
      { "blue-100...200": "info-weak" },
      { "blue-400...600": "info" },
      { "sky-100...200": "info-weak" },
      { "sky-400...600": "info" },
      { "yellow-100...200": "warning-weak" },
      { "yellow-400...500": "warning" },
      { "amber-100...200": "warning-weak" },
      { "amber-400...500": "warning" },
      { "orange-100...200": "warning-weak" },
      { "orange-400...500": "warning" },
      { "red-100...200": "danger-weak" },
      { "red-400...500": "danger" },
      { "rose-100...200": "danger-weak" },
      { "rose-400...500": "danger" },
    ],
  };
}

/** A palette name and its scale step: `red-500`, `slate-200`, `blue-950`. */
const PALETTE_STEP = /^(.+)-(\d+)$/;

/**
 * The spectral colour in a class, or `null`.
 *
 * @returns {{ prefix: string, color: string, family: string, scale: string | null } | null}
 *   `prefix` is what the author wrote before the colour — `divide-x`, not `divide` — because
 *   that is the text the message asks them to change. `scale` is `null` for a colour the
 *   palette spells without one, which today means `black` and `white`.
 */
function spectralIn(className, designSystem, colorPrefixes, colorNames, semantic, flagFixedColors) {
  const { base } = parseClass(className);

  // An arbitrary value is `no-raw-color`'s surface, and flagging it here would double-report
  // one character span from two rules with two different fixes. The bracket is the whole
  // test: variants have already been stripped, so a bracket left in the base is a value.
  if (!base || base.includes("[")) return null;

  const segments = base.split("-");

  // Longest colour name first, so `border-t-red-500` is `red-500` under `border-t` rather
  // than nothing at all. The split has to satisfy both halves at once — a name in the theme
  // and a colour-carrying utility in front of it — which is why this is a scan and not a
  // parse of a fixed prefix.
  for (let k = 1; k < segments.length; k++) {
    const color = segments.slice(k).join("-");
    if (!colorNames.has(color)) continue;
    const prefix = segments.slice(0, k).join("-");
    if (!startsWithColorPrefix(prefix, colorPrefixes)) continue;

    // A palette name is not a colour here when Tailwind turned the class into something
    // else — a theme defining `--shadow-red-500` makes `shadow-red-500` a box shadow.
    if (designSystem.resolves(base) && !designSystem.isColorClass(base)) return null;

    // A colour this project defined is a semantic token by construction, whatever it is
    // spelled like. The palette is what Tailwind brings, not what the token file declares.
    if (semantic.has(color)) return null;

    const step = PALETTE_STEP.exec(color);
    if (step) return { prefix, color, family: step[1], scale: step[2] };

    // `black` and `white` are palette values with the scale left off, and the same
    // violation — `text-white` on a themed surface is the case `*-content` tokens exist to
    // solve. They are also the noisiest line in the rule, hence the switch.
    return flagFixedColors ? { prefix, color, family: color, scale: null } : null;
  }

  return null;
}

/**
 * Does this text begin with a declared colour-carrying utility?
 *
 * The match has to land on a segment boundary, or `bordering-red-500` would pass on the
 * strength of `border`.
 */
function startsWithColorPrefix(prefix, colorPrefixes) {
  for (const candidate of colorPrefixes) {
    if (prefix === candidate || prefix.startsWith(`${candidate}-`)) return true;
  }
  return false;
}

/**
 * The semantic token the map names for this colour, or `null`.
 *
 * A key is `<family>-<step>` or `<family>-<lo>...<hi>`. A family with no entry — every
 * neutral, and `black` and `white` — is still caught; it just reports under the message that
 * names the token file instead of a token.
 */
function replacementFor(replacement, prefix, family, scale) {
  if (scale === null) return null;
  const entries = replacement?.[prefix];
  if (!Array.isArray(entries)) return null;

  const step = Number(scale);
  for (const entry of entries) {
    for (const [key, token] of Object.entries(entry)) {
      const dash = key.indexOf("-");
      if (dash === -1 || key.slice(0, dash) !== family) continue;
      const range = key.slice(dash + 1);
      const [low, high] = range.includes("...") ? range.split("...") : [range, range];
      if (step >= Number(low) && step <= Number(high)) return token;
    }
  }
  return null;
}

/** A source range as the report API wants it. */
function spanOf(context, [start, end]) {
  return {
    start: context.sourceCode.getLocFromIndex(start),
    end: context.sourceCode.getLocFromIndex(end),
  };
}
