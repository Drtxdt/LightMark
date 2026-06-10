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
    ["\\varkappa", "ϰ"],
    ["\\lambda", "λ"],
    ["\\mu", "μ"],
    ["\\nu", "ν"],
    ["\\xi", "ξ"],
    ["\\omicron", "ο"],
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
    ["\\varGamma", "Γ"],
    ["\\Delta", "Δ"],
    ["\\varDelta", "Δ"],
    ["\\Theta", "Θ"],
    ["\\varTheta", "Θ"],
    ["\\Lambda", "Λ"],
    ["\\varLambda", "Λ"],
    ["\\Xi", "Ξ"],
    ["\\varXi", "Ξ"],
    ["\\Pi", "Π"],
    ["\\varPi", "Π"],
    ["\\Sigma", "Σ"],
    ["\\varSigma", "Σ"],
    ["\\Upsilon", "Υ"],
    ["\\varUpsilon", "Υ"],
    ["\\Phi", "Φ"],
    ["\\varPhi", "Φ"],
    ["\\Psi", "Ψ"],
    ["\\varPsi", "Ψ"],
    ["\\Omega", "Ω"],
    ["\\varOmega", "Ω"],
  ],
  "希腊字母",
);

export const latexSuggestions: LatexSuggestion[] = [
  ...greekLetters,

  ...byEntries(
    [
      ["\\le", "≤", "小于等于 ≤"],
      ["\\leq", "≤", "小于等于 ≤"],
      ["\\ge", "≥", "大于等于 ≥"],
      ["\\geq", "≥", "大于等于 ≥"],
      ["\\equiv", "≡", "恒等于 ≡"],
      ["\\doteq", "≐", "点等于 ≐"],
      ["\\ne", "≠", "不等于 ≠"],
      ["\\neq", "≠", "不等于 ≠"],
      ["\\sim", "∼", "相似 ∼"],
      ["\\simeq", "≃", "渐近/相似 ≃"],
      ["\\approx", "≈", "近似 ≈"],
      ["\\cong", "≅", "同构/全等 ≅"],
      ["\\asymp", "≍", "渐近相等 ≍"],
      ["\\propto", "∝", "正比于 ∝"],
      ["\\ll", "≪", "远小于 ≪"],
      ["\\gg", "≫", "远大于 ≫"],
      ["\\prec", "≺", "先于 ≺"],
      ["\\succ", "≻", "后于 ≻"],
      ["\\preceq", "⪯", "先于等于 ⪯"],
      ["\\succeq", "⪰", "后于等于 ⪰"],
      ["\\subset", "⊂", "真子集 ⊂"],
      ["\\supset", "⊃", "真超集 ⊃"],
      ["\\subseteq", "⊆", "子集 ⊆"],
      ["\\supseteq", "⊇", "超集 ⊇"],
      ["\\subsetneq", "⊊", "真子集但不等 ⊊"],
      ["\\supsetneq", "⊋", "真超集但不等 ⊋"],
      ["\\in", "∈", "属于 ∈"],
      ["\\ni", "∋", "包含 ∋"],
      ["\\notin", "∉", "不属于 ∉"],
      ["\\mid", "∣", "整除 / 条件 ∣"],
      ["\\nmid", "∤", "不整除 ∤"],
      ["\\parallel", "∥", "平行 ∥"],
      ["\\nparallel", "∦", "不平行 ∦"],
      ["\\perp", "⊥", "垂直 ⊥"],
      ["\\smile", "⌣", "smile ⌣"],
      ["\\frown", "⌢", "frown ⌢"],
      ["\\models", "⊨", "满足 ⊨"],
      ["\\vdash", "⊢", "推出 ⊢"],
      ["\\dashv", "⊣", "反推出 ⊣"],
      ["\\bowtie", "⋈", "连接 ⋈"],
    ],
    "关系符",
  ),

  ...byEntries(
    [
      ["\\pm", "±", "正负 ±"],
      ["\\mp", "∓", "负正 ∓"],
      ["\\times", "×", "乘号 ×"],
      ["\\div", "÷", "除号 ÷"],
      ["\\cdot", "⋅", "点乘 ⋅"],
      ["\\ast", "∗", "星号 ∗"],
      ["\\star", "⋆", "星形 ⋆"],
      ["\\circ", "∘", "复合 ∘"],
      ["\\bullet", "∙", "圆点 ∙"],
      ["\\diamond", "⋄", "菱形 ⋄"],
      ["\\bigcirc", "◯", "大圆圈 ◯"],
      ["\\setminus", "∖", "差集 ∖"],
      ["\\cup", "∪", "并集 ∪"],
      ["\\cap", "∩", "交集 ∩"],
      ["\\uplus", "⊎", "不交并 ⊎"],
      ["\\amalg", "⨿", "amalg ⨿"],
      ["\\wr", "≀", "wr 积 ≀"],
      ["\\oplus", "⊕", "带圈加 ⊕"],
      ["\\ominus", "⊖", "带圈减 ⊖"],
      ["\\otimes", "⊗", "张量积 ⊗"],
      ["\\oslash", "⊘", "带圈除 ⊘"],
      ["\\odot", "⊙", "带圈点 ⊙"],
      ["\\triangleleft", "◃", "左三角 ◃"],
      ["\\triangleright", "▹", "右三角 ▹"],
      ["\\bigtriangleup", "△", "大正三角 △"],
      ["\\bigtriangledown", "▽", "大倒三角 ▽"],
      ["\\lhd", "⊲", "左三角 ⊲"],
      ["\\rhd", "⊳", "右三角 ⊳"],
      ["\\unlhd", "⊴", "左正规 ⊴"],
      ["\\unrhd", "⊵", "右正规 ⊵"],
      ["\\dagger", "†", "剑号 †"],
      ["\\ddagger", "‡", "双剑号 ‡"],
    ],
    "二元运算符",
  ),

  ...byEntries(
    [
      ["\\sum", "求和 ∑", "\\sum_{}^{}"],
      ["\\prod", "连乘 ∏", "\\prod_{}^{}"],
      ["\\coprod", "余积 ∐", "\\coprod_{}^{}"],
      ["\\int", "积分 ∫", "\\int_{}^{}"],
      ["\\iint", "二重积分 ∬", "\\iint_{}^{}"],
      ["\\iiint", "三重积分 ∭", "\\iiint_{}^{}"],
      ["\\oint", "环路积分 ∮", "\\oint_{}"],
      ["\\oiint", "闭合曲面积分 ∬", "\\oiint_{}"],
      ["\\oiiint", "闭合体积分 ∭", "\\oiiint_{}"],
      ["\\bigcup", "大并集 ⋃", "\\bigcup_{}^{}"],
      ["\\bigcap", "大交集 ⋂", "\\bigcap_{}^{}"],
      ["\\bigsqcup", "大方并 ⨆", "\\bigsqcup_{}^{}"],
      ["\\biguplus", "大不交并 ⨄", "\\biguplus_{}^{}"],
      ["\\bigvee", "大逻辑或 ⋁", "\\bigvee_{}^{}"],
      ["\\bigwedge", "大逻辑与 ⋀", "\\bigwedge_{}^{}"],
      ["\\bigodot", "大带圈点 ⨀", "\\bigodot_{}^{}"],
      ["\\bigoplus", "大直和 ⨁", "\\bigoplus_{}^{}"],
      ["\\bigotimes", "大张量积 ⨂", "\\bigotimes_{}^{}"],
    ],
    "大型运算符",
  ),

  ...byEntries(
    [
      ["\\leftarrow", "←"],
      ["\\rightarrow", "→"],
      ["\\leftrightarrow", "↔"],
      ["\\longleftarrow", "⟵"],
      ["\\longrightarrow", "⟶"],
      ["\\longleftrightarrow", "⟷"],
      ["\\Leftarrow", "⇐"],
      ["\\Rightarrow", "⇒"],
      ["\\Leftrightarrow", "⇔"],
      ["\\Longleftarrow", "⟸"],
      ["\\Longrightarrow", "⟹"],
      ["\\Longleftrightarrow", "⟺"],
      ["\\mapsto", "↦", "映射到 ↦"],
      ["\\longmapsto", "⟼", "长映射 ⟼"],
      ["\\hookleftarrow", "↩", "左钩箭头 ↩"],
      ["\\hookrightarrow", "↪", "右钩箭头 ↪"],
      ["\\leftharpoonup", "↼", "左鱼叉上 ↼"],
      ["\\leftharpoondown", "↽", "左鱼叉下 ↽"],
      ["\\rightharpoonup", "⇀", "右鱼叉上 ⇀"],
      ["\\rightharpoondown", "⇁", "右鱼叉下 ⇁"],
      ["\\rightleftharpoons", "⇌", "可逆反应 ⇌"],
      ["\\leadsto", "⇝", "leadsto ⇝"],
      ["\\uparrow", "↑"],
      ["\\downarrow", "↓"],
      ["\\updownarrow", "↕"],
      ["\\Uparrow", "⇑"],
      ["\\Downarrow", "⇓"],
      ["\\Updownarrow", "⇕"],
      ["\\nearrow", "↗"],
      ["\\searrow", "↘"],
      ["\\swarrow", "↙"],
      ["\\nwarrow", "↖"],
      ["\\to", "→"],
      ["\\gets", "←"],
      ["\\iff", "⟺", "当且仅当 ⟺"],
      ["\\implies", "⟹", "蕴含 ⟹"],
      ["\\impliedby", "⟸", "被蕴含 ⟸"],
    ],
    "箭头",
  ),

  ...byEntries(
    [
      ["\\lparen", "("],
      ["\\rparen", ")"],
      ["\\lbrack", "["],
      ["\\rbrack", "]"],
      ["\\lbrace", "{"],
      ["\\rbrace", "}"],
      ["\\langle", "⟨"],
      ["\\rangle", "⟩"],
      ["\\lceil", "⌈"],
      ["\\rceil", "⌉"],
      ["\\lfloor", "⌊"],
      ["\\rfloor", "⌋"],
      ["\\vert", "∣"],
      ["\\Vert", "∥"],
      ["\\lvert", "∣"],
      ["\\rvert", "∣"],
      ["\\lVert", "∥"],
      ["\\rVert", "∥"],
      ["\\backslash", "∖"],
      ["\\lgroup", "⟮"],
      ["\\rgroup", "⟯"],
      ["\\lmoustache", "⎰"],
      ["\\rmoustache", "⎱"],
      ["\\left", "自适应左边界", "\\left"],
      ["\\right", "自适应右边界", "\\right"],
      ["\\middle", "自适应中间分隔", "\\middle"],
      ["\\paren", "圆括号", "\\left(\\right)"],
      ["\\bracket", "方括号", "\\left[\\right]"],
      ["\\brace", "花括号", "\\left\\{\\right\\}"],
      ["\\abs", "绝对值", "\\left|\\right|"],
      ["\\norm", "范数", "\\left\\|\\right\\|"],
      ["\\angleBracket", "尖括号", "\\left\\langle\\right\\rangle"],
      ["\\floor", "下取整", "\\left\\lfloor\\right\\rfloor"],
      ["\\ceil", "上取整", "\\left\\lceil\\right\\rceil"],
      ["\\big", "手动括号大小", "\\big"],
      ["\\Big", "更大括号", "\\Big"],
      ["\\bigg", "很大括号", "\\bigg"],
      ["\\Bigg", "超大括号", "\\Bigg"],
      ["\\bigl", "左大括号", "\\bigl"],
      ["\\bigr", "右大括号", "\\bigr"],
      ["\\Bigl", "左更大括号", "\\Bigl"],
      ["\\Bigr", "右更大括号", "\\Bigr"],
      ["\\biggl", "左很大括号", "\\biggl"],
      ["\\biggr", "右很大括号", "\\biggr"],
      ["\\Biggl", "左超大括号", "\\Biggl"],
      ["\\Biggr", "右超大括号", "\\Biggr"],
    ],
    "括号与分隔符",
  ),

  ...byEntries(
    [
      ["\\dots", "…", "省略号 …"],
      ["\\ldots", "…", "低位省略 …"],
      ["\\cdots", "⋯", "居中省略 ⋯"],
      ["\\vdots", "⋮", "竖向省略 ⋮"],
      ["\\ddots", "⋱", "斜向省略 ⋱"],
      ["\\hbar", "ℏ"],
      ["\\imath", "ı"],
      ["\\jmath", "ȷ"],
      ["\\ell", "ℓ"],
      ["\\Re", "ℜ"],
      ["\\Im", "ℑ"],
      ["\\aleph", "ℵ"],
      ["\\wp", "℘"],
      ["\\mho", "℧"],
      ["\\partial", "∂"],
      ["\\prime", "′"],
      ["\\emptyset", "∅"],
      ["\\varnothing", "∅"],
      ["\\infty", "∞"],
      ["\\nabla", "∇"],
      ["\\triangle", "△"],
      ["\\Box", "□"],
      ["\\Diamond", "◊"],
      ["\\bot", "⊥"],
      ["\\top", "⊤"],
      ["\\angle", "∠"],
      ["\\measuredangle", "∡"],
      ["\\surd", "√"],
      ["\\diamondsuit", "♢"],
      ["\\heartsuit", "♡"],
      ["\\clubsuit", "♣"],
      ["\\spadesuit", "♠"],
      ["\\lnot", "¬"],
      ["\\neg", "¬"],
      ["\\flat", "♭"],
      ["\\natural", "♮"],
      ["\\sharp", "♯"],
      ["\\because", "∵"],
      ["\\therefore", "∴"],
      ["\\forall", "∀"],
      ["\\exists", "∃"],
      ["\\nexists", "∄"],
      ["\\S", "§"],
      ["\\checkmark", "✓"],
      ["\\degree", "°"],
    ],
    "其他符号",
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
      "exp",
      "ln",
      "log",
      "lg",
      "ker",
      "limsup",
      "liminf",
      "varlimsup",
      "varliminf",
      "sup",
      "inf",
      "max",
      "min",
      "argmax",
      "argmin",
      "det",
      "gcd",
      "Pr",
      "mod",
      "bmod",
      "pmod",
    ],
    "数学函数",
  ),

  ...byEntries(
    [
      ["\\frac", "分式", "\\frac{}{}"],
      ["\\dfrac", "展示分式", "\\dfrac{}{}"],
      ["\\tfrac", "行内分式", "\\tfrac{}{}"],
      ["\\cfrac", "连分式", "\\cfrac{}{}"],
      ["\\binom", "二项式", "\\binom{}{}"],
      ["\\dbinom", "展示二项式", "\\dbinom{}{}"],
      ["\\tbinom", "行内二项式", "\\tbinom{}{}"],
      ["\\sqrt", "平方根", "\\sqrt{}"],
      ["\\sqrtN", "n 次根", "\\sqrt[]{}"],
      ["\\lim", "极限", "\\lim_{}"],
      ["\\limto", "极限趋近", "\\lim_{x \\to }"],
      ["\\limits", "上下标置于上下", "\\limits"],
      ["\\nolimits", "上下标置于右侧", "\\nolimits"],
      ["\\logbase", "带底数对数", "\\log_{}"],
      ["\\derivative", "导数", "\\dfrac{d}{dx}"],
      ["\\partialDerivative", "偏导数", "\\dfrac{\\partial}{\\partial x}"],
      ["\\timeDerivative", "时间导数", "\\dot{}"],
      ["\\secondTimeDerivative", "二阶时间导数", "\\ddot{}"],
      ["\\diff", "微分 d", "\\,\\mathrm{d}"],
      ["\\substack", "多行上下标", "\\substack{\\\\}"],
      ["\\overset", "上标注释", "\\overset{}{}"],
      ["\\underset", "下标注释", "\\underset{}{}"],
    ],
    "常用模板",
  ),

  ...byEntries(
    [
      ["\\hat", "帽子", "\\hat{}"],
      ["\\check", "反帽子", "\\check{}"],
      ["\\tilde", "波浪号", "\\tilde{}"],
      ["\\acute", "锐音", "\\acute{}"],
      ["\\grave", "钝音", "\\grave{}"],
      ["\\breve", "短音", "\\breve{}"],
      ["\\bar", "横线", "\\bar{}"],
      ["\\vec", "向量箭头", "\\vec{}"],
      ["\\mathring", "圆圈重音", "\\mathring{}"],
      ["\\dot", "一点", "\\dot{}"],
      ["\\ddot", "两点", "\\ddot{}"],
      ["\\dddot", "三点", "\\dddot{}"],
      ["\\ddddot", "四点", "\\ddddot{}"],
      ["\\widehat", "宽帽子", "\\widehat{}"],
      ["\\widetilde", "宽波浪号", "\\widetilde{}"],
      ["\\overline", "上划线", "\\overline{}"],
      ["\\underline", "下划线", "\\underline{}"],
      ["\\overrightarrow", "上右箭头", "\\overrightarrow{}"],
      ["\\underrightarrow", "下右箭头", "\\underrightarrow{}"],
      ["\\overleftarrow", "上左箭头", "\\overleftarrow{}"],
      ["\\underleftarrow", "下左箭头", "\\underleftarrow{}"],
      ["\\overleftrightarrow", "上双向箭头", "\\overleftrightarrow{}"],
      ["\\underleftrightarrow", "下双向箭头", "\\underleftrightarrow{}"],
      ["\\overbrace", "上花括号", "\\overbrace{}^{}"],
      ["\\underbrace", "下花括号", "\\underbrace{}_{}"],
      ["\\overbracket", "上方括号", "\\overbracket{}^{}"],
      ["\\underbracket", "下方括号", "\\underbracket{}_{}"],
    ],
    "修饰符",
  ),

  ...byEntries(
    [
      ["\\mathrm", "正体", "\\mathrm{}"],
      ["\\mathbf", "粗体", "\\mathbf{}"],
      ["\\mathit", "斜体", "\\mathit{}"],
      ["\\mathnormal", "数学默认字体", "\\mathnormal{}"],
      ["\\mathsf", "无衬线", "\\mathsf{}"],
      ["\\mathtt", "等宽", "\\mathtt{}"],
      ["\\mathbb", "黑板粗体", "\\mathbb{}"],
      ["\\mathcal", "花体", "\\mathcal{}"],
      ["\\mathfrak", "哥特体", "\\mathfrak{}"],
      ["\\mathscr", "手写体", "\\mathscr{}"],
      ["\\boldsymbol", "粗符号", "\\boldsymbol{}"],
      ["\\bm", "粗符号", "\\bm{}"],
      ["\\operatorname", "自定义算子", "\\operatorname{}"],
      ["\\operatorname*", "可带 limits 算子", "\\operatorname*{}"],
      ["\\text", "普通文字", "\\text{}"],
      ["\\textbf", "文本粗体", "\\textbf{}"],
      ["\\textit", "文本斜体", "\\textit{}"],
      ["\\textrm", "文本罗马体", "\\textrm{}"],
      ["\\textsf", "文本无衬线", "\\textsf{}"],
      ["\\texttt", "文本等宽", "\\texttt{}"],
    ],
    "字体与文本",
  ),

  ...byEntries(
    [
      ["\\quad", "空格 1em"],
      ["\\qquad", "空格 2em"],
      ["\\,", "小空格"],
      ["\\:", "中等空格"],
      ["\\;", "大空格"],
      ["\\!", "负空格"],
      ["\\thinspace", "细空格"],
      ["\\medspace", "中空格"],
      ["\\thickspace", "厚空格"],
      ["\\negthinspace", "负细空格"],
      ["\\kern", "手动字距", "\\kern{}"],
      ["\\mkern", "数学字距", "\\mkern{}"],
      ["\\textstyle", "行内尺寸", "\\textstyle{}"],
      ["\\displaystyle", "行间尺寸", "\\displaystyle{}"],
      ["\\scriptstyle", "上下标尺寸", "\\scriptstyle{}"],
      ["\\scriptscriptstyle", "次级上下标尺寸", "\\scriptscriptstyle{}"],
      ["\\tiny", "极小字号", "\\tiny"],
      ["\\small", "小字号", "\\small"],
      ["\\large", "大字号", "\\large"],
      ["\\Large", "更大字号", "\\Large"],
      ["\\LARGE", "很大字号", "\\LARGE"],
      ["\\huge", "超大字号", "\\huge"],
      ["\\Huge", "巨大字号", "\\Huge"],
    ],
    "间距与尺寸",
  ),

  ...byEntries(
    [
      ["\\begin", "环境", "\\begin{}\n\n\\end{}"],
      ["\\matrix", "矩阵", "\\begin{matrix}\n  & \\\\\n  & \n\\end{matrix}"],
      ["\\pmatrix", "圆括号矩阵", "\\begin{pmatrix}\n  & \\\\\n  & \n\\end{pmatrix}"],
      ["\\bmatrix", "方括号矩阵", "\\begin{bmatrix}\n  & \\\\\n  & \n\\end{bmatrix}"],
      ["\\Bmatrix", "花括号矩阵", "\\begin{Bmatrix}\n  & \\\\\n  & \n\\end{Bmatrix}"],
      ["\\vmatrix", "行列式", "\\begin{vmatrix}\n  & \\\\\n  & \n\\end{vmatrix}"],
      ["\\Vmatrix", "双竖线矩阵", "\\begin{Vmatrix}\n  & \\\\\n  & \n\\end{Vmatrix}"],
      ["\\smallmatrix", "小矩阵", "\\begin{smallmatrix}\n  & \\\\\n  & \n\\end{smallmatrix}"],
      ["\\array", "数组", "\\begin{array}{cc}\n  & \\\\\n  & \n\\end{array}"],
      ["\\cases", "分段函数", "\\begin{cases}\n  , & \\text{} \\\\\n  , & \\text{}\n\\end{cases}"],
      ["\\aligned", "多行对齐", "\\begin{aligned}\n  &= \\\\\n  &= \n\\end{aligned}"],
      ["\\alignedat", "多列对齐", "\\begin{alignedat}{2}\n  & & & \\\\\n  & & & \n\\end{alignedat}"],
      ["\\gathered", "多行居中", "\\begin{gathered}\n  \\\\\n  \n\\end{gathered}"],
      ["\\equation", "编号公式", "\\begin{equation}\n  \n\\end{equation}"],
      ["\\equation*", "无编号公式", "\\begin{equation*}\n  \n\\end{equation*}"],
      ["\\align", "多行公式对齐", "\\begin{align}\n  &= \\\\\n  &= \n\\end{align}"],
      ["\\align*", "无编号多行对齐", "\\begin{align*}\n  &= \\\\\n  &= \n\\end{align*}"],
      ["\\gather", "多行公式居中", "\\begin{gather}\n  \\\\\n  \n\\end{gather}"],
      ["\\gather*", "无编号多行居中", "\\begin{gather*}\n  \\\\\n  \n\\end{gather*}"],
      ["\\split", "拆分公式", "\\begin{split}\n  &= \\\\\n  &= \n\\end{split}"],
      ["\\tag", "手动编号", "\\tag{}"],
      ["\\notag", "取消编号", "\\notag"],
      ["\\nonumber", "取消编号", "\\nonumber"],
    ],
    "环境",
  ),

  ...byEntries(
    [
      ["\\vecv", "三维列向量", "\\vec{v}=\\begin{pmatrix}x\\\\y\\\\z\\end{pmatrix}"],
      ["\\mat2", "2×2 矩阵", "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}"],
      ["\\mat3", "3×3 矩阵", "\\begin{pmatrix}a&b&c\\\\d&e&f\\\\g&h&i\\end{pmatrix}"],
      ["\\identity", "单位矩阵", "I_n"],
      ["\\zeroMatrix", "零矩阵", "\\mathbf{0}_{m\\times n}"],
      ["\\diag", "对角矩阵", "\\operatorname{diag}()"],
      ["\\rank", "矩阵秩", "\\operatorname{rank}()"],
      ["\\trace", "迹", "\\operatorname{tr}()"],
      ["\\detA", "行列式 det(A)", "\\det(A)"],
      ["\\transpose", "转置", "^{\\mathsf{T}}"],
      ["\\inverse", "逆矩阵", "^{-1}"],
      ["\\eigen", "特征方程", "A\\mathbf{x}=\\lambda\\mathbf{x}"],
      ["\\linearSystem", "线性方程组", "\\begin{cases}\na_1x+b_1y=c_1\\\\\na_2x+b_2y=c_2\n\\end{cases}"],
      ["\\matrixEquation", "矩阵方程 Ax=b", "\\begin{pmatrix}a_{11}&a_{12}\\\\a_{21}&a_{22}\\end{pmatrix}\\begin{pmatrix}x\\\\y\\end{pmatrix}=\\begin{pmatrix}b_1\\\\b_2\\end{pmatrix}"],
    ],
    "线性代数模板",
  ),

  ...byEntries(
    [
      ["\\mathbbR", "实数集 ℝ", "\\mathbb{R}"],
      ["\\mathbbN", "自然数集 ℕ", "\\mathbb{N}"],
      ["\\mathbbZ", "整数集 ℤ", "\\mathbb{Z}"],
      ["\\mathbbQ", "有理数集 ℚ", "\\mathbb{Q}"],
      ["\\mathbbC", "复数集 ℂ", "\\mathbb{C}"],
      ["\\RR", "实数集 ℝ", "\\mathbb{R}"],
      ["\\NN", "自然数集 ℕ", "\\mathbb{N}"],
      ["\\ZZ", "整数集 ℤ", "\\mathbb{Z}"],
      ["\\QQ", "有理数集 ℚ", "\\mathbb{Q}"],
      ["\\CC", "复数集 ℂ", "\\mathbb{C}"],
      ["\\set", "集合", "\\left\\{\\right\\}"],
      ["\\given", "条件概率竖线", "\\mid"],
      ["\\land", "∧", "逻辑与 ∧"],
      ["\\lor", "∨", "逻辑或 ∨"],
    ],
    "集合与逻辑",
  ),

  ...byEntries(
    [
      ["\\prob", "概率 P(A)", "P()"],
      ["\\expect", "期望 E[X]", "\\mathbb{E}[]"],
      ["\\variance", "方差 Var(X)", "\\operatorname{Var}()"],
      ["\\covariance", "协方差 Cov(X,Y)", "\\operatorname{Cov}(,)"],
      ["\\normal", "正态分布", "\\mathcal{N}(, )"],
      ["\\binomial", "二项分布", "\\operatorname{Bin}(, )"],
      ["\\poisson", "泊松分布", "\\operatorname{Poisson}()"],
      ["\\uniform", "均匀分布", "\\operatorname{U}(, )"],
    ],
    "概率统计模板",
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
      ["\\infy", "∞", "\\infty"],
      ["\\pd", "偏导 ∂", "\\partial"],
      ["\\grad", "梯度 ∇", "\\nabla"],
      ["\\ra", "→", "\\rightarrow"],
      ["\\la", "←", "\\leftarrow"],
      ["\\Ra", "⇒", "\\Rightarrow"],
      ["\\La", "⇐", "\\Leftarrow"],
      ["\\Lra", "⇔", "\\Leftrightarrow"],
      ["\\dx", "微分 dx", "\\,\\mathrm{d}x"],
      ["\\dy", "微分 dy", "\\,\\mathrm{d}y"],
      ["\\dt", "微分 dt", "\\,\\mathrm{d}t"],
    ],
    "快捷模板",
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
