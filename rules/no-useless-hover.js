import { classSourcesOfElement } from "../extract/index.js";
import { IGNORE_GLOBS_SCHEMA, ignoredFile, STORY_GLOBS } from "../policy/ignore.js";
import { classTokens } from "../policy/tokenize.js";
import { splitVariants, stripGroupName } from "../policy/variants.js";

/**
 * no-useless-hover — `hover:` styling must not be applied to an element the user cannot
 * interact with.
 *
 * The specification is `test/contracts/no-useless-hover.js`, whose cases the Oxlint adapter runs
 * against this object; `docs/rules/no-useless-hover.md` is the guide for the people using it.
 *
 * A `hover:` variant is an affordance: it says "this responds to you" before the click.
 * Spending it on a `<div>` that does nothing is a promise the design system cannot see at
 * review time, and it devalues the signal everywhere else. So the rule is
 * **context-dependent** — the same class is correct on a `<button>` and wrong on a `<span>`
 * — which is why it reads `classSourcesOfElement` rather than the broad sweep the token
 * rules use. Only `className` is inspected, so `title="hover: to preview"` is never even
 * parsed as a variant.
 *
 * ## Two predicates, and why neither is the other
 *
 * `/policy`'s {@link inFamily} answers *which token may a hover-triggered colour name*, so
 * `group-hover` and `peer-hover` join the `hover` family there: which element is hovered is
 * irrelevant to that question. This rule asks the opposite question — *does this element
 * promise it responds to the pointer?* — so it reports the **self-hover** subset only:
 * `hover`, `not-hover`, and the arbitrary spelling `[&:hover]`. `group-hover:` and
 * `peer-hover:` name a different element as the target, which is exactly why they are the
 * repair this rule recommends rather than a second offence. Neither set contains the other,
 * so the family predicate stays in `/policy` unchanged and this one layers on top.
 *
 * ## Reported only where non-interactivity is a fact
 *
 * The tag list below is closed and is a fact about HTML, not about any codebase, so it
 * fails in neither direction. A capitalized component is the opposite: its interactivity
 * lives in another file, behind `asChild`, behind a `Slot`. An allow-list of "known
 * interactive components" would silently miss every component not yet on it, so by default
 * this rule says nothing about them — the contract's largest declared blind spot, opened
 * back up per project through `nonInteractiveComponents`.
 *
 * The same asymmetry drives the ancestor walk. An element is exempt when any lexically
 * enclosing JSX element is interactive, because the pointer is over that element too — and
 * "interactive" here means *not provably non-interactive*, the negation of the very
 * predicate that decides whether to report. One predicate, used in both directions: a
 * `<span>` ancestor with nothing on it keeps the walk going, while a `<Card>`, a `<form>`,
 * or a `<div {...props}>` stops it. `bias: false-negatives` settles every case in between.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "`hover:` styling must not be applied to an element the user cannot interact with.",
    },
    messages: {
      hoverOnNonInteractive:
        "{{token}} on non-interactive <{{tag}}> — hover feedback promises an interaction this element does not offer; move it to the interactive element, or use group-hover: / peer-hover:",
    },
    schema: [
      {
        type: "object",
        properties: {
          interactiveElements: { type: "array", items: { type: "string" } },
          nonInteractiveComponents: { type: "array", items: { type: "string" } },
          ignoreGlobs: IGNORE_GLOBS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],

    // Every option is a list, which Oxlint's deep `defaultOptions` merge replaces whole
    // rather than unioning — so the recommended policy is safe to carry here, and a consumer
    // who wipes the factory's options by writing `"design/no-useless-hover": "error"` lands
    // on it rather than on nothing. The same values are the destructuring defaults in
    // `create`, because `RuleTester` does not apply `defaultOptions`.
    defaultOptions: [
      {
        interactiveElements: ["tr", "td", "th"],
        nonInteractiveComponents: [],
        ignoreGlobs: [...STORY_GLOBS],
      },
    ],
  },

  create(context) {
    const {
      interactiveElements = ["tr", "td", "th"],
      nonInteractiveComponents = [],
      ignoreGlobs = STORY_GLOBS,
    } = context.options[0] ?? {};

    // No option is required — the closed tag list is mechanism and ships with the rule — so
    // there is no configuration under which this rule silently reports nothing. What it
    // refuses is a configuration whose meaning would be a guess: a list that is not a list.
    const policy = {
      interactiveElements: requiredList(interactiveElements, "interactiveElements"),
      // `interactiveElements` wins where a name is on both lists: silence is the tie-break
      // under `bias: false-negatives`.
      nonInteractiveComponents: requiredList(nonInteractiveComponents, "nonInteractiveComponents"),
    };

    if (ignoredFile(context.filename, ignoreGlobs)) return {};

    return {
      JSXElement(node) {
        const opening = node.openingElement;
        if (!provablyNonInteractive(opening, policy)) return;
        if (insideInteractiveElement(node, policy)) return;

        const offence = firstSelfHoverClass(context, opening);
        if (!offence) return;

        // One report per element, not per offending class. The element is the defect and
        // the classes are symptoms of it: three `hover:` utilities on one `<div>` are one
        // mistake with one fix.
        context.report({
          node: offence.at ?? offence.node,
          messageId: "hoverOnNonInteractive",
          data: { token: offence.token, tag: elementName(opening.name) },
        });
      },
    };
  },
};

/**
 * The elements that are never interactive by virtue of their tag.
 *
 * Closed by design, which is what makes the rule's promise complete rather than
 * aspirational: a tag outside it is never reported. `a`, `button`, `input`, `select`,
 * `textarea`, `option`, `label`, `summary`, `details`, `form`, `dialog`, `iframe`, `video`,
 * `canvas` and every custom element are absent deliberately.
 */
const NON_INTERACTIVE_TAGS = new Set([
  // Flow / sectioning
  "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "hgroup", "section", "article",
  "aside", "header", "footer", "main", "nav", "figure", "figcaption", "blockquote", "address",
  // Lists
  "ul", "ol", "li", "dl", "dt", "dd",
  // Inline / phrasing
  "em", "strong", "b", "i", "u", "s", "small", "mark", "sub", "sup", "code", "kbd", "samp",
  "var", "time", "abbr", "cite", "q", "pre", "br", "wbr",
  // Media / graphics
  "img", "picture", "svg", "path", "circle", "rect", "g", "hr",
  // Tables
  "table", "thead", "tbody", "tfoot", "caption", "colgroup", "col", "tr", "td", "th",
]);

/**
 * A React event handler, matched by shape rather than by name. `on[A-Z]…` covers pointer,
 * keyboard, focus and drag handlers alike, so a handler nobody thought of when this list
 * was written still counts. A list of names is a list of holes: four names that seem
 * enough leave `onMouseEnter` and `onFocus` out.
 */
const EVENT_HANDLER = /^on[A-Z]/;

/**
 * Attributes that make an element a pointer target regardless of its tag.
 *
 * `role` counts whatever its value: a dynamic `role={computedRole}` cannot be proved *not*
 * to be an interactive role, and `bias: false-negatives` resolves that in favour of
 * silence. `to` is there for the router-link idiom, which is `href` under another name.
 */
const INTERACTIVE_ATTRIBUTES = new Set([
  "role",
  "href",
  "to",
  "tabIndex",
  "contentEditable",
  "draggable",
]);

/**
 * Attributes that hand the tag over to something chosen at runtime. An element written as a
 * `<div>` that renders as a `<button>` is not the tag it is written as, and nothing at this
 * call site says which one it becomes.
 */
const POLYMORPHIC_ATTRIBUTES = new Set(["asChild", "as", "component"]);

/**
 * Can this element be *proved* to offer no interaction?
 *
 * Proof, not suspicion — every unknown answers `false`. That is what lets one predicate
 * serve both directions: it decides whether to report an element, and its negation decides
 * whether an ancestor exempts its descendants.
 */
function provablyNonInteractive(opening, policy) {
  const name = elementName(opening.name);
  if (name === null) return false;

  // A project may declare a tag interactive despite its tag — `<tr>` carrying a row-level
  // highlight is the near-universal case — and it wins over every other list.
  if (policy.interactiveElements.has(name)) return false;

  const declared = NON_INTERACTIVE_TAGS.has(name) || policy.nonInteractiveComponents.has(name);
  if (!declared) return false;

  return !carriesInteractivity(opening);
}

/** Does anything written on this element make it a target for the pointer? */
function carriesInteractivity(opening) {
  for (const attribute of opening.attributes ?? []) {
    // A spread may well be delivering `onClick`, and unlike a missing `role` there is no
    // cheap way for the author to prove otherwise. The declared blind spot.
    if (attribute.type !== "JSXAttribute") return true;

    const name = attribute.name?.type === "JSXIdentifier" ? attribute.name.name : null;
    if (name === null) continue;

    if (EVENT_HANDLER.test(name)) return true;
    if (INTERACTIVE_ATTRIBUTES.has(name)) return true;
    if (POLYMORPHIC_ATTRIBUTES.has(name)) return true;
  }
  return false;
}

/**
 * Is some lexically enclosing JSX element interactive?
 *
 * When one is, the pointer is over it too and the hover styling has a real target. The walk
 * is upward through `parent` and passes straight through the non-JSX nodes in between — a
 * `.map()` callback, an attribute container — because an element written inside one is
 * still lexically inside the enclosing element. It ends at the top of the file, which is
 * also where "the same expression" ends: a wrapper component's `<div>` has no JSX ancestor
 * at all, which is the contract's one accepted false positive.
 */
function insideInteractiveElement(node, policy) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type !== "JSXElement") continue;
    if (!provablyNonInteractive(parent.openingElement, policy)) return true;
  }
  return false;
}

/**
 * The first class on this element that conditions its appearance on hovering **it**, with
 * the span it occupies in the source.
 *
 * @returns {{ token: string, at: { range: [number, number] } | null, node: object } | null}
 */
function firstSelfHoverClass(context, opening) {
  for (const source of classSourcesOfElement(opening)) {
    for (const token of classTokens(source)) {
      // A class with an interpolation in it is never judged, by this rule or any other: what
      // it becomes is unknowable, and every rule draws that line in the same place.
      if (token.dynamic) continue;
      const text = token.text;
      if (!selfHoverVariant(text)) continue;

      return {
        token: text,
        // Report at the class, not at the string that carries it or the element that holds
        // it. A token the tokenizer could not place — an escape sequence the cooked value
        // spells differently — has no range, and falls back to the node.
        at: token.range ? { range: token.range } : null,
        node: source.node,
      };
    }
  }
  return null;
}

/**
 * The variant segment that makes this class depend on hovering the element itself, or
 * `null`.
 *
 * Matched **per segment**, never as a substring: a substring match finds `hover:` inside
 * `group-hover:`, `peer-hover:` and `[@media(hover:hover)]:` too. A stack is tested segment
 * by segment, so a `hover` anywhere in
 * `dark:md:hover:` reports and `supports-[hover:hover]:` does not.
 */
function selfHoverVariant(className) {
  const { variants } = splitVariants(className);

  for (const segment of variants) {
    // Tailwind accepts `!` in either position, so `!hover:bg-primary` decorates the variant
    // rather than the utility and the marker has to come off before the comparison.
    const marked = segment.startsWith("!") ? segment.slice(1) : segment;
    const name = stripGroupName(marked);

    // Variants apply left to right, so once one moves the target to other elements —
    // `*:`, `**:`, `[&_a]:` — a later `hover` is about hovering *them*. `*:hover:bg-muted`
    // styles each child as the pointer crosses it, and every child is its own target.
    if (retargets(marked)) return null;

    // `not-hover:` is a rule-local addition, outside the shared family predicate and
    // correctly so — requiring a `-hover` *token* for the un-hovered state reads backwards.
    // But that argument is about token naming. Conditioning the element's appearance on the
    // pointer promises the affordance either way.
    if (name === "hover" || name === "not-hover") return segment;

    if (arbitrarySelfHover(marked)) return segment;
  }
  return null;
}

/**
 * `[&:hover]:` — the arbitrary-variant spelling of the same assertion, and a rule-local
 * addition rather than family membership.
 *
 * It must not be an escape hatch from a rule whose entire subject is that assertion. The
 * test is that the selector targets `&` itself: `[@media(hover:hover)]` is a device
 * capability rather than an element state and never starts with `&`, and `[&_a:hover]`
 * hovers a descendant, so the `:hover` has to sit in the compound selector attached to `&`
 * — before any combinator, `_` included, since that is how Tailwind spells a space.
 */
function arbitrarySelfHover(segment) {
  if (!segment.startsWith("[") || !segment.endsWith("]")) return false;
  const selector = segment.slice(1, -1);
  if (!selector.startsWith("&")) return false;
  return /:hover\b/.test(selector.split(/[\s_>+~]/, 1)[0]);
}

/**
 * Does this variant move the styling off the element onto others?
 *
 * `*` and `**` select children and descendants. An arbitrary variant does when its selector
 * continues past `&` through a combinator — `[&_a]`, `[&>li]`, `[&+p]` — rather than
 * compounding onto `&` itself (`[&:focus]`) or placing it under an ancestor (`[.dark_&]`).
 * A combinator inside a pseudo-class argument (`[&:nth-child(2n_+_1)]`) also answers yes,
 * which errs toward silence.
 */
function retargets(segment) {
  if (segment === "*" || segment === "**") return true;
  if (!segment.startsWith("[") || !segment.endsWith("]")) return false;
  const selector = segment.slice(1, -1);
  const self = selector.indexOf("&");
  return self !== -1 && /[\s_>+~]/.test(selector.slice(self + 1));
}

/** The tag as it was written: `div`, `Card`, `Dialog.Trigger`, `svg:rect`. */
function elementName(node) {
  if (!node) return null;
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXMemberExpression") {
    const object = elementName(node.object);
    const property = elementName(node.property);
    return object === null || property === null ? null : `${object}.${property}`;
  }
  if (node.type === "JSXNamespacedName") return `${node.namespace.name}:${node.name.name}`;
  return null;
}

/**
 * A name list, as a `Set`.
 *
 * Both options are JSON a consumer writes, so they survive the boundary intact and nothing
 * here has to be bound around `create`. What does not survive is a typo: a string where a
 * list belongs would iterate character by character and quietly exempt `t`, `r` and nothing
 * else, so it throws instead.
 */
function requiredList(value, name) {
  if (!Array.isArray(value)) {
    throw new Error(
      `no-useless-hover: \`${name}\` must be an array of element or component names, and was ${typeof value}.`,
    );
  }
  return new Set(value);
}
