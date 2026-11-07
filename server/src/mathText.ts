import katex from "katex";
import renderA11yString from "katex/contrib/render-a11y-string";
import type { BoardBlock } from "./events.js";

/**
 * Makes board maths readable everywhere it's shown:
 * - LaTeX is checked with KaTeX (the same version the student app renders with), so nothing
 *   that reaches a phone can show up as an error or raw source.
 * - Every block gets `plain` (readable Unicode: x = (−b ± √(b² − 4ac)) / 2a) for fallbacks,
 *   copying and the mind map, and `spoken` (words) for screen readers and read-aloud.
 */

type RawBlock = { id: string; kind: "text" | "equation"; content: string };

export function normalizeBlock(raw: RawBlock): BoardBlock {
  return raw.kind === "equation" ? equationBlock(raw) : textBlock(raw);
}

function equationBlock(raw: RawBlock): BoardBlock {
  const tex = stripDelimiters(raw.content);
  if (isValidLatex(tex)) return { id: raw.id, kind: "equation", content: tex, plain: toPlain(tex), spoken: speak(tex) };
  // Unrenderable LaTeX would show as an error on phones: keep it as readable text instead.
  const plain = toPlain(tex);
  return { id: raw.id, kind: "text", content: plain, plain, spoken: plain };
}

function textBlock(raw: RawBlock): BoardBlock {
  const segments = splitInlineMath(raw.content);

  // A "text" line that is really just maths (e.g. "x^2 + 6x + 5 = 0") renders better as an equation.
  if (segments.length === 1 && !segments[0].math && looksLikeMath(segments[0].text) && isValidLatex(segments[0].text)) {
    return equationBlock({ ...raw, kind: "equation" });
  }

  let content = "";
  let plain = "";
  let spoken = "";
  for (const seg of segments) {
    if (seg.math && isValidLatex(seg.text)) {
      content += `$${seg.text}$`;
      plain += toPlain(seg.text);
      spoken += speak(seg.text);
    } else {
      // Prose, or maths KaTeX can't render: turn any stray x^2 or \pm into readable symbols.
      const readable = toPlain(seg.text, { math: seg.math });
      content += readable;
      plain += readable;
      spoken += readable;
    }
  }
  return { id: raw.id, kind: "text", content: tidy(content), plain: tidy(plain), spoken: tidy(spoken) };
}

function isValidLatex(tex: string): boolean {
  if (!tex.trim()) return false;
  try {
    katex.renderToString(tex, { throwOnError: true, strict: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function speak(tex: string): string {
  try {
    return renderA11yString(tex);
  } catch {
    return toPlain(tex);
  }
}

function stripDelimiters(tex: string): string {
  return tex.trim().replace(/^\$\$?([\s\S]*?)\$?\$$/, "$1").replace(/^\\\[([\s\S]*)\\\]$/, "$1").trim();
}

/** Splits "Discriminant: $b^2 - 4ac$ is key" into prose and $…$ maths segments. */
function splitInlineMath(text: string): { text: string; math: boolean }[] {
  const parts = text.split(/(?<!\\)\$([^$]+)\$/);
  return parts.map((part, i) => ({ text: part, math: i % 2 === 1 })).filter((p) => p.text);
}

const MATH_WORDS = new Set(["sin", "cos", "tan", "log", "ln", "lim", "max", "min", "exp", "mod"]);

function looksLikeMath(text: string): boolean {
  if (!/[\^_=\\]/.test(text)) return false;
  const words = text.replace(/\\[a-zA-Z]+/g, " ").match(/[A-Za-z]{4,}/g) ?? [];
  return words.every((w) => MATH_WORDS.has(w.toLowerCase()));
}

function tidy(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// ---------- LaTeX → readable Unicode ----------

const SYMBOLS: Record<string, string> = {
  pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠",
  approx: "≈", equiv: "≡", infty: "∞", to: "→", rightarrow: "→", Rightarrow: "⇒", leftarrow: "←", iff: "⇔",
  pi: "π", theta: "θ", alpha: "α", beta: "β", gamma: "γ", delta: "δ", Delta: "Δ", epsilon: "ε", lambda: "λ",
  mu: "μ", sigma: "σ", Sigma: "Σ", omega: "ω", Omega: "Ω", phi: "φ", rho: "ρ", tau: "τ",
  sum: "Σ", prod: "∏", int: "∫", partial: "∂", nabla: "∇", in: "∈", notin: "∉", subset: "⊂", cup: "∪", cap: "∩",
  forall: "∀", exists: "∃", circ: "°", degree: "°", ldots: "…", cdots: "⋯", dots: "…", angle: "∠", perp: "⊥",
};
const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", x: "ˣ", y: "ʸ",
};
const SUBSCRIPT: Record<string, string> = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "−": "₋", "=": "₌", "(": "₍", ")": "₎", a: "ₐ", e: "ₑ", i: "ᵢ", n: "ₙ", x: "ₓ",
};
const TEXT_COMMANDS = new Set(["text", "mathrm", "textbf", "mathbf", "mathit", "textit", "operatorname", "mbox"]);

/**
 * Converts LaTeX to readable Unicode: x^2 → x², \frac{a}{b} → a/b, \sqrt{b^2-4ac} → √(b² − 4ac).
 * With `math: false` (prose around formulas), hyphens and braces are left alone.
 */
export function toPlain(tex: string, { math = true } = {}): string {
  const s = tex.replace(/\\(left|right|displaystyle|big|Big)\b/g, "");
  let i = 0;

  const skipSpaces = () => {
    while (s[i] === " ") i++;
  };
  const wrap = (x: string) => {
    const t = x.trim();
    return /^[\p{L}\p{N}.⁰-⁹²³¹]+$/u.test(t) || /^\(.*\)$/.test(t) ? t : `(${t})`;
  };
  const script = (arg: string, table: Record<string, string>, mark: string) => {
    const chars = [...arg.trim()];
    return chars.length && chars.every((c) => table[c]) ? chars.map((c) => table[c]).join("") : `${mark}(${arg.trim()})`;
  };

  function arg(): string {
    skipSpaces();
    if (s[i] === "{") {
      i++;
      const out = parse("}");
      i++;
      return out;
    }
    if (s[i] === "\\") return command();
    const c = s[i++] ?? "";
    return c === "-" ? "−" : c;
  }

  function command(): string {
    i++; // the backslash
    let name = "";
    if (/[a-zA-Z]/.test(s[i] ?? "")) while (/[a-zA-Z]/.test(s[i] ?? "")) name += s[i++];
    else name = s[i++] ?? "";
    if (name === "frac" || name === "dfrac" || name === "tfrac") {
      const top = arg();
      const bottom = arg();
      const a = wrap(top);
      const b = wrap(bottom);
      return a === top.trim() && b === bottom.trim() ? `${a}/${b}` : `${a} / ${b}`;
    }
    if (name === "sqrt") {
      skipSpaces();
      let n = "";
      if (s[i] === "[") {
        i++;
        while (i < s.length && s[i] !== "]") n += s[i++];
        i++;
      }
      const root = n === "3" ? "∛" : n === "4" ? "∜" : n ? `${n}√` : "√";
      return root + wrap(arg());
    }
    if (TEXT_COMMANDS.has(name)) return arg();
    if ([",", ";", ":", " ", "quad", "qquad", "\\"].includes(name)) return " ";
    if (name === "!") return "";
    if (["{", "}", "%", "$", "&", "#", "_"].includes(name)) return name;
    return SYMBOLS[name] ?? name; // \sin → sin, \log → log
  }

  function parse(end?: string): string {
    let out = "";
    while (i < s.length && s[i] !== end) {
      const c = s[i];
      if (c === "\\") out += command();
      else if (c === "^" || c === "_") {
        i++;
        out += script(arg(), c === "^" ? SUPERSCRIPT : SUBSCRIPT, c);
      } else if (c === "{" && math) {
        i++;
        out += parse("}");
        i++;
      } else if (c === "-" && math) {
        out += "−";
        i++;
      } else if (c === "~" && math) {
        out += " ";
        i++;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  return parse().replace(/ {2,}/g, " ");
}
