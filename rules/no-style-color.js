import { firstRawColor } from "../policy/color.js";
import { IGNORE_GLOBS_SCHEMA, ignoredFile, STORY_GLOBS } from "../policy/ignore.js";
import { colorProperty } from "../policy/properties.js";

/**
 * no-style-color — colour must not be applied through the React `style` prop.
 *
 * The specification is `test/contracts/no-style-color.js`, whose cases the Oxlint adapter runs
 * against this object; `docs/rules/no-style-color.md` is the guide for the people using it.
 *
 * The rule's subject is the **property**, never the value: `color: "red"` and
 * `color: computeColor()` are the same violation, because it is the inline channel that
 * defeats the token system, not the literal inside it. That is what makes this the
 * smallest of the nine — it needs no token set, no design-system resolution and no
 * required option, since which properties apply a colour is a fact about CSS rather than
 * about any project.
 *
 * Everything it declines to follow — `style={s}`, `{...spread}`, `element.style.color` —
 * is a declared blind spot in the contract rather than an oversight, and each is asserted
 * there as a case that must keep going unreported.
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Color must not be applied through the React `style` prop.",
    },
    messages: {
      colorInStyleProp:
        "{{property}} in style= — inline color bypasses the token system; use a color class, or set a --color-* custom property instead",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowTokenValues: { type: "boolean" },
          shorthandProperties: { enum: ["key", "value"] },
          ignoreGlobs: IGNORE_GLOBS_SCHEMA,
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      { allowTokenValues: false, shorthandProperties: "key", ignoreGlobs: [...STORY_GLOBS] },
    ],
  },

  create(context) {
    const {
      allowTokenValues = false,
      shorthandProperties = "key",
      ignoreGlobs = STORY_GLOBS,
    } = context.options[0] ?? {};

    if (ignoredFile(context.filename, ignoreGlobs)) return {};

    return {
      JSXAttribute(node) {
        if (node.name?.name !== "style") return;
        if (node.value?.type !== "JSXExpressionContainer") return;

        for (const object of writtenObjects(node.value.expression)) {
          styleObject(object);
        }
      },
    };

    /** Every colour-carrying property of one object literal a `style` prop can be. */
    function styleObject(object) {
      for (const property of object.properties) {
        // A `SpreadElement` carries no key to judge — the indirect-value blind spot.
        if (property.type !== "Property") continue;

        const name = keyName(property);
        const kind = colorProperty(name === null ? "" : name);
        if (name === null || !kind) continue;
        if (allowTokenValues && isTokenReference(property.value)) continue;
        if (kind === "shorthand" && shorthandProperties === "value" && !carriesColor(property.value)) {
          continue;
        }

        context.report({
          node: property,
          messageId: "colorInStyleProp",
          data: { property: name },
        });
      }
    }
  },
};

/**
 * The object literals a `style` value could turn out to be, when each one is written in place.
 *
 * `{ … } as React.CSSProperties` is how TypeScript code spells a style object that carries a
 * custom property, and `cond ? { … } : undefined` writes its object down as plainly as a bare
 * literal does; only the choice is left to run time. Both branches of a conditional and both
 * sides of a logical expression are followed, as are the TypeScript wrappers that change a
 * value's type but not the value. Anything that is not an object literal is dropped.
 */
function writtenObjects(node) {
  switch (node?.type) {
    case "ObjectExpression":
      return [node];
    case "ConditionalExpression":
      return [...writtenObjects(node.consequent), ...writtenObjects(node.alternate)];
    case "LogicalExpression":
      return [...writtenObjects(node.left), ...writtenObjects(node.right)];
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ParenthesizedExpression":
      return writtenObjects(node.expression);
    default:
      return [];
  }
}

/**
 * The property's name, however it was written: `color`, `{ color }`, `"color"`,
 * `['color']`. A computed key that is not a static string — `{ [k]: v }` — has no name to
 * report and returns `null`.
 */
function keyName(property) {
  const { key } = property;
  if (property.computed) return staticString(key);
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return typeof key.value === "string" ? key.value : null;
  return null;
}

/** A string this rule can read at lint time, in either spelling of a literal. */
function staticString(node) {
  if (node?.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
  return null;
}

/**
 * Under `shorthandProperties: "value"`, a shorthand reports only when its value can be seen
 * to carry a colour. The matcher is `no-raw-color`'s — the same 148 names and the same
 * function heads — because "is there a colour in this string" is one question, and answering
 * it twice is how the two rules would come to disagree about `border: "1px solid red"`.
 *
 * A value this rule cannot read is *not* a colour here. That is the whole bargain of the
 * option: `boxShadow: shadowVar` goes unreported, which the contract states outright, and a
 * project that would rather not miss it stays on the default.
 */
function carriesColor(node) {
  const value = staticString(node);
  return value !== null && firstRawColor(value) !== null;
}

/**
 * `var(--color-primary)` — a token, and still a violation by default: it cannot carry a
 * variant and it still beats every class in the cascade. `allowTokenValues` is for a
 * project that has weighed that and disagrees.
 */
function isTokenReference(node) {
  const value = staticString(node);
  return value !== null && /var\(\s*--/.test(value);
}
