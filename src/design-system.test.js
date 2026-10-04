import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { designSystemPolicy } from "../../src/policy/design-system.js";
import { loadDesignSystem } from "../../src/policy/load.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/theme.css", import.meta.url));
const BASE = fileURLToPath(new URL("../..", import.meta.url));

/** @type {import("../../src/policy/design-system.js").DesignSystemPolicy} */
let policy;
/** The design system itself, for the one test that builds a second policy over it. */
let designSystem;

beforeAll(async () => {
  designSystem = await loadDesignSystem(readFileSync(FIXTURE, "utf-8"), { base: BASE });
  policy = designSystemPolicy(designSystem);
});

describe("colorPrefixes", () => {
  it("derives the prefixes a hand-written list would carry", () => {
    // The seventeen everyone thinks of first. Deriving must not lose any of them.
    for (const prefix of [
      "bg", "text", "border", "ring-offset", "ring", "fill", "stroke",
      "from", "to", "via", "divide", "placeholder",
      "caret", "accent", "outline", "decoration", "shadow",
    ]) {
      expect(policy.colorPrefixes).toContain(prefix);
    }
  });

  // The reason the derivation exists at all: these are the families a hand-written list
  // silently misses, and every one of them is a colour a rule would never have looked at.
  it("derives the prefixes the hardcoded list missed", () => {
    for (const prefix of ["inset-ring", "inset-shadow", "text-shadow", "drop-shadow"]) {
      expect(policy.colorPrefixes).toContain(prefix);
    }
  });

  it("derives every per-side border family", () => {
    for (const side of ["t", "r", "b", "l", "x", "y", "s", "e"]) {
      expect(policy.colorPrefixes).toContain(`border-${side}`);
    }
  });

  it("does not admit a prefix that never carries a colour", () => {
    for (const prefix of ["p", "m", "w", "flex", "font", "aspect", "grid-cols"]) {
      expect(policy.colorPrefixes).not.toContain(prefix);
    }
  });

  it("adds plugin prefixes from options without replacing the derived set", () => {
    const withPlugin = designSystemPolicy(designSystem, { extraPrefixes: ["brand-glow"] });
    expect(withPlugin.colorPrefixes).toContain("brand-glow");
    expect(withPlugin.colorPrefixes).toContain("bg");
  });
});

describe("resolves", () => {
  it("accepts palette and semantic tokens alike", () => {
    expect(policy.resolves("bg-red-500")).toBe(true);
    expect(policy.resolves("text-primary")).toBe(true);
    expect(policy.resolves("bg-danger-muted")).toBe(true);
  });

  it("rejects a token that was never defined", () => {
    expect(policy.resolves("text-nonexistent")).toBe(false);
    expect(policy.resolves("bg-primaryy")).toBe(false);
  });

  it("treats an empty expansion as unresolved", () => {
    // Tailwind answers an unknown value under a known root with no declarations rather
    // than a null. Both mean the same thing to a rule.
    expect(policy.resolves("ring-2/50")).toBe(false);
    expect(policy.resolves("border-2/50")).toBe(false);
  });

  it("is not a class test — a string that is not a class simply does not resolve", () => {
    expect(policy.resolves("Hello world")).toBe(false);
    expect(policy.resolves("")).toBe(false);
  });
});

describe("isColorClass", () => {
  it("accepts a semantic token", () => {
    expect(policy.isColorClass("text-primary")).toBe(true);
    expect(policy.isColorClass("bg-danger-muted")).toBe(true);
    expect(policy.isColorClass("bg-card")).toBe(true);
  });

  it("accepts a palette class, opacity modifier or not", () => {
    expect(policy.isColorClass("bg-red-500")).toBe(true);
    // The reference survives the `color-mix()` wrapper the modifier puts around it.
    expect(policy.isColorClass("bg-primary/50")).toBe(true);
  });

  // The near-miss that makes prefix matching alone unusable. Same shape, opposite verdicts.
  it("separates text-<size> from text-<color>", () => {
    expect(policy.isColorClass("text-sm/6")).toBe(false);
    expect(policy.isColorClass("text-lg")).toBe(false);
    expect(policy.isColorClass("text-primary/50")).toBe(true);
  });

  it("accepts an arbitrary colour value", () => {
    expect(policy.isColorClass("text-[#fff]")).toBe(true);
    expect(policy.isColorClass("text-[red]")).toBe(true);
    expect(policy.isColorClass("bg-[var(--color-brand)]")).toBe(true);
  });

  it("rejects an arbitrary value that is not a colour", () => {
    // `bg` carries colours, but the `image:` type hint sends this to `background-image`.
    expect(policy.isColorClass("bg-[image:var(--x)]")).toBe(false);
    expect(policy.isColorClass("bg-[url(a/b.png)]")).toBe(false);
  });

  // A default that happens to contain a literal colour is not a colour the author chose.
  // `shadow-sm/50` resolves and expands to `rgb(0 0 0 / 0.1)`; its body is `sm`.
  it("rejects a non-colour body under a colour prefix", () => {
    expect(policy.isColorClass("shadow-sm/50")).toBe(false);
    expect(policy.isColorClass("shadow-sm")).toBe(false);
    expect(policy.isColorClass("drop-shadow-sm")).toBe(false);
  });

  it("rejects a gradient stop position under a colour prefix", () => {
    // `from` carries colours, and `from-50%` emits an `@property` block whose descriptor
    // says `syntax: "<color>"`. A colour test that walked at-rules would report it.
    expect(policy.isColorClass("from-50%")).toBe(false);
    expect(policy.isColorClass("mask-t-from-50%")).toBe(false);
  });

  it("rejects a class that does not resolve", () => {
    expect(policy.isColorClass("text-nonexistent")).toBe(false);
  });
});

describe("colorNames", () => {
  it("holds the palette and the project's own tokens alike", () => {
    // The point of the set: a rule subtracts the project's token names from it and what is
    // left is the palette. Both halves have to be in it for that subtraction to mean
    // anything.
    for (const name of ["red-500", "slate-200", "blue-950", "black", "white"]) {
      expect(policy.colorNames).toContain(name);
    }
    for (const name of ["primary", "foreground", "danger-muted", "card"]) {
      expect(policy.colorNames).toContain(name);
    }
  });

  it("omits the keyword colours, which are not theme colours", () => {
    // `transparent`, `current` and `inherit` defer to the cascade rather than naming a
    // colour of their own, and Tailwind handles them itself rather than through the theme.
    for (const name of ["transparent", "current", "inherit"]) {
      expect(policy.colorNames).not.toContain(name);
    }
  });

  it("omits the sizes, widths and positions that share a colour prefix", () => {
    for (const name of ["sm", "lg", "2", "50%", "cover", "none"]) {
      expect(policy.colorNames).not.toContain(name);
    }
  });
});

/**
 * `@theme inline`, which is what shadcn/ui generates and therefore what a large share of
 * Tailwind v4 projects run.
 *
 * Inline substitutes a theme variable's value instead of referencing it, so
 * `border-primary` emits `border-color: var(--primary)` with no `--color-` anywhere in the
 * declaration. A colour test that read only the value answered `false` for every colour
 * class in such a project — and every rule gated on it quietly stopped reporting. The
 * fixture stylesheet uses a plain `@theme`, so nothing in the corpus could see it; this is
 * the case that could.
 */
describe("@theme inline", () => {
  let inline;

  beforeAll(async () => {
    inline = designSystemPolicy(
      await loadDesignSystem(
        [
          '@import "tailwindcss";',
          ":root { --primary: oklch(0.62 0.19 259); --sidebar: oklch(0.98 0 0); }",
          "@theme inline {",
          "  --color-primary: var(--primary);",
          "  --color-sidebar: var(--sidebar);",
          "}",
        ].join("\n"),
        { base: BASE },
      ),
    );
  });

  it("sees a colour whose value never names the namespace", () => {
    expect(inline.isColorClass("bg-primary")).toBe(true);
    expect(inline.isColorClass("border-primary")).toBe(true);
    expect(inline.isColorClass("text-sidebar")).toBe(true);
  });

  it("sees a colour under every colour prefix, not only those that set a colour property", () => {
    // `ring-`, `shadow-`, the gradient stops and the `mask-*` families set their colour
    // through a Tailwind-internal custom property, which under inline carries neither a
    // `--color-` reference nor a colour property. Asked of the namespace, every prefix
    // answers the same way — and a plain `@theme` has to keep agreeing.
    for (const [label, p] of [
      ["inline", inline],
      ["plain", policy],
    ]) {
      const missed = [...p.colorPrefixes].filter((root) => !p.isColorClass(`${root}-primary`));
      expect(missed, label).toEqual([]);
    }
  });

  it("still refuses what only looks like one", () => {
    // A size, a width, a number, a keyword that sets no colour: a name under a colour prefix
    // is a colour only when the namespace has it. An arbitrary value that lands in
    // `background-image` is still not one either.
    for (const c of [
      "border-l",
      "border-2",
      "text-sm",
      "shadow-sm",
      "ring-2",
      "from-50%",
      "outline-hidden",
      "bg-[image:var(--x)]",
    ]) {
      expect(inline.isColorClass(c), c).toBe(false);
    }
  });

  it("counts the three colour keywords Tailwind ships outside the namespace", () => {
    for (const c of ["bg-current", "border-transparent", "text-inherit"]) {
      expect(inline.isColorClass(c), c).toBe(true);
    }
  });
});

describe("colorPrefixes under a stylesheet that resets the stock palette", () => {
  // A project that clears Tailwind's palette and defines only its own colours has no
  // `red-500` to probe with. The prefixes are a fact about Tailwind, not about the palette,
  // so they must come out the same — a rule gated on them would otherwise report nothing.
  const RESET = [
    '@import "tailwindcss";',
    "@theme { --color-*: initial; --color-primary: oklch(0.6 0.2 25); --color-muted-foreground: oklch(0.5 0 0); }",
  ].join("\n");

  /** @type {import("../../src/policy/design-system.js").DesignSystemPolicy} */
  let reset;
  beforeAll(async () => {
    reset = designSystemPolicy(await loadDesignSystem(RESET, { base: BASE }));
  });

  it("still derives the colour prefixes", () => {
    for (const prefix of ["bg", "text", "border", "border-t", "ring", "shadow", "fill"]) {
      expect(reset.colorPrefixes).toContain(prefix);
    }
  });

  it("does not admit a prefix that never carries a colour", () => {
    for (const prefix of ["p", "m", "w", "font", "grid-cols"]) {
      expect(reset.colorPrefixes).not.toContain(prefix);
    }
  });

  it("derives none when the theme defines no colour at all", async () => {
    const bare = designSystemPolicy(
      await loadDesignSystem('@import "tailwindcss";\n@theme { --color-*: initial; }', { base: BASE }),
    );
    expect(bare.colorNames.size).toBe(0);
    expect(bare.colorPrefixes.size).toBe(0);
  });
});
