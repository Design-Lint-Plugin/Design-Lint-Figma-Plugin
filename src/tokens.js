/**
 * The semantic token set — which colour names are this project's own.
 *
 * Tailwind keeps a project's tokens and its own stock palette in one `--color` namespace,
 * and to Tailwind `bg-primary` and `bg-red-500` are the same kind of class. Every rule that
 * asks "is this one of yours?" needs that split drawn somewhere: `no-spectral-color` to find
 * the palette, `token-constraints` to know which names it polices, `no-undefined-token` for
 * its typo candidates. It is drawn here.
 *
 * ## By subtraction, not by reading files
 *
 * Yours is whatever your namespace holds that a bare `@import "tailwindcss"` does not. The
 * question is put to Tailwind instead of being answered from which file a name came from,
 * and that is the whole difference. A scan of the token files' text misses every token
 * defined in a stylesheet those files import, so `no-spectral-color` would report them as
 * palette and `token-constraints` would skip them. Following the imports instead needs a line drawn at `node_modules`, because the
 * palette is itself a stylesheet there, and any such line misfiles a shared token package.
 * Subtraction needs neither: a token package counts as yours because it is not Tailwind's
 * palette, and the palette is excluded because it is exactly what is subtracted.
 *
 * It decides one case differently from a file scan, on purpose: redefining a palette name
 * — `--color-red-500: …` — does not make it yours. The name is still stock palette whatever
 * colour it now holds, and `bg-red-500` is still the class this linter steers people away
 * from.
 */

/**
 * @param {{ colorNames: Set<string> }} designSystem the project's policy view
 * @param {{ colorNames: Set<string> }} palette the policy view of a bare `@import "tailwindcss"`,
 *   built by the same engine — see `loadPalette` in `./load.js`
 * @returns {Set<string>}
 */
export function projectTokens(designSystem, palette) {
  return new Set([...designSystem.colorNames].filter((name) => !palette.colorNames.has(name)));
}

/**
 * An already-resolved set, in whatever iterable shape it arrived: a `Set` the plugin module
 * bound, or a JSON list a contract case wrote to vary the token set. A case must be able to
 * hand a token set over without inventing a stylesheet for it.
 *
 * @param {{ tokens?: Iterable<string> }} source
 * @returns {Set<string>}
 */
export function resolveTokenSet({ tokens } = {}) {
  return new Set(tokens ?? []);
}
