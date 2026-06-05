export type LatexSuggestion = {
  command: string;
  label: string;
  category: string;
  template?: string;
};

export type LatexSuggestController = {
  sync(): void;
  handleKeyDown(event: KeyboardEvent): boolean;
  close(): void;
  destroy(): void;
};

type LatexSuggestTarget = {
  host: HTMLElement;
  anchor: HTMLElement;
  getValue: () => string;
  setValue: (value: string) => void;
  getCaret: () => number;
  setCaret: (position: number) => void;
  focus: () => void;
  onChange: () => void;
};

const byName = (names: string[], category: string): LatexSuggestion[] =>
  names.map((name) => ({ command: `\\${name}`, label: name, category }));

export const latexSuggestions: LatexSuggestion[] = [
  ...byName(
    [
      "alpha",
      "beta",
      "gamma",
      "delta",
      "epsilon",
      "varepsilon",
      "zeta",
      "eta",
      "theta",
      "vartheta",
      "iota",
      "kappa",
      "lambda",
      "mu",
      "nu",
      "xi",
      "pi",
      "varpi",
      "rho",
      "varrho",
      "sigma",
      "varsigma",
      "tau",
      "upsilon",
      "phi",
      "varphi",
      "chi",
      "psi",
      "omega",
      "Gamma",
      "Delta",
      "Theta",
      "Lambda",
      "Xi",
      "Pi",
      "Sigma",
      "Upsilon",
      "Phi",
      "Psi",
      "Omega",
    ],
    "Greek",
  ),
  ...byName(
    [
      "times",
      "div",
      "pm",
      "mp",
      "cdot",
      "ast",
      "star",
      "circ",
      "bullet",
      "oplus",
      "ominus",
      "otimes",
      "oslash",
      "odot",
      "cap",
      "cup",
      "bigcap",
      "bigcup",
      "vee",
      "wedge",
      "setminus",
      "triangle",
    ],
    "Operator",
  ),
  ...byName(
    [
      "le",
      "leq",
      "ge",
      "geq",
      "ll",
      "gg",
      "neq",
      "approx",
      "sim",
      "simeq",
      "cong",
      "equiv",
      "propto",
      "in",
      "notin",
      "subset",
      "subseteq",
      "supset",
      "supseteq",
      "prec",
      "preceq",
      "succ",
      "succeq",
      "perp",
      "parallel",
      "models",
      "vdash",
      "dashv",
    ],
    "Relation",
  ),
  ...byName(
    [
      "leftarrow",
      "rightarrow",
      "leftrightarrow",
      "Leftarrow",
      "Rightarrow",
      "Leftrightarrow",
      "longleftarrow",
      "longrightarrow",
      "longleftrightarrow",
      "Longleftarrow",
      "Longrightarrow",
      "Longleftrightarrow",
      "hookrightarrow",
      "mapsto",
      "uparrow",
      "downarrow",
      "to",
      "gets",
    ],
    "Arrow",
  ),
  ...byName(
    [
      "infty",
      "partial",
      "nabla",
      "forall",
      "exists",
      "neg",
      "lnot",
      "land",
      "lor",
      "implies",
      "iff",
      "emptyset",
      "varnothing",
      "cdots",
      "ldots",
      "vdots",
      "ddots",
    ],
    "Symbol",
  ),
  ...byName(
    [
      "sin",
      "cos",
      "tan",
      "arcsin",
      "arccos",
      "arctan",
      "sinh",
      "cosh",
      "tanh",
      "log",
      "ln",
      "lim",
      "min",
      "max",
      "exp",
      "det",
      "gcd",
      "Pr",
    ],
    "Function",
  ),
  ...byName(["quad", "qquad", "thinspace", "enspace", "hspace", "vspace"], "Spacing"),
  { command: "\\frac", label: "fraction", category: "Template", template: "\\frac{}{}" },
  { command: "\\dfrac", label: "display fraction", category: "Template", template: "\\dfrac{}{}" },
  { command: "\\binom", label: "binomial", category: "Template", template: "\\binom{}{}" },
  { command: "\\sqrt", label: "square root", category: "Template", template: "\\sqrt{}" },
  { command: "\\sum", label: "summation", category: "Template", template: "\\sum_{}^{}" },
  { command: "\\prod", label: "product", category: "Template", template: "\\prod_{}^{}" },
  { command: "\\int", label: "integral", category: "Template", template: "\\int_{}^{}" },
  { command: "\\lim", label: "limit", category: "Template", template: "\\lim_{}" },
  { command: "\\hat", label: "hat accent", category: "Template", template: "\\hat{}" },
  { command: "\\widehat", label: "wide hat", category: "Template", template: "\\widehat{}" },
  { command: "\\bar", label: "bar accent", category: "Template", template: "\\bar{}" },
  { command: "\\overline", label: "overline", category: "Template", template: "\\overline{}" },
  { command: "\\underline", label: "underline", category: "Template", template: "\\underline{}" },
  { command: "\\vec", label: "vector", category: "Template", template: "\\vec{}" },
  { command: "\\dot", label: "dot accent", category: "Template", template: "\\dot{}" },
  { command: "\\ddot", label: "double dot", category: "Template", template: "\\ddot{}" },
  { command: "\\tilde", label: "tilde accent", category: "Template", template: "\\tilde{}" },
  { command: "\\widetilde", label: "wide tilde", category: "Template", template: "\\widetilde{}" },
  { command: "\\text", label: "text", category: "Template", template: "\\text{}" },
  { command: "\\mathrm", label: "roman text", category: "Template", template: "\\mathrm{}" },
  { command: "\\mathbf", label: "bold text", category: "Template", template: "\\mathbf{}" },
  { command: "\\mathbb", label: "blackboard bold", category: "Template", template: "\\mathbb{}" },
  { command: "\\mathcal", label: "calligraphic", category: "Template", template: "\\mathcal{}" },
  { command: "\\mathfrak", label: "fraktur", category: "Template", template: "\\mathfrak{}" },
  { command: "\\boldsymbol", label: "bold symbol", category: "Template", template: "\\boldsymbol{}" },
  { command: "\\left", label: "paired parentheses", category: "Template", template: "\\left(\\right)" },
  { command: "\\begin", label: "environment", category: "Template", template: "\\begin{}\\end{}" },
  { command: "\\cases", label: "cases", category: "Template", template: "\\begin{cases}\n\n\\end{cases}" },
  { command: "\\matrix", label: "matrix", category: "Template", template: "\\begin{matrix}\n\n\\end{matrix}" },
  { command: "\\pmatrix", label: "parenthesized matrix", category: "Template", template: "\\begin{pmatrix}\n\n\\end{pmatrix}" },
  { command: "\\bmatrix", label: "bracket matrix", category: "Template", template: "\\begin{bmatrix}\n\n\\end{bmatrix}" },
  { command: "\\vmatrix", label: "determinant matrix", category: "Template", template: "\\begin{vmatrix}\n\n\\end{vmatrix}" },
  { command: "\\aligned", label: "aligned equations", category: "Template", template: "\\begin{aligned}\n\n\\end{aligned}" },
];

export function createLatexSuggestController(target: LatexSuggestTarget): LatexSuggestController {
  let panel: HTMLElement | null = null;
  let items: LatexSuggestion[] = [];
  let activeIndex = 0;
  let range: { from: number; to: number } | null = null;

  const ensurePanel = () => {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "math-suggest";
    panel.addEventListener("mousedown", (event) => event.preventDefault());
    target.host.classList.add("math-suggest-open");
    target.host.appendChild(panel);
    return panel;
  };

  const close = () => {
    panel?.remove();
    panel = null;
    items = [];
    activeIndex = 0;
    range = null;
    target.host.classList.remove("math-suggest-open");
  };

  const scrollActiveIntoView = () => {
    const active = panel?.querySelector<HTMLElement>(".math-suggest-item-active");
    active?.scrollIntoView({ block: "nearest" });
  };

  const render = () => {
    if (!range || items.length === 0) {
      close();
      return;
    }
    const nextPanel = ensurePanel();
    nextPanel.innerHTML = "";
    items.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = index === activeIndex ? "math-suggest-item math-suggest-item-active" : "math-suggest-item";
      button.innerHTML = `<span class="math-suggest-command">${escapeHtml(item.command)}</span><span class="math-suggest-label">${escapeHtml(item.label)}</span><span class="math-suggest-category">${escapeHtml(item.category)}</span>`;
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        accept(index);
      });
      nextPanel.appendChild(button);
    });
    scrollActiveIntoView();
  };

  const sync = () => {
    const value = target.getValue();
    const caret = target.getCaret();
    const before = value.slice(0, caret);
    const match = before.match(/\\[A-Za-z]*$/);
    if (!match) {
      close();
      return;
    }

    const token = match[0];
    const query = token.slice(1).toLowerCase();
    range = { from: caret - token.length, to: caret };
    items = latexSuggestions
      .filter((item) => {
        const command = item.command.slice(1).toLowerCase();
        return command.startsWith(query) || item.label.toLowerCase().includes(query);
      })
      .slice(0, 18);
    activeIndex = Math.min(activeIndex, Math.max(items.length - 1, 0));
    render();
  };

  const accept = (index = activeIndex) => {
    if (!range || !items[index]) return false;
    const item = items[index];
    const value = target.getValue();
    const insertion = item.template || item.command;
    const next = `${value.slice(0, range.from)}${insertion}${value.slice(range.to)}`;
    const caretOffset = templateCaretOffset(insertion);
    target.setValue(next);
    target.focus();
    target.setCaret(range.from + caretOffset);
    target.onChange();
    close();
    return true;
  };

  const move = (delta: number) => {
    if (items.length === 0) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    render();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!panel || items.length === 0) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
      return true;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      return accept();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return true;
    }
    if (event.key === " " || event.key === "ArrowLeft" || event.key === "ArrowRight") {
      window.setTimeout(sync, 0);
    }
    return false;
  };

  return {
    sync,
    handleKeyDown,
    close,
    destroy: close,
  };
}

function templateCaretOffset(template: string) {
  const firstEmptyGroup = template.indexOf("{}");
  if (firstEmptyGroup >= 0) return firstEmptyGroup + 1;
  return template.length;
}

export function getContentEditableCaret(element: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return element.textContent?.length ?? 0;
  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer)) return element.textContent?.length ?? 0;
  const before = range.cloneRange();
  before.selectNodeContents(element);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

export function setContentEditableCaret(element: HTMLElement, position: number) {
  const range = document.createRange();
  const selection = window.getSelection();
  const target = findTextPosition(element, position);
  range.setStart(target.node, target.offset);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function findTextPosition(element: HTMLElement, position: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let remaining = Math.max(0, position);
  let node = walker.nextNode();
  while (node) {
    const length = node.textContent?.length ?? 0;
    if (remaining <= length) return { node, offset: remaining };
    remaining -= length;
    node = walker.nextNode();
  }
  if (!element.firstChild) element.appendChild(document.createTextNode(""));
  const fallback = element.firstChild || element;
  return { node: fallback, offset: fallback.textContent?.length ?? 0 };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}
