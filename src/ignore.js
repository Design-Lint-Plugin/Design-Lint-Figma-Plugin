/**
 * `ignoreGlobs` — the files a rule declines to look at.
 *
 * Every rule carries this option, under this one name, with the one default below and the
 * same reasoning: a Storybook story demonstrates colour rather than shipping it. It is one
 * question asked nine times, so it is answered once here. The contracts once spelled it
 * three ways — `ignoreGlobs`, `exclude`, and a preset `overrides` glob nothing emitted — and
 * a story file was skipped by five rules and reported by four.
 *
 * A glob is matched against the path the linter reports — whatever Oxlint puts in
 * `context.filename`, which is normally absolute. That is why `**\/` has to mean "any number
 * of leading segments, including none": `**\/*.stories.tsx` must match both
 * `/repo/src/Button.stories.tsx` and a bare `Button.stories.tsx`.
 *
 * Only the glob syntax the contracts actually use is implemented — `*`, `**`, `?`, brace
 * alternation and the extglobs `@()`, `?()`, `*()`, `+()`. The one construct that cannot be
 * translated honestly, the negated extglob `!(…)`, throws rather than quietly matching
 * nothing: a pattern that silently fails to ignore a file is the least visible way a
 * configuration can be wrong.
 */

/**
 * Every rule's default `ignoreGlobs`: Storybook stories, in each of the four languages the
 * rules lint. Frozen because it is shared — a rule's destructuring default is this very
 * array, and no rule may be able to change another's.
 */
export const STORY_GLOBS = Object.freeze(["**/*.stories.@(js|jsx|ts|tsx)"]);

/** The option's schema, which is the same wherever it appears. */
export const IGNORE_GLOBS_SCHEMA = { type: "array", items: { type: "string" } };

/** Regex metacharacters that are ordinary text inside a glob. */
const ESCAPED = new Set([".", "+", "^", "$", "\\", "(", ")", "[", "]", "{", "}", "|"]);

/** The repetition each extglob operator adds to the group it opens. */
const QUANTIFIER = { "@": "", "?": "?", "*": "*", "+": "+" };

const compiled = new Map();

/**
 * Translate one glob into an anchored regular expression.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  const cached = compiled.get(glob);
  if (cached) return cached;

  // Each open group remembers what separates its alternatives: a brace group splits on
  // commas, an extglob on pipes. Without the stack `{a,b}` and `@(a|b)` would be the same
  // thing, and a `,` inside an extglob would silently become an alternation.
  const groups = [];
  let out = "";

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    const next = glob[i + 1];
    const open = groups.at(-1);

    if (char === "!" && next === "(") {
      throw new Error(
        `ignoreGlobs: the negated extglob in "${glob}" is not supported — express the exclusion as a separate pattern.`,
      );
    }

    if (char in QUANTIFIER && next === "(") {
      groups.push({ kind: "extglob", quantifier: QUANTIFIER[char] });
      out += "(?:";
      i += 1;
    } else if (char === "*" && next === "*") {
      // `**/` spans whole path segments and may span none; a trailing `**` spans the rest.
      if (glob[i + 2] === "/") {
        out += "(?:[^/]*/)*";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      groups.push({ kind: "brace", quantifier: "" });
      out += "(?:";
    } else if (char === "}" && open?.kind === "brace") {
      out += `)${groups.pop().quantifier}`;
    } else if (char === ")" && open?.kind === "extglob") {
      out += `)${groups.pop().quantifier}`;
    } else if (char === "," && open?.kind === "brace") {
      out += "|";
    } else if (char === "|" && open?.kind === "extglob") {
      out += "|";
    } else {
      out += ESCAPED.has(char) ? `\\${char}` : char;
    }
  }

  const regexp = new RegExp(`^${out}$`);
  compiled.set(glob, regexp);
  return regexp;
}

/**
 * Does this file match any of the globs?
 *
 * @param {string | undefined} filename The path Oxlint reports for the file being linted.
 * @param {string[]} globs
 * @returns {boolean}
 */
export function ignoredFile(filename, globs) {
  if (!filename || !globs?.length) return false;
  const path = filename.replaceAll("\\", "/");
  return globs.some((glob) => globToRegExp(glob).test(path));
}
