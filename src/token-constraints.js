import { sweepVisitors } from "../extract/index.js";
import { IGNORE_GLOBS_SCHEMA, ignoredFile, STORY_GLOBS } from "../policy/ignore.js";
import { classTokens } from "../policy/tokenize.js";
import { resolveTokenSet } from "../policy/tokens.js";
import { familyOfKey, inFamily, parseClass } from "../policy/variants.js";

/**
 * token-constraints — a semantic colour token may only be used where the design system says.
 *
 * The specification is `test/contracts/token-constraints.js`, whose cases the Oxlint adapter runs
 * against this object; `docs/rules/token-constraints.md` is the guide for the people using it.
 *
 * Every other colour rule asks *is this a token at all?*; this one asks *is it the right
 * token here?* — which is the only question in the plugin whose answer is written by
 * designers rather than derived from the codebase. So the rule is a mechanism and nothing
 * else: the contents of `allowed` and `denied` are policy and arrive through options, while
 * the *semantics* of a pattern, of a variant family and of the resolution chain live here
 * and in the contract, and are not configurable.
 *
 * Two gates stand in front of the policy, and together they are why a context-free sweep of
 * every string in the file is safe (`bias: false-positives`):
 *
 * 1. the class's utility root is one the design system says carries a colour, and
 * 2. what follows it is a name the design system declares as a `--color-*` token.
 *
 * A string that clears both is a colour class in this project's own vocabulary, wherever it
 * was written — a `cn()` argument, a `cva()` variant map, a `.ts` constants file. A string
 * that clears only the first is somebody else's diagnostic: `no-undefined-token` owns a
 * token-shaped name that resolves to nothing, `no-spectral-color` owns `bg-red-500` and the
 * dynamic prefix in `` `text-${tone}` ``, `no-raw-color` owns `bg-[#ff0000]`. This rule is
 * silent on all of them so that one mistake produces one report.
 */

/**
 * The recommended policy, the fallback for a consumer who writes
 * `"design/token-constraints": "error"` to bump a severity and wipes the factory's options
 * doing it. Landing here beats landing on nothing, which is what that override otherwise
 * costs: a rule with no policy reports nothing, at exit 0, while appearing enabled.
 *
 * It is applied as a **whole object** when no options are supplied, rather than through
 * `meta.defaultOptions`. Oxlint merges `defaultOptions` into a consumer's options *deeply* —
 * `allowed: { text: [] }` beside this default would come out as `{ text: [], border: [...],
 * "hover:": [...] }` — and that per-prefix merge is exactly what the contract forbids: an
 * allow list is only readable if it is complete in one place, and a prefix the default
 * constrained must be unconstrained the moment the replacement omits it. So the default is a
 * default for the *configuration*, not for each key inside it.
 *
 * These values are policy, not semantics. A project whose tokens are named differently
 * replaces them and gets a correct rule; nobody forks the mechanism to change a pattern.
 */
const RECOMMENDED = {
  allowed: {
    text: ["*foreground*", "*content*", "primary", "link*"],
    border: ["border*", "input", "ring"],
    "hover:": ["*-hover"],
  },
  denied: { "*": ["*-foreground", "*-content"] },
};

const STRING_LIST = { type: "array", items: { type: "string" } };
const POLICY_MAP = { type: "object", additionalProperties: STRING_LIST };

export default {
  meta: {
    type: "problem",
    hasSuggestions: true,
    docs: {
      description: "A semantic color token may only be used where the design system says it may.",
    },
    messages: {
      prefixNotAllowed:
        "{{className}} — {{colorPart}} is not allowed after {{prefix}}- ({{allowed}}){{suggestion}}",
      prefixDenied:
        "{{className}} — {{colorPart}} matches the forbidden pattern {{pattern}} for {{prefix}}- (token-constraints policy)",
      variantNotAllowed:
        "{{className}} — {{colorPart}} is not allowed for a {{family}} colour, written via {{variant}}: ({{allowed}}){{suggestion}}",
      variantDenied:
        "{{className}} — {{colorPart}} matches the forbidden pattern {{pattern}} for a {{family}} colour (token-constraints policy)",
      useToken: "Use {{candidate}}",
    },
    schema: [
      {
        type: "object",
        properties: {
          // The JSON-safe projection of `designSystemPolicy()`. Oxlint sends rule options to
          // a rule as JSON, so `colorPrefixes` reaches it as a list of roots rather than as
          // the `Set` the policy view holds — see `test/harness/options.js`.
          designSystem: {
            type: "object",
            properties: { colorPrefixes: STRING_LIST },
          },
          tokens: STRING_LIST,
          allowed: POLICY_MAP,
          denied: POLICY_MAP,
          ignoreGlobs: IGNORE_GLOBS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],
  },

  create(context) {
    // Two kinds of thing arrive in `options[0]`: the resolved inputs the plugin module binds
    // — `designSystem`, `tokens` — and the policy the consumer wrote. The recommended policy
    // stands in for the second when the consumer wrote none, which is not the same as
    // `options[0]` being absent: once inputs are bound it never is, and a fallback keyed on
    // it silently switched the whole policy off. What the consumer wrote still replaces the
    // recommended policy wholesale rather than merging into it — a per-prefix merge is the
    // thing Configuration forbids.
    //
    // `ignoreGlobs` is taken out before that test, because it is not policy: it says which
    // files to read, the same option with the same default as every other rule. Left in, a
    // consumer who wrote only `ignoreGlobs: []` to lint their stories would have switched the
    // recommended policy off with it.
    const {
      designSystem,
      tokens: tokenInput,
      ignoreGlobs = STORY_GLOBS,
      ...written
    } = context.options[0] ?? {};
    const options = Object.keys(written).length > 0 ? written : RECOMMENDED;

    // The two gates are the two inputs, and neither has a defensible default: they are what
    // the consumer's `tokenFiles` and Tailwind design system resolve to, and a rule never
    // reads a path. Missing either, every gate fails on every class and the rule reports
    // nothing while appearing enabled — the one failure mode this rule cannot afford, since a
    // rule that finds nothing looks exactly like a codebase with nothing to find.
    const prefixes = requiredPrefixes(designSystem);
    const tokens = requiredTokens(tokenInput);
    const policy = compilePolicy(options);

    if (ignoredFile(context.filename, ignoreGlobs)) return {};

    return sweepVisitors((source) => {
      for (const token of classTokens(source)) {
        // A hole falls inside this token, so there is no colour part to inspect and this
        // rule's second gate can never be reached. The declared blind spot.
        if (token.dynamic) continue;

        const violation = judge(token.text, { policy, prefixes, tokens, designSystem });
        if (violation) report(context, violation, token.range, source.node, tokens);
      }
    });
  },
};

/**
 * Judge one class, or decide it is not this rule's business.
 *
 * The decomposition is `/policy`'s and is shared with every rule that reads a class:
 * `variant:variant:[!]prefix-colorPart[!][/opacity]`, split on **top-level** colons so that
 * `bg-[image:var(--x)]` survives intact.
 *
 * There is one report per class, against the first failure in resolution order — the prefix
 * policy, then the variant policies left to right. Fixing it surfaces the second: one class,
 * one report, however many policies it breaks.
 */
function judge(className, { policy, prefixes, tokens, designSystem }) {
  const { variants, base, important, opacity } = parseClass(className);

  const split = splitColorClass(base, prefixes, tokens);
  if (!split) return null;

  // A token name is not a colour here when Tailwind turned the class into something else:
  // `shadow-card` is a box shadow in a theme that defines `--shadow-card` beside
  // `--color-card`. A class that resolves to nothing is still judged — an undefined token is
  // no evidence against a colour.
  if (designSystem.resolves(base) && !designSystem.isColorClass(base)) return null;

  const { prefix, colorPart } = split;
  const where = { className, prefix, colorPart, variants, important, opacity };

  return prefixVerdict(policy, where) ?? variantVerdict(policy, where);
}

/**
 * The prefix chain: `allowed[prefix] → denied[prefix] → denied["*"] → unconstrained`.
 *
 * It stops at the first key that is **present**, not at the first that is non-empty. That is
 * what makes `allowed: { text: [] }` a total ban and `denied: { bg: [] }` an opt-out from the
 * fallback, and it is why an allow list shields its prefix from `denied["*"]` — the fallback
 * exists to keep `-foreground` tokens off surfaces, and `text-` is precisely the family where
 * they belong.
 */
function prefixVerdict(policy, where) {
  const { allowed, denied } = policy;
  const { colorPart } = where;
  const key = policyKey(where.prefix, allowed, denied);

  if (Object.hasOwn(allowed, key)) {
    const patterns = allowed[key];
    if (patterns.some((pattern) => matches(pattern, colorPart))) return null;
    return { messageId: "prefixNotAllowed", patterns, where };
  }

  const list = Object.hasOwn(denied, key) ? denied[key] : denied["*"];
  if (!list) return null;

  const pattern = list.find((p) => matches(p, colorPart));
  return pattern === undefined ? null : { messageId: "prefixDenied", pattern, where };
}

/**
 * The key whose lists govern a root: the root's own, or `border` for one side of a border.
 *
 * `border-t-primary` is the same decision as `border-primary` made for one edge, so a policy
 * that constrains `border` constrains every side — otherwise the recommended policy bans
 * `border-primary` and waves `border-t-primary` through. A key written for the side itself,
 * in either list, still wins, which is how one edge gets a list of its own. The sides are
 * named rather than derived: "a longer root inherits a shorter one" would put `ring-offset`
 * under `ring`, which is a different colour on a different box.
 */
function policyKey(root, allowed, denied) {
  if (Object.hasOwn(allowed, root) || Object.hasOwn(denied, root)) return root;
  return BORDER_SIDE.test(root) ? "border" : root;
}

const BORDER_SIDE = /^border-(?:[trblxyse]|bs|be)$/;

/**
 * Then, independently of the prefix, every variant policy whose family the class joins.
 *
 * Families are additive: a class joining two of them must satisfy both, so a narrower key
 * beside a broader one only ever tightens it. A family is evaluated once per class however
 * many segments join it, and the segment reported is the first one that did — a developer
 * told a "hover colour" is constrained needs to see that `group-hover` is what connected
 * them.
 */
function variantVerdict(policy, where) {
  for (const { family, key, variant } of policy.familiesOf(where.variants)) {
    const at = { ...where, family, variant };

    if (Object.hasOwn(policy.allowed, key)) {
      const patterns = policy.allowed[key];
      if (patterns.some((pattern) => matches(pattern, where.colorPart))) continue;
      return { messageId: "variantNotAllowed", patterns, where: at };
    }

    const pattern = policy.denied[key].find((p) => matches(p, where.colorPart));
    if (pattern !== undefined) return { messageId: "variantDenied", pattern, where: at };
  }
  return null;
}

/**
 * Split a utility into the root that carries the colour and the name that follows it.
 *
 * The longest root wins — `border-t-muted-foreground` is `border-t`, not `border` — but a
 * root is only accepted when what follows it is a declared token, so a shorter root gets its
 * turn when the longer one leaves a name nobody declared. That second condition is also the
 * whole false-positive story: `bg-cover`, `border-2`, `text-sm` and `from-0%` all parse as
 * `root-something`, and `cover`, `2`, `sm` and `0%` are not tokens, so the rule stops.
 *
 * This is a candidate for `/policy` — `no-spectral-color` asks the same question of the same
 * prefix set — but it is deliberately not there yet: how the prefix set reaches a rule at all
 * is unsettled (see `test/harness/options.js`), and a shared helper standing on an interface
 * about to move is worse than one waiting for it.
 */
function splitColorClass(base, prefixes, tokens) {
  let best = null;

  for (const prefix of prefixes) {
    if (prefix.length + 1 >= base.length) continue;
    if (!base.startsWith(prefix) || base[prefix.length] !== "-") continue;

    const colorPart = base.slice(prefix.length + 1);
    if (!tokens.has(colorPart)) continue;
    if (best === null || prefix.length > best.prefix.length) best = { prefix, colorPart };
  }

  return best;
}

/**
 * A pattern is matched against the colour part alone — the prefix, the variants, the `!` and
 * the `/opacity` have all been stripped. Four shapes, and `*` is the degenerate
 * contains-empty-string case rather than a special case: in `denied` it bans every token for
 * its prefix, in `allowed` it permits every one. `""` is an exact match against the empty
 * string and so matches nothing.
 */
function matches(pattern, value) {
  const open = pattern.startsWith("*");
  const close = pattern.endsWith("*");
  if (open && close) return value.includes(pattern.slice(1, -1));
  if (open) return value.endsWith(pattern.slice(1));
  if (close) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

/**
 * Read the policy out of options, and refuse a configuration whose meaning is a guess.
 *
 * Both refusals throw when the rule is created, which is where the configuration actually
 * arrives; the contract describes them as such. A key in both lists is either redundant or contradictory —
 * an allow list already denies everything not on it — and silently discarding one of the two
 * is the worst of the three available answers.
 */
function compilePolicy({ allowed = {}, denied = {} }) {
  const both = Object.keys(allowed).filter((key) => Object.hasOwn(denied, key));
  if (both.length) {
    throw new Error(
      `token-constraints: ${both.map((k) => `\`${k}\``).join(", ")} appears in both \`allowed\` and \`denied\`. An allow list already denies everything not on it, so a deny list beside it is redundant or contradictory; keep one.`,
    );
  }

  if (Object.hasOwn(allowed, "*")) {
    throw new Error(
      'token-constraints: `"*"` is the fallback for prefixes with no policy of their own and is valid in `denied` only. There is no allow-list fallback: an allow list says what one prefix may name, and a single list cannot say anything true about all of them.',
    );
  }

  // A key ending in `:` is a variant policy, and the mechanism is general: `hover:` is not
  // special-cased, so a `"focus:"` key works with no new code.
  const keys = [...Object.keys(allowed), ...Object.keys(denied)].filter((key) => key.endsWith(":"));

  return {
    allowed,
    denied,

    /**
     * The variant policies this class's segments join, in the order the segments were
     * written — which is the order the contract reports failures in.
     */
    familiesOf(variants) {
      const joined = [];
      for (const key of keys) {
        const family = familyOfKey(key);
        const index = variants.findIndex((segment) => inFamily(segment, family));
        if (index !== -1) joined.push({ key, family, variant: variants[index], index });
      }
      return joined.sort((a, b) => a.index - b.index);
    },
  };
}

/**
 * The semantic token set — the `--color-*` names the consumer's `tokenFiles` declare.
 *
 * It arrives as a `Set`, bound by the plugin module, because it is a resolved input rather
 * than something a consumer types. A list is accepted too: a contract fixture that varies
 * the token set per case writes JSON, and that is the one shape a consumer could hand it.
 */
function requiredTokens(tokens) {
  if (!(tokens instanceof Set) && !Array.isArray(tokens)) {
    throw new Error(
      "token-constraints: `tokens` is required — the semantic token names the consumer's `tokenFiles` resolve to. Without them the rule recognises no token and would report nothing.",
    );
  }
  return resolveTokenSet({ tokens });
}

/**
 * The colour-prefix set, which is derived from the resolved Tailwind design system and never
 * hand-maintained — a hand-written list is a permanent source of silent holes. The obvious
 * seventeen names omit every per-side border family, `inset-ring`, `inset-shadow` and
 * `text-shadow`.
 */
function requiredPrefixes(designSystem) {
  const prefixes = designSystem?.colorPrefixes;
  const list = prefixes instanceof Set ? [...prefixes] : prefixes;

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      "token-constraints: `designSystem.colorPrefixes` is required — the utility roots the resolved Tailwind design system says carry a colour. Without them the rule recognises no colour class and would report nothing.",
    );
  }
  return list;
}

/**
 * Report at the class, not at the string that carries it: `"text-muted bg-warning-foreground"`
 * is two violations in one literal, and pointing twice at the whole literal would hide which
 * half is wrong. The span is found by walking the node's own source text, and a token that
 * cannot be located there — an escape sequence the cooked value does not spell the same way —
 * falls back to the node rather than guessing a range.
 */
function report(context, violation, range, node, tokens) {
  const { messageId, where } = violation;
  const at = range ? range[0] : null;
  const suggestions = at === null ? [] : candidates(violation, tokens);
  const patterns = violation.patterns ?? [];

  context.report({
    node: range ? { range } : node,
    messageId,
    data: {
      className: where.className,
      colorPart: where.colorPart,
      prefix: where.prefix,
      variant: where.variant ?? "",
      family: where.family ?? "",
      pattern: violation.pattern ?? "",
      // An empty allow list is a total ban, and "(allowed: )" reads like a rendering bug.
      allowed: patterns.length ? `allowed: ${patterns.join(", ")}` : "nothing is allowed",
      suggestion: suggestions.length ? ` — try ${suggestions.map((s) => s.utility).join(", ")}` : "",
    },
    suggest: suggestions.map((suggestion) => ({
      messageId: "useToken",
      data: { candidate: suggestion.utility },
      fix: (fixer) => fixer.replaceTextRange(colorPartRange(where, at), suggestion.token),
    })),
  });
}

/**
 * A failing allow list names what *is* allowed, and a `*-suffix` pattern names it precisely
 * enough to build: `primary` under `*-hover` suggests `primary-hover`. A candidate is offered
 * only if the design system declares it — otherwise the suggestion is a guess that will not
 * compile, and `no-undefined-token` next door would report the result.
 *
 * Only the endsWith shape yields one. `*foreground*` and `link*` constrain a name without
 * saying what to append, and inventing an answer from them would be a worse guess than none.
 */
function candidates(violation, tokens) {
  return (violation.patterns ?? [])
    .filter((pattern) => pattern.startsWith("*") && !pattern.endsWith("*") && pattern.length > 1)
    .map((pattern) => violation.where.colorPart + pattern.slice(1))
    .filter((token) => tokens.has(token))
    .map((token) => ({ token, utility: `${violation.where.prefix}-${token}` }));
}

/**
 * Where the colour part sits inside the class, so a suggestion replaces the token and leaves
 * the variants, the `!` and the `/opacity` exactly as they were written.
 */
function colorPartRange(where, at) {
  const variants = where.variants.reduce((n, variant) => n + variant.length + 1, 0);
  const important = where.className[variants] === "!" ? 1 : 0;
  const start = at + variants + important + where.prefix.length + 1;
  return [start, start + where.colorPart.length];
}
