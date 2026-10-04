/**
 * Which CSS properties apply a colour.
 *
 * Two rules ask this question of the same set — `no-style-color` of a `style` prop's keys,
 * `no-raw-color` of the channels its context-scoped model watches — and the proof of
 * concept answered it once per rule, with a different answer each time. It is answered
 * here instead, so a property that is invisible to one rule is invisible to both, visibly.
 *
 * The colour-only half is **derived, not listed**: a property applies a colour outright if
 * it is `color`, if it ends in `Color`, or if it is an SVG paint. That covers
 * `borderInlineStartColor`, `WebkitTextFillColor` and `columnRuleColor` without anybody
 * having remembered them, and it keeps covering whatever CSS adds next — the same reason
 * `design-system.js` probes Tailwind for its colour prefixes rather than listing them.
 *
 * The shorthand half cannot be derived, because nothing in the name of `boxShadow` or
 * `filter` says a colour may be hiding in its value. That list is enumerated in the
 * `no-raw-color` contract and transcribed here, which is the one place a stale list could
 * hide. Both readings — style properties and SVG presentation attributes — come from this
 * module so the staleness is shared rather than duplicated.
 */

/**
 * Properties whose name contains "color" but which apply none: they describe how colour is
 * *handled*, not which colour to use. Checked before anything else, because
 * `forcedColorAdjust` would otherwise have to be spelled out in the derivation below.
 */
const NOT_COLOR = new Set([
  "colorScheme",
  "colorInterpolation",
  "colorInterpolationFilters",
  "colorRendering",
  "printColorAdjust",
  "forcedColorAdjust",
]);

/** SVG paints. Colour-only, and the only two that the `*Color` derivation cannot see. */
const PAINTS = new Set(["fill", "stroke"]);

/** `border`, and the ten ways CSS lets you name one side of it. */
const BORDER_SIDES = [
  "",
  "Top",
  "Right",
  "Bottom",
  "Left",
  "Block",
  "BlockStart",
  "BlockEnd",
  "Inline",
  "InlineStart",
  "InlineEnd",
];

/**
 * Properties that may carry a colour among other values. A colour is optional in every one
 * of them, which is why `no-style-color` flags them on the key alone by default and offers
 * value inspection as an option rather than the other way round.
 *
 * Masks are absent on purpose. A colour written in `mask-image` decides only how much of
 * the element shows through — by its alpha, or its luminance — and never paints: `white` in
 * a mask gradient means "opaque", not white.
 */
const SHORTHANDS = new Set([
  ...BORDER_SIDES.map((side) => `border${side}`),
  "background",
  "backgroundImage",
  "borderImage",
  "borderImageSource",
  "outline",
  "textDecoration",
  "textEmphasis",
  "columnRule",
  "boxShadow",
  "textShadow",
  "filter",
  "backdropFilter",
  "listStyle",
  "listStyleImage",
  "WebkitTextStroke",
  "caret",
]);

/** A CSS custom property — the sanctioned way to feed a runtime colour into the tokens. */
export function isCustomProperty(name) {
  return name.startsWith("--");
}

/**
 * JSX accepts a property in either spelling, and a rule that only knew one of them would
 * be evadable by writing the other. `-webkit-text-fill-color` and `WebkitTextFillColor`
 * arrive here as the same property; a custom property is returned untouched, since `--`
 * is not a word boundary to be capitalised away.
 */
export function normalizeProperty(name) {
  if (isCustomProperty(name)) return name;
  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * How a property applies colour, if it does.
 *
 * @param {string} name a CSS property in either spelling
 * @returns {"color" | "shorthand" | null} `"color"` for a property that exists to set a
 *   colour, `"shorthand"` for one that may carry a colour among other values, `null` for
 *   everything else — including custom properties, which are the escape hatch.
 */
export function colorProperty(name) {
  if (isCustomProperty(name)) return null;

  const property = normalizeProperty(name);
  if (NOT_COLOR.has(property)) return null;
  if (property === "color" || property.endsWith("Color") || PAINTS.has(property)) return "color";
  if (SHORTHANDS.has(property)) return "shorthand";
  return null;
}
