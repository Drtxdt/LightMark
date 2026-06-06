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

const byEntries = (
  entries: Array<[command: string, label: string, template?: string]>,
  category: string,
): LatexSuggestion[] =>
  entries.map(([command, label, template]) => ({ command, label, category, template }));

const greekLetters: LatexSuggestion[] = byEntries(
  [
    ["\\alpha", "α"],
    ["\\beta", "β"],
    ["\\gamma", "γ"],
    ["\\delta", "δ"],
    ["\\epsilon", "ϵ"],
    ["\\varepsilon", "ε"],
    ["\\zeta", "ζ"],
    ["\\eta", "η"],
    ["\\theta", "θ"],
    ["\\vartheta", "ϑ"],
    ["\\iota", "ι"],
    ["\\kappa", "κ"],
    ["\\lambda", "λ"],
    ["\\mu", "μ"],
    ["\\nu", "ν"],
    ["\\xi", "ξ"],
    ["\\pi", "π"],
    ["\\varpi", "ϖ"],
    ["\\rho", "ρ"],
    ["\\varrho", "ϱ"],
    ["\\sigma", "σ"],
    ["\\varsigma", "ς"],
    ["\\tau", "τ"],
    ["\\upsilon", "υ"],
    ["\\phi", "ϕ"],
    ["\\varphi", "φ"],
    ["\\chi", "χ"],
    ["\\psi", "ψ"],
    ["\\omega", "ω"],
    ["\\Gamma", "Γ"],
    ["\\Delta", "Δ"],
    ["\\Theta", "Θ"],
    ["\\Lambda", "Λ"],
    ["\\Xi", "Ξ"],
    ["\\Pi", "Π"],
    ["\\Sigma", "Σ"],
    ["\\Upsilon", "Υ"],
    ["\\Phi", "Φ"],
    ["\\Psi", "Ψ"],
    ["\\Omega", "Ω"],
  ],
  "希腊字母",
);

export const latexSuggestions: LatexSuggestion[] = [
  ...greekLetters,

  ...byEntries(
    [
      ["\\times", "×"],
      ["\\div", "÷"],
      ["\\pm", "±"],
      ["\\mp", "∓"],
      ["\\cdot", "点乘 ·"],
      ["\\ast", "星号 ∗"],
      ["\\star", "星形 ⋆"],
      ["\\circ", "复合 ∘"],
      ["\\bullet", "项目符号 •"],
      ["\\oplus", "直和 ⊕"],
      ["\\ominus", "⊖"],
      ["\\otimes", "张量积 ⊗"],
      ["\\oslash", "⊘"],
      ["\\odot", "⊙"],
      ["\\bigoplus", "大直和 ⨁"],
      ["\\bigotimes", "大张量积 ⨂"],
      ["\\wedge", "逻辑与 ∧"],
      ["\\vee", "逻辑或 ∨"],
      ["\\cap", "交集 ∩"],
      ["\\cup", "并集 ∪"],
      ["\\bigcap", "大交集 ⋂"],
      ["\\bigcup", "大并集 ⋃"],
      ["\\setminus", "差集 ∖"],
      ["\\triangle", "三角形 △"],
      ["\\angle", "角 ∠"],
      ["\\measuredangle", "测量角 ∡"],
      ["\\degree", "角度 °"],
    ],
    "运算符",
  ),

  ...byEntries(
    [
      ["\\le", "≤"],
      ["\\leq", "≤"],
      ["\\ge", "≥"],
      ["\\geq", "≥"],
      ["\\ll", "≪"],
      ["\\gg", "≫"],
      ["\\neq", "≠"],
      ["\\approx", "≈"],
      ["\\sim", "∼"],
      ["\\simeq", "≃"],
      ["\\cong", "≅"],
      ["\\equiv", "≡"],
      ["\\propto", "∝"],
      ["\\in", "属于 ∈"],
      ["\\notin", "不属于 ∉"],
      ["\\ni", "包含元素 ∋"],
      ["\\subset", "真子集 ⊂"],
      ["\\subseteq", "子集 ⊆"],
      ["\\supset", "真超集 ⊃"],
      ["\\supseteq", "超集 ⊇"],
      ["\\sqsubseteq", "方形子集 ⊑"],
      ["\\sqsupseteq", "方形超集 ⊒"],
      ["\\prec", "先于 ≺"],
      ["\\preceq", "先于等于 ≼"],
      ["\\succ", "后于 ≻"],
      ["\\succeq", "后于等于 ≽"],
      ["\\perp", "垂直 ⟂"],
      ["\\parallel", "平行 ∥"],
      ["\\mid", "整除 / 条件 |"],
      ["\\nmid", "不整除 ∤"],
      ["\\models", "满足 ⊨"],
      ["\\vdash", "推出 ⊢"],
      ["\\dashv", "反推出 ⊣"],
    ],
    "关系符",
  ),

  ...byEntries(
    [
      ["\\leftarrow", "←"],
      ["\\rightarrow", "→"],
      ["\\leftrightarrow", "↔"],
      ["\\Leftarrow", "⇐"],
      ["\\Rightarrow", "⇒"],
      ["\\Leftrightarrow", "⇔"],
      ["\\longleftarrow", "⟵"],
      ["\\longrightarrow", "⟶"],
      ["\\longleftrightarrow", "⟷"],
      ["\\Longleftarrow", "⟸"],
      ["\\Longrightarrow", "⟹"],
      ["\\Longleftrightarrow", "⟺"],
      ["\\hookrightarrow", "钩箭头 ↪"],
      ["\\mapsto", "映射到 ↦"],
      ["\\uparrow", "↑"],
      ["\\downarrow", "↓"],
      ["\\updownarrow", "↕"],
      ["\\nearrow", "↗"],
      ["\\searrow", "↘"],
      ["\\swarrow", "↙"],
      ["\\nwarrow", "↖"],
      ["\\to", "→"],
      ["\\gets", "←"],
    ],
    "箭头",
  ),

  ...byEntries(
    [
      ["\\infty", "∞"],
      ["\\partial", "∂"],
      ["\\nabla", "∇"],
      ["\\forall", "∀"],
      ["\\exists", "∃"],
      ["\\nexists", "∄"],
      ["\\neg", "¬"],
      ["\\lnot", "¬"],
      ["\\land", "∧"],
      ["\\lor", "∨"],
      ["\\implies", "蕴含 ⇒"],
      ["\\iff", "当且仅当 ⇔"],
      ["\\top", "真 ⊤"],
      ["\\bot", "假 ⊥"],
      ["\\therefore", "因此 ∴"],
      ["\\because", "因为 ∵"],
      ["\\emptyset", "空集 ∅"],
      ["\\varnothing", "空集 ∅"],
      ["\\cdots", "横向省略 ⋯"],
      ["\\ldots", "低位省略 …"],
      ["\\vdots", "竖向省略 ⋮"],
      ["\\ddots", "斜向省略 ⋱"],
    ],
    "符号",
  ),

  ...byName(
    [
      "sin",
      "cos",
      "tan",
      "cot",
      "sec",
      "csc",
      "arcsin",
      "arccos",
      "arctan",
      "sinh",
      "cosh",
      "tanh",
      "log",
      "ln",
      "lg",
      "lim",
      "min",
      "max",
      "sup",
      "inf",
      "exp",
      "det",
      "gcd",
      "Pr",
    ],
    "数学函数",
  ),

  ...byEntries(
    [
      ["\\mathrm", "正体", "\\mathrm{}"],
      ["\\mathbf", "粗体", "\\mathbf{}"],
      ["\\mathit", "斜体", "\\mathit{}"],
      ["\\mathsf", "无衬线", "\\mathsf{}"],
      ["\\mathtt", "等宽", "\\mathtt{}"],
      ["\\mathbb", "黑板粗体", "\\mathbb{}"],
      ["\\mathcal", "花体", "\\mathcal{}"],
      ["\\mathfrak", "哥特体", "\\mathfrak{}"],
      ["\\boldsymbol", "粗符号", "\\boldsymbol{}"],
      ["\\operatorname", "自定义算子", "\\operatorname{}"],
      ["\\text", "普通文字", "\\text{}"],
    ],
    "字体与文本",
  ),

  ...byEntries(
    [
      ["\\quad", "空格 1em"],
      ["\\qquad", "空格 2em"],
      ["\\,", "小空格"],
      ["\\;", "中空格"],
      ["\\:", "中等空格"],
      ["\\!", "负空格"],
      ["\\hspace", "水平空白", "\\hspace{}"],
      ["\\vspace", "垂直空白", "\\vspace{}"],
    ],
    "间距",
  ),

  ...byEntries(
    [
      ["\\frac", "分式", "\\frac{}{}"],
      ["\\dfrac", "展示分式", "\\dfrac{}{}"],
      ["\\tfrac", "行内分式", "\\tfrac{}{}"],
      ["\\binom", "二项式", "\\binom{}{}"],
      ["\\sqrt", "平方根", "\\sqrt{}"],
      ["\\sqrtN", "n 次根", "\\sqrt[]{}"],
      ["\\sum", "求和", "\\sum_{}^{}"],
      ["\\prod", "连乘", "\\prod_{}^{}"],
      ["\\coprod", "余积", "\\coprod_{}^{}"],
      ["\\lim", "极限", "\\lim_{}"],
      ["\\limto", "极限趋近", "\\lim_{x \\to }"],
      ["\\int", "积分", "\\int_{}^{}"],
      ["\\iint", "二重积分", "\\iint_{}^{}"],
      ["\\iiint", "三重积分", "\\iiint_{}^{}"],
      ["\\oint", "环路积分", "\\oint_{}"],
      ["\\derivative", "导数", "\\frac{d}{d x}"],
      ["\\partialDerivative", "偏导数", "\\frac{\\partial}{\\partial x}"],
    ],
    "模板",
  ),

  ...byEntries(
    [
      ["\\hat", "帽子", "\\hat{}"],
      ["\\widehat", "宽帽子", "\\widehat{}"],
      ["\\bar", "横线", "\\bar{}"],
      ["\\overline", "上划线", "\\overline{}"],
      ["\\underline", "下划线", "\\underline{}"],
      ["\\vec", "向量箭头", "\\vec{}"],
      ["\\dot", "一点", "\\dot{}"],
      ["\\ddot", "两点", "\\ddot{}"],
      ["\\tilde", "波浪号", "\\tilde{}"],
      ["\\widetilde", "宽波浪号", "\\widetilde{}"],
      ["\\overbrace", "上花括号", "\\overbrace{}^{}"],
      ["\\underbrace", "下花括号", "\\underbrace{}_{}"],
    ],
    "修饰符",
  ),

  ...byEntries(
    [
      ["\\paren", "圆括号", "\\left(\\right)"],
      ["\\bracket", "方括号", "\\left[\\right]"],
      ["\\brace", "花括号", "\\left\\{\\right\\}"],
      ["\\abs", "绝对值", "\\left|\\right|"],
      ["\\norm", "范数", "\\left\\|\\right\\|"],
      ["\\angleBracket", "尖括号", "\\left\\langle\\right\\rangle"],
      ["\\floor", "下取整", "\\left\\lfloor\\right\\rfloor"],
      ["\\ceil", "上取整", "\\left\\lceil\\right\\rceil"],
      ["\\left", "自适应圆括号", "\\left(\\right)"],
    ],
    "括号与分隔符",
  ),

  ...byEntries(
    [
      ["\\begin", "环境", "\\begin{}\n\n\\end{}"],
      ["\\cases", "分段函数", "\\begin{cases}\n  , & \\\\n  , & \n\\end{cases}"],
      ["\\matrix", "矩阵", "\\begin{matrix}\n  & \\\\n  & \n\\end{matrix}"],
      ["\\pmatrix", "圆括号矩阵", "\\begin{pmatrix}\n  & \\\\n  & \n\\end{pmatrix}"],
      ["\\bmatrix", "方括号矩阵", "\\begin{bmatrix}\n  & \\\\n  & \n\\end{bmatrix}"],
      ["\\Bmatrix", "花括号矩阵", "\\begin{Bmatrix}\n  & \\\\n  & \n\\end{Bmatrix}"],
      ["\\vmatrix", "行列式", "\\begin{vmatrix}\n  & \\\\n  & \n\\end{vmatrix}"],
      ["\\Vmatrix", "双竖线矩阵", "\\begin{Vmatrix}\n  & \\\\n  & \n\\end{Vmatrix}"],
      ["\\smallmatrix", "小矩阵", "\\begin{smallmatrix}\n  & \\\\n  & \n\\end{smallmatrix}"],
      ["\\aligned", "多行对齐", "\\begin{aligned}\n  &= \\\\n  &= \n\\end{aligned}"],
      ["\\array", "数组", "\\begin{array}{}\n\n\\end{array}"],
    ],
    "环境",
  ),

  ...byEntries(
    [
      ["\\RR", "实数集 ℝ", "\\mathbb{R}"],
      ["\\NN", "自然数集 ℕ", "\\mathbb{N}"],
      ["\\ZZ", "整数集 ℤ", "\\mathbb{Z}"],
      ["\\QQ", "有理数集 ℚ", "\\mathbb{Q}"],
      ["\\CC", "复数集 ℂ", "\\mathbb{C}"],
      ["\\PP", "概率空间 ℙ", "\\mathbb{P}"],
      ["\\EE", "期望 𝔼", "\\mathbb{E}"],
      ["\\rr", "实数集 ℝ", "\\mathbb{R}"],
      ["\\nn", "自然数集 ℕ", "\\mathbb{N}"],
      ["\\zz", "整数集 ℤ", "\\mathbb{Z}"],
      ["\\qq", "有理数集 ℚ", "\\mathbb{Q}"],
      ["\\cc", "复数集 ℂ", "\\mathbb{C}"],
      ["\\set", "集合", "\\left\\{\\right\\}"],
      ["\\union", "并集", "\\cup"],
      ["\\intersect", "交集", "\\cap"],
    ],
    "集合论",
  ),

  ...byEntries(
    [
      ["\\Pr", "概率", "\\Pr{}"],
      ["\\prob", "概率 P(A)", "P()"],
      ["\\given", "条件概率竖线", "\\mid"],
      ["\\expect", "期望 E[X]", "\\mathbb{E}[]"],
      ["\\variance", "方差 Var(X)", "\\operatorname{Var}()"],
      ["\\covariance", "协方差 Cov(X,Y)", "\\operatorname{Cov}(,)"],
      ["\\normal", "正态分布", "\\mathcal{N}(, )"],
      ["\\binomial", "二项分布", "\\operatorname{Bin}(, )"],
      ["\\poisson", "泊松分布", "\\operatorname{Poisson}()"],
      ["\\uniform", "均匀分布", "\\operatorname{U}(, )"],
    ],
    "概率统计",
  ),

  ...byEntries(
    [
      ["\\rank", "矩阵秩", "\\operatorname{rank}()"],
      ["\\trace", "迹", "\\operatorname{tr}()"],
      ["\\diag", "对角矩阵", "\\operatorname{diag}()"],
      ["\\span", "张成空间", "\\operatorname{span}\\left\\{\\right\\}"],
      ["\\kernel", "核空间", "\\ker()"],
      ["\\image", "像空间", "\\operatorname{im}()"],
      ["\\detA", "行列式 det(A)", "\\det(A)"],
      ["\\transpose", "转置", "^{\\mathsf{T}}"],
      ["\\inverse", "逆矩阵", "^{-1}"],
    ],
    "线性代数",
  ),

  ...byEntries(
    [
      ["\\eps", "ε", "\\varepsilon"],
      ["\\alp", "α", "\\alpha"],
      ["\\bet", "β", "\\beta"],
      ["\\gam", "γ", "\\gamma"],
      ["\\del", "δ", "\\delta"],
      ["\\lam", "λ", "\\lambda"],
      ["\\sig", "σ", "\\sigma"],
      ["\\omg", "ω", "\\omega"],
      ["\\inf", "∞", "\\infty"],
      ["\\pd", "偏导 ∂", "\\partial"],
      ["\\grad", "梯度 ∇", "\\nabla"],
      ["\\ra", "→", "\\rightarrow"],
      ["\\la", "←", "\\leftarrow"],
      ["\\Ra", "⇒", "\\Rightarrow"],
      ["\\La", "⇐", "\\Leftarrow"],
      ["\\Lra", "⇔", "\\Leftrightarrow"],
    ],
    "快捷缩写",
  ),

  ...byEntries(
    [
      ["\\ohm", "欧姆定律", "U = IR"],
      ["\\newton", "牛顿第二定律", "F = ma"],
      ["\\energy", "质能方程", "E = mc^2"],
      ["\\momentum", "动量", "p = mv"],
      ["\\gravity", "万有引力", "F = G\\frac{m_1m_2}{r^2}"],
      ["\\coulomb", "库仑定律", "F = k\\frac{q_1q_2}{r^2}"],
      ["\\wave", "波速公式", "v = f\\lambda"],
    ],
    "物理常用式",
  ),

  ...byEntries(
    [
      ["\\ce", "化学式", "\\ce{}"],
      ["\\pu", "物理单位", "\\pu{}"],
      ["\\reaction", "化学反应式", "\\ce{ -> }"],
    ],
    "化学",
  ),
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
