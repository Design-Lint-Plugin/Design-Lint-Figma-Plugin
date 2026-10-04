import { inClassPosition, sweepVisitors } from "../extract/index.js";
import { colorPrefixOf } from "../policy/class-list.js";
import { IGNORE_GLOBS_SCHEMA, ignoredFile, STORY_GLOBS } from "../policy/ignore.js";
import { classTokens } from "../policy/tokenize.js";
import { parseClass } from "../policy/variants.js";

/**
 * no-undefined-token — a colour class must resolve to CSS.
 *
 * The specification is `test/contracts/no-undefined-token.js`, whose cases the Oxlint adapter runs
 * against this object; `docs/rules/no-undefined-token.md` is the guide for the people using it.
 *
 * This is the only rule in the set that reports the **absence** of styling rather than the
 * wrong kind of it. `text-warning-foreground` is spelled like a token, reads like one in
 * review, and if `--color-warning-foreground` was never defined it generates no
 * declaration at all: Tailwind discards an unrecognised candidate silently, the element
 * inherits, and nobody notices until the one state that needed the emphasis ships without
 * it.
 *
 * ## Two gates, and both come from `/policy`
 *
 * A class is reported when it sits under a **derived** colour-carrying prefix and fails to
 * generate CSS. Neither half is a list anyone maintains: the prefix set is probed off the
 * design system, which is how `inset-ring-` and every per-side border family arrive, and
 * `resolves()` is Tailwind's own answer rather than a pattern that approximates it.
 *
 * Variants, the important modifier and the opacity modifier are stripped before the
 * question is asked, because all three decide *when* a declaration applies and none of them
 * decides *whether* one exists. Stripping is bracket-depth aware, so `bg-[image:var(--x)]`
 * is never split at its inner colon.
 *
 * ## Why it stays quiet where it is unsure
 *
 * `bias: false-negatives`, and the reason is the strength of the claim. Every other rule
 * here says "this class is forbidden", which a reader can verify by looking at it. This one
 * says "this class does nothing", which a reader cannot verify without running Tailwind, so
 * a false positive is not noise — it is the rule confidently asserting something false
 * about working code. Hence the arbitrary-value skip, the dynamic-token skip, and the one
 * way this rule reads less than the other token rules: only strings written where a class
 * list goes — a `className`, a class helper's arguments, `cva()` and `tv()` included. A
 * colour prefix is weak evidence on its own. `attributeName="stroke-opacity"`, a
 * `"shadow-color"` key and a test title mentioning `text-mono` all carry one, and in a real
 * codebase strings like these outnumbered real typos three to one. The cost is a class
 * string written anywhere else — a constant, an object map — which the contract declares
 * blind.
 *
 * Within a class position each word is judged on its own, rather than only strings made
 * entirely of classes: that test would switch the rule off for every class string holding
 * `group` or a project's own class, which is most of them.
 *
 * ## Silence is the one thing it must never do by accident
 *
 * Its whole output is an absence, and it is the gate for `token-constraints` — an undefined
 * token never reaches a constraint check, so a silent failure here quietly weakens two
 * rules. A missing design system is therefore a thrown error, never an early return: a rule
 * that reports nothing is indistinguishable from a codebase with no violations. It is bound
 * rather than passed as an option for the same reason — a consumer restating a severity
 * drops the factory's options, and must not drop the design system with them.
 */
export default {
  meta: {
    type: "problem",
    hasSuggestions: true,
    docs: {
      description: "A color class must resolve to CSS.",
    },
    messages: {
      undefinedColorToken:
        "{{className}} generates no CSS — {{token}} is not defined; check the spelling, or add --color-{{token}} to your token stylesheet",
      // The candidate has to be in the *text*: suggestions do not render in any CLI output
      // format and `meta.docs.url` is dead under Oxlint, so a hint that lives only in a
      // suggestion payload reaches nobody running the linter from a terminal.
      undefinedColorTokenWithCandidate:
        "{{className}} generates no CSS — {{token}} is not defined; check the spelling — did you mean {{candidates}}? — or add --color-{{token}} to your token stylesheet",
      useCandidate: "Replace {{className}} with {{candidate}}",
    },

    // The JSON half only. `designSystem` and `tokens` are resolved by `designLint()` from its
    // `tokenFiles` and bound around `create` at plugin-module load; a consumer cannot write
    // either by hand and should be told so rather than have one silently ignored.
    schema: [
      {
        type: "object",
        properties: {
          colorPrefixes: { type: "array", items: { type: "string" } },
          ignoreGlobs: IGNORE_GLOBS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],

    // The recommended policy. Every value is an array, which Oxlint replaces whole — the
    // deep merge that makes an object-valued default dangerous has nothing to reach into here.
    defaultOptions: [
      {
        ignoreGlobs: [...STORY_GLOBS],
      },
    ],
  },

  create(context) {
    const {
      designSystem,
      tokens,
      colorPrefixes = [],
      ignoreGlobs = STORY_GLOBS,
    } = context.options[0] ?? {};

    const resolved = requiredDesignSystem(designSystem);

    // The option *adds* to the derived set rather than replacing it — hand-maintaining that
    // set is the bug the derivation exists to avoid, and a Tailwind plugin's own prefix is
    // the one thing probing cannot see.
    const prefixes = new Set([...resolved.colorPrefixes, ...colorPrefixes]);

    // Candidates come from the semantic token set the same load step resolves from the
    // token files. Deliberately not the design system's full colour namespace: that holds
    // the spectral palette too, and answering a typo with `bg-red-50` would hand the author
    // a class `no-spectral-color` then forbids.
    const candidatesFor = candidateSource(tokens);

    if (ignoredFile(context.filename, ignoreGlobs)) return {};

    return sweepVisitors((source) => {
      // Where the string sits decides whether it is a class list; its words never do.
      if (!inClassPosition(source.node)) return;

      // Each word is judged on its own, whatever else the string holds. A class string that
      // mixes in `group` or a project's own `card` is still a class string, and the typo
      // beside them is still a typo.
      for (const token of classTokens(source)) {
        // Every token advances the cursor, reported or not, so a class written twice in one
        // string is located twice rather than resolving to its first occurrence both times.
        const range = token.range;

        // A class built around an interpolation is not a class this rule has seen, and it
        // cannot say "generates no CSS" about something it never read.
        if (token.dynamic) continue;

        const { base } = parseClass(token.text);

        // Everything inside brackets belongs to `no-raw-color`. `bg-[--color-brand]`
        // resolves to `var(--color-brand)` whether or not that property is ever defined, so
        // no static check can answer the question this rule asks.
        if (!base || base.includes("[")) continue;

        const colorClass = colorPrefixOf(base, prefixes);
        if (!colorClass) continue;
        if (resolved.resolves(base)) continue;

        const { prefix, token: name } = colorClass;
        const near = candidatesFor(name);
        const data = { className: token.text, token: name };
        const at = range ? { loc: spanOf(context, range) } : { node: source.node };

        if (near.length === 0) {
          context.report({ ...at, messageId: "undefinedColorToken", data });
          continue;
        }

        context.report({
          ...at,
          messageId: "undefinedColorTokenWithCandidate",
          data: { ...data, candidates: near.map((c) => `${prefix}-${c}`).join(" or ") },
          // In addition to the message, never instead of it. No candidate is destructive —
          // each replaces a class that does nothing today — so any of them may sit first,
          // and they are ordered by edit distance because that is the order a reader
          // expects. Offered only where the class was located in the source: a fix that
          // cannot point at the characters it replaces is not a fix.
          suggest: range
            ? near.map((candidate) => ({
                messageId: "useCandidate",
                data: { className: token.text, candidate: `${prefix}-${candidate}` },
                fix: (fixer) =>
                  fixer.replaceTextRange(range, token.text.replace(base, `${prefix}-${candidate}`)),
              }))
            : undefined,
        });
      }
    });
  },
};

/**
 * The resolved design system, or a thrown error.
 *
 * The one rule in the set that must fall over rather than fall silent. Its entire output is
 * an absence, so "the design system failed to load" and "this codebase is clean" produce
 * the same empty report and the same exit code — and it gates `token-constraints`, so the
 * silence costs coverage in two rules rather than one. A resolver built with
 * `.catch(() => null)` and an early return is exactly that failure, which is why this
 * throws instead.
 *
 * Binding closes the likelier route: a consumer writing `"design/no-undefined-token": "error"`
 * to bump a severity drops every option the factory supplied, but the design system is not
 * one of them. What reaches this check is a rule run outside the plugin.
 *
 * The shape of what arrives says which mistake it was. A husk — `{ colorPrefixes: {} }`
 * with every method gone — is what a resolved design system looks like after a trip through
 * JSON, which means it was passed as an option instead of bound.
 */
function requiredDesignSystem(designSystem) {
  if (typeof designSystem?.resolves !== "function" || !(designSystem.colorPrefixes instanceof Set)) {
    throw new Error(
      "no-undefined-token: `designSystem` is missing or is not a resolved design system — `designLint()` builds it from `tokenFiles` and the plugin module binds it around `create`; it cannot be passed as a JSON option. This rule reports an absence, so it refuses to run rather than report nothing.",
    );
  }
  return designSystem;
}

/** How far a name may stray from a token and still be a plausible typo of it. */
const MAX_DISTANCE = 2;

/** More than a handful of guesses is not a hint any more. */
const MAX_CANDIDATES = 2;

/**
 * The near-miss tokens for an undefined name, ordered by edit distance.
 *
 * `tokens` is optional in a way the design system is not: without it the rule still answers
 * its own question — this class generates no CSS — and only loses the hint. A rule that
 * refused to run without a spelling aid would trade a real diagnostic for a nicety.
 *
 * @param {Set<string> | undefined} tokens
 */
function candidateSource(tokens) {
  if (!(tokens instanceof Set) || tokens.size === 0) return () => [];

  return (name) =>
    [...tokens]
      // A short name has no room to be a near miss of anything: at two edits, `red` reaches
      // half the palette. The threshold scales with what is actually there to misspell.
      .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
      .filter(({ candidate, distance }) => distance <= Math.min(MAX_DISTANCE, candidate.length - 2))
      .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
      .slice(0, MAX_CANDIDATES)
      .map(({ candidate }) => candidate);
}

/**
 * Levenshtein distance, over two rows rather than a full matrix.
 *
 * Small enough to keep here: the alternative is a dependency on a package whose whole job
 * is fifteen lines, in a linter plugin whose install size a consumer inherits.
 */
function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(substitution, previous[j] + 1, current[j - 1] + 1);
    }
    previous = current;
  }

  return previous[b.length];
}

/** A source range as the report API wants it. */
function spanOf(context, [start, end]) {
  return {
    start: context.sourceCode.getLocFromIndex(start),
    end: context.sourceCode.getLocFromIndex(end),
  };
}
