import { sweepVisitors } from "../extract/index.js";
import { DEFAULT_IGNORED_VALUES, firstRawColor, wholeValueColor } from "../policy/color.js";
import { IGNORE_GLOBS_SCHEMA, ignoredFile, STORY_GLOBS } from "../policy/ignore.js";
import { colorProperty } from "../policy/properties.js";
import { classTokens } from "../policy/tokenize.js";
import { parseClass } from "../policy/variants.js";

/**
 * no-raw-color — a colour must never be written as a literal value.
 *
 * The specification is `test/contracts/no-raw-color.js`, whose cases the Oxlint adapter runs
 * against this object; `docs/rules/no-raw-color.md` is the guide for the people using it.
 *
 * The rule's subject is the **value**, wherever it is written, which is the mirror image of
 * `no-style-color`: that rule flags `color:` appearing in a `style` prop whatever it is set
 * to, and this one flags `#f00` whatever channel applies it. `style={{ color: "#f00" }}`
 * reports under both, and that is correct — the mechanism and the literal are independently
 * wrong, and fixing one leaves a real defect behind.
 *
 * ## Two enforcement models, because each covers the other's hole
 *
 * **Context-scoped.** Every channel that is known to carry a colour must resolve it through
 * a token: a colour attribute on any element or component, a colour-carrying `style`
 * property, the bracket of a colour-carrying Tailwind utility. Inside a delimited context
 * like these, a bare `red` is unambiguously a colour, which is the only way the 148 named
 * colours can be enforced at all — matching them as bare words anywhere would flag
 * `<div id="red" />` and `"animate-fadeToRed"`.
 *
 * **Value-scoped.** A string that is *entirely* an unambiguous literal — hex, or a colour
 * function — is caught wherever a constant is written, with no context to scope to. This is
 * what reaches `const SERIES = ["#ff0000"]`, which belongs to no attribute and no utility
 * prefix and would otherwise be the easiest place in the codebase to hide a colour.
 *
 * Neither alone is enough. The attribute and property lists are hand-maintained and a
 * free-standing constant has no context; the value-scoped half cannot see `red`. Both run
 * by default, and turning the backstop off is a documented option rather than a debate.
 *
 * ## Where each surface's strings come from
 *
 * The class surface uses `sweepVisitors` — every string literal and every static template
 * segment in the file. Breadth is the point: a `cn()` argument, a `cva()` variant map and a
 * `.ts` object-literal constants file are one string each, and an extractor that followed
 * only `className` would never see the last of them.
 *
 * The backstop does **not** use the sweep. It is driven by the positions where a value is
 * written down — a declarator's initialiser, an object property's value, an array element, a
 * returned or assigned value, a default, and either branch of a conditional or `??` — and
 * leaves function arguments out. An argument is where a hex-looking id turns up,
 * `querySelector("#add")`, so `setProperty("--brand", "#ff0000")` stays the contract's
 * declared blind spot by that shape rather than by a carve-out.
 *
 * ## Reporting granularity
 *
 * One report per offending *thing*: per class token, per JSX attribute, per style property,
 * per string literal. `"bg-[#f00] text-[#0f0]"` is two and `<rect fill="#f00" stroke="#0f0" />`
 * is two, while `boxShadow: "0 0 4px #f00, 0 0 8px #00f"` is one — one value, however many
 * literals it contains. A style property claims its own value so the backstop cannot report
 * it a second time; nothing else needs claiming, because a class string never parses as a
 * whole-string colour and a JSX attribute value is in none of the backstop's positions.
 *
 * ## Where its inputs come from
 *
 * `namedColors`, `checkStandaloneColorLiterals`, `ignoreValues` and `ignoreGlobs` are JSON a consumer
 * writes. `designSystem` and `tokens` are not JSON — they cross a JSON boundary as husks with every method gone — so
 * `designLint()` builds them once from its own `tokenFiles`, and the plugin module binds them
 * around `create` with `bindResolved` in [`src/plugin.js`](../plugin.js). Both are read from
 * `context.options[0]` and the rule cannot tell the difference.
 *
 * ## No suggestion yet, and why
 *
 * The contract asks for a suggestion where a literal is *exactly* equal to a defined
 * token's computed value — `#e5484d` → `var(--color-danger)` — offered on exact match only.
 * That needs the tokens' **values**, and the resolved inputs a rule is handed carry only
 * their *names*: `tokens` is a `Set` of names and the design-system policy view exposes
 * `colorPrefixes`, `colorNames`, `resolves` and `isColorClass`, none of which will answer
 * what `--color-danger` resolves to. Adding a name→value map is a change to
 * `src/policy/design-system.js`, which other rules share. So the suggestion is not offered
 * here rather than being offered on a guess, which the contract forbids outright: nothing
 * is worse than an automatic fix that silently changes a rendered colour. The message
 * carries the whole diagnostic in the meantime, which it must anyway — suggestions do not
 * render in any CLI output.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Colors must be written as tokens, never as literal values.",
    },
    messages: {
      rawColorValue:
        "raw color {{value}} in {{surface}} — colors must resolve through a var(--color-*) token. Add one to your token stylesheet if none fits.",
    },

    // The JSON half only. `designSystem` and `tokens` are bound around `create` rather than
    // written in a config, so they never reach the validator — and a consumer who tries to
    // write one by hand should be told it is not theirs to write.
    schema: [
      {
        type: "object",
        properties: {
          namedColors: { type: "boolean" },
          checkStandaloneColorLiterals: { type: "boolean" },
          ignoreValues: { type: "array", items: { type: "string" } },
          ignoreGlobs: IGNORE_GLOBS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],

    // The recommended policy. Every option here is a boolean or an array, both of which
    // Oxlint replaces whole — the deep merge that forces `no-spectral-color` to apply its
    // replacement map inside `create` instead would bite an object-valued option, and there
    // is none.
    defaultOptions: [
      {
        namedColors: true,
        checkStandaloneColorLiterals: true,
        ignoreValues: [...DEFAULT_IGNORED_VALUES],
        ignoreGlobs: [...STORY_GLOBS],
      },
    ],
  },

  create(context) {
    const {
      designSystem,
      tokens,
      namedColors = true,
      checkStandaloneColorLiterals = true,
      ignoreValues = DEFAULT_IGNORED_VALUES,
      ignoreGlobs = STORY_GLOBS,
    } = context.options[0] ?? {};

    // Silence is indistinguishable from a clean codebase, so a rule that cannot do its job
    // says so rather than reporting nothing. These two are the load step's output, not a
    // consumer's typing: their absence means the plugin bound nothing, and the shape they
    // arrive in says which mistake it was — an empty object is exactly what one looks like
    // after a trip through `JSON.stringify`.
    const colorPrefixes = requiredSet(designSystem?.colorPrefixes, "designSystem.colorPrefixes");
    requiredSet(tokens, "tokens");

    if (ignoredFile(context.filename, ignoreGlobs)) return {};

    const matching = { namedColors, ignoreValues };

    const report = (node, at, value, surface) => {
      if (insideSvgMask(node)) return;
      context.report({ ...at, messageId: "rawColorValue", data: { value, surface } });
    };

    /**
     * Style-property values this rule has already judged.
     *
     * A `style` prop's properties are `Property` nodes, which is one of the positions the
     * backstop watches, so without this `style={{ backgroundColor: "#f00" }}` would report
     * twice for one literal. The claim is made whether or not the property reports, because
     * "already judged" is the fact that matters — `backgroundImage: "url('/img.png#a')"` is
     * a value this rule has decided is clean, and the backstop must not reopen it.
     *
     * A JSX attribute is always visited before the object inside it, so the claim is always
     * in place before the backstop looks.
     */
    const claimed = new WeakSet();

    /** The value-scoped backstop, applied to one expression in a constant position. */
    const backstop = (node) => {
      if (!checkStandaloneColorLiterals) return;
      for (const leaf of writtenLiterals(node)) {
        const value = staticString(leaf);
        if (value === null) continue;

        const found = wholeValueColor(value, { ignoreValues });
        if (found) report(leaf, { node: leaf }, found, "a string literal");
      }
    };

    /** Every colour-carrying property of a `style` prop's object. */
    const styleProperties = (attribute) => {
      const object =
        attribute.value?.type === "JSXExpressionContainer" ? attribute.value.expression : null;
      if (object?.type !== "ObjectExpression") return;

      for (const property of object.properties) {
        // A `SpreadElement` carries no key to judge, and its value is not written here.
        if (property.type !== "Property") continue;

        const name = keyName(property);
        if (name === null || !colorProperty(name)) continue;
        claimed.add(property);

        // One report per written value, however many literals it holds: the author wrote one
        // value and has one edit to make. A conditional writes two, so each branch is its own.
        const leaves = writtenLiterals(property.value);
        for (const leaf of leaves) {
          const value = staticString(leaf);
          if (value === null) continue;
          const found = firstRawColor(value, matching);
          if (found) report(property, { node: leaves.length === 1 ? property : leaf }, found, "a style prop");
        }
      }
    };

    return {
      // The class surface. Context-free by design, so a class string is judged the same
      // whether it reaches an element, a `cva()` variant or a constants file.
      ...sweepVisitors((source) => {

        for (const token of classTokens(source)) {
          // Every token advances the cursor, reported or not, so a class written twice in
          // one string is located twice rather than at its first occurrence both times.
          const range = token.range;

          // `` `bg-[hsl(${hue},100%,50%)]` `` is a declared blind spot: the literal is not
          // written down, and the colour prefix against a hole belongs to the token rules.
          if (token.dynamic) continue;

          const value = arbitraryValue(token.text, colorPrefixes);
          if (value === null) continue;

          const found = firstRawColor(value, matching);
          if (!found) continue;

          const at = range ? { loc: spanOf(context, range) } : { node: source.node };
          report(source.node, at, found, "an arbitrary value");
        }
      }),

      JSXAttribute(node) {
        const name = attributeName(node.name);
        if (name === null) return;

        if (name === "style") {
          styleProperties(node);
          return;
        }

        // Colour attributes, in either spelling — `stopColor` and `stop-color` are the same
        // attribute and `normalizeProperty` inside `colorProperty` knows it. The name decides,
        // not the element: `<Badge color="red">` is as much a colour as `<rect fill="red">`.
        // Only the colour-*only* reading applies here: an attribute named `mask` or `src`
        // takes an address rather than a colour, and the shorthand half of that list is a
        // fact about `style` properties rather than about SVG.
        if (colorProperty(name) !== "color") return;

        // One report per written value, at the attribute: `fill="#f00" stroke="#0f0"` is two
        // spans, and the whole element is neither of them. A conditional writes two values,
        // so each branch is its own span.
        const leaves = writtenLiterals(attributeValue(node));
        for (const leaf of leaves) {
          const value = staticString(leaf);
          if (value === null) continue;
          const found = firstRawColor(value, matching);
          if (found) report(node, leaves.length === 1 ? { node } : { node: leaf }, found, "a color attribute");
        }
      },

      // The backstop's positions — everywhere a value is written down: a declaration, a
      // property, an element, a returned value, an assigned one, a default. A function
      // argument is not among them: `querySelector("#add")` passes an id that merely looks
      // like hex, and an argument is where that happens.
      VariableDeclarator(node) {
        backstop(node.init);
      },
      Property(node) {
        if (!claimed.has(node)) backstop(node.value);
      },
      ArrayExpression(node) {
        for (const element of node.elements ?? []) backstop(element);
      },
      ReturnStatement(node) {
        backstop(node.argument);
      },
      ArrowFunctionExpression(node) {
        if (node.expression) backstop(node.body);
      },
      AssignmentExpression(node) {
        backstop(node.right);
      },
      AssignmentPattern(node) {
        backstop(node.right);
      },
    };
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
      `no-raw-color: \`${name}\` is missing or is not a Set — designLint() builds it from its \`tokenFiles\` and the plugin module binds it around \`create\`; it cannot be passed as a JSON option.`,
    );
  }
  return value;
}

/**
 * Is this node inside an SVG `<mask>` element, its own attributes included?
 *
 * A mask's colours decide how much of what it masks shows through — white shows, black
 * hides — and nothing inside one is ever painted. Lowercase `mask` is SVG's own element; a
 * component named `Mask` is a component. A gradient that a mask only reaches through
 * `url(#…)` sits outside it and is still judged: following the reference is dataflow, which
 * no rule here does.
 */
function insideSvgMask(node) {
  for (let parent = node?.parent; parent; parent = parent.parent) {
    const name = parent.type === "JSXElement" ? parent.openingElement?.name : null;
    if (name?.type === "JSXIdentifier" && name.name === "mask") return true;
  }
  return false;
}

/**
 * The CSS inside a colour-carrying utility's arbitrary value, or `null`.
 *
 * Two gates, and both are needed. The **prefix** has to be one the design system generates
 * colours for, which is what keeps `w-[calc(100%-2rem)]` and `animate-[fadeToRed_2s]` out
 * without a list anybody maintains. The **value** then has to hold a colour, which is what
 * separates `text-[red]` from `text-[13px]` under the same prefix — `text-` carries a
 * colour and a font size, so the prefix alone decides nothing.
 *
 * Note what this does *not* use: `designSystem.isColorClass`. That asks Tailwind which
 * property the value lands in, and answers `false` for `shadow-[0_0_4px_#f00]`, whose
 * declaration is `--tw-shadow` rather than a colour property. The contract wants that one
 * caught, so the gate here is the prefix and the literal rather than the generated property.
 */
function arbitraryValue(className, colorPrefixes) {
  const { base } = parseClass(className);
  if (!base) return null;

  const open = base.indexOf("[");
  if (open === -1) return null;

  // An unclosed bracket is `className={"bg-[#" + hex + "]"}` — a declared blind spot, where
  // the literal is assembled at runtime and is not there to report.
  const close = base.lastIndexOf("]");
  if (close <= open) return null;

  const inner = base.slice(open + 1, close);

  // An arbitrary property, `[color:#f00]`, has no utility prefix: the property it names is
  // the context, so it is judged when that property carries a colour.
  if (open === 0 && close === base.length - 1) {
    const colon = inner.indexOf(":");
    if (colon <= 0 || !colorProperty(inner.slice(0, colon))) return null;
    return unescapeArbitrary(inner.slice(colon + 1));
  }

  const prefix = base.slice(0, open).replace(/-$/, "");
  if (!prefix || !startsWithPrefix(prefix, colorPrefixes)) return null;

  // A type hint, `text-[color:#f00]`, tells Tailwind which property the value is for; the
  // value is what follows it.
  return unescapeArbitrary(inner.replace(TYPE_HINT, ""));
}

const TYPE_HINT = /^[a-z-]+:/;

/**
 * A Tailwind arbitrary value, spelled as the CSS it stands for.
 *
 * Tailwind writes a space as `_`, since a class name cannot contain one, and `\_` for a
 * literal underscore. Undoing that here rather than teaching the colour matcher about it
 * keeps the matcher a matcher over CSS: `_` is Tailwind's grammar, not colour policy, and
 * `no-style-color` will ask the same matcher about values that never went through a class.
 */
function unescapeArbitrary(value) {
  return value.replace(/\\?_/g, (match) => (match === "\\_" ? "_" : " "));
}

/**
 * Does this text begin with one of the design system's colour-carrying utilities?
 *
 * The match has to land on a segment boundary, or `bordering-[#f00]` would pass on the
 * strength of `border`.
 */
function startsWithPrefix(text, prefixes) {
  for (const candidate of prefixes) {
    if (text === candidate || text.startsWith(`${candidate}-`)) return true;
  }
  return false;
}

/** The attribute's name, or `null` for `<svg:rect>`-style namespaced spellings. */
function attributeName(name) {
  return name?.type === "JSXIdentifier" ? name.name : null;
}

/** What an attribute is set to, through the expression container if there is one. */
function attributeValue(attribute) {
  const { value } = attribute;
  if (!value) return null;
  return value.type === "JSXExpressionContainer" ? value.expression : value;
}

/**
 * The property's name, however it was written: `color`, `{ color }`, `"color"`,
 * `['color']`. A computed key that is not a static string — `{ [k]: v }` — has no name to
 * judge and returns `null`.
 */
function keyName(property) {
  const { key } = property;
  if (property.computed) return staticString(key);
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return typeof key.value === "string" ? key.value : null;
  return null;
}

/**
 * A string this rule can read at lint time, in either spelling of a literal.
 *
 * The line every rule in this repo draws: the literal is present, or it is not. A template
 * with a hole in it is not a value anybody can check, which is what makes
 * `style={{ color: computeColor(theme) }}` a blind spot rather than an omission.
 */
function staticString(node) {
  if (node?.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? null;
  }
  return null;
}

/**
 * The expressions a value could turn out to be, when each one is written in place.
 *
 * `dark ? "#000000" : "#ffffff"` and `props.color ?? "#ff0000"` write their literals down as
 * plainly as `const c = "#ff0000"` does; only the choice between them is left to run time.
 * Both branches of a conditional and both sides of a logical expression are followed, as are
 * the TypeScript wrappers that change a value's type but not the value. Anything else is
 * returned as it is, for the caller to read or to find unreadable.
 */
function writtenLiterals(node) {
  switch (node?.type) {
    case "ConditionalExpression":
      return [...writtenLiterals(node.consequent), ...writtenLiterals(node.alternate)];
    case "LogicalExpression":
      return [...writtenLiterals(node.left), ...writtenLiterals(node.right)];
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return writtenLiterals(node.expression);
    default:
      return node ? [node] : [];
  }
}

/** A source range as the report API wants it. */
function spanOf(context, [start, end]) {
  return {
    start: context.sourceCode.getLocFromIndex(start),
    end: context.sourceCode.getLocFromIndex(end),
  };
}
