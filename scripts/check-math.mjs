import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Schema } from "@tiptap/pm/model";
import { history, redo, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { compileTypeScriptModuleGraph } from "./transpile-module-graph.mjs";

const tempDir = fs.mkdtempSync(path.resolve("scripts/.lightmark-math-"));
const originalDocument = globalThis.document;
const originalHTMLElement = globalThis.HTMLElement;
const originalElement = globalThis.Element;
const originalSVGElement = globalThis.SVGElement;

class BootstrapElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.ownerDocument = null;
    this.className = "";
    this.classList = { add() {}, remove() {}, contains() { return false; } };
    this.style = {};
    this.dataset = {};
    this.textContent = "";
  }
  appendChild(child) { child.parentNode = this; child.ownerDocument ||= this.ownerDocument; this.children.push(child); return child; }
  insertBefore(child, reference) {
    child.parentNode = this;
    child.ownerDocument ||= this.ownerDocument;
    const index = reference ? this.children.indexOf(reference) : -1;
    if (index < 0) this.children.push(child);
    else this.children.splice(index, 0, child);
    return child;
  }
  removeChild(child) { const index = this.children.indexOf(child); if (index >= 0) this.children.splice(index, 1); child.parentNode = null; return child; }
  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  querySelector() { return null; }
}

const bootstrapDocument = {
  compatMode: "CSS1Compat",
  createElement: (tagName) => new BootstrapElement(tagName),
  createElementNS: (_namespace, tagName) => new BootstrapElement(tagName),
  createTextNode: (text) => ({ nodeType: 3, textContent: text, parentNode: null }),
  createComment: (text) => ({ nodeType: 8, textContent: text, parentNode: null }),
  body: new BootstrapElement("body"),
  documentElement: new BootstrapElement("html"),
};
bootstrapDocument.body.ownerDocument = bootstrapDocument;
bootstrapDocument.documentElement.ownerDocument = bootstrapDocument;
globalThis.document = bootstrapDocument;
globalThis.HTMLElement = BootstrapElement;
globalThis.Element = BootstrapElement;
globalThis.SVGElement = BootstrapElement;

try {
  const compiled = compileTypeScriptModuleGraph(path.resolve("src/utils/mathMarkdown.ts"), tempDir);
  const {
    mathTokenFromParts,
    evaluateMarkdownMath,
    extractMathMacroDefinitions,
    parseMarkdownMath,
    preparePandocMath,
    renderMathToken,
    serializeMathToken,
    validateMathToken,
  } = await import(pathToFileURL(compiled).href);
  const compiledIncremental = compileTypeScriptModuleGraph(
    path.resolve("src/editor/mathDiagnosticsIncremental.ts"),
    tempDir,
  );
  const { IncrementalMathDiagnostics } = await import(pathToFileURL(compiledIncremental).href);
  const compiledMathNodes = compileTypeScriptModuleGraph(path.resolve("src/extensions/MathNodes.ts"), tempDir);
  const {
    BlockMath,
    InlineMath,
    finalizePendingMathForClosePrompt,
    flushPendingMathEdits,
    hasPendingMathEdits,
    getPendingMathInputVersion,
    getPendingMathEditVersion,
    resolveMathBlurDecision,
    resolveMathContentUpdate,
  } = await import(pathToFileURL(compiledMathNodes).href);
  const compiledLatexSuggest = compileTypeScriptModuleGraph(path.resolve("src/extensions/LatexSuggest.ts"), tempDir);
  const { createLatexSuggestController } = await import(pathToFileURL(compiledLatexSuggest).href);

  const mathSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { content: "inline*", group: "block" },
      blockMath: {
        group: "block",
        atom: true,
        defining: true,
        attrs: {
          tex: { default: "" },
          delimiter: { default: "display-dollar" },
          raw: { default: "" },
          originalTex: { default: "" },
          displayMode: { default: true },
          editing: { default: false },
        },
      },
      text: { group: "inline" },
      codeBlock: { content: "text*", group: "block", code: true },
      bulletList: { content: "listItem+", group: "block" },
      listItem: { content: "paragraph+" },
      table: { content: "tableRow+", group: "block" },
      tableRow: { content: "tableCell+" },
      tableCell: { content: "block+" },
      inlineMath: {
        group: "inline",
        inline: true,
        atom: true,
        selectable: true,
        attrs: {
          tex: { default: "" },
          delimiter: { default: "inline-dollar" },
          raw: { default: "" },
          originalTex: { default: "" },
          displayMode: { default: false },
          editing: { default: false },
        },
      },
      image: {
        group: "inline",
        inline: true,
        atom: true,
        selectable: true,
        attrs: { src: { default: "" } },
      },
      hardBreak: { group: "inline", inline: true, atom: true, selectable: false },
    },
    marks: {
      code: { code: true },
      strong: {},
    },
  });
  const inlineMathPlugin = InlineMath.config.addProseMirrorPlugins.call({
    type: mathSchema.nodes.inlineMath,
  })[0];
  const blockMathPlugin = BlockMath.config.addProseMirrorPlugins.call({
    type: mathSchema.nodes.blockMath,
  })[0];

  const mathNode = (tex, editing = false) => mathSchema.nodes.inlineMath.create({
    tex,
    delimiter: "inline-dollar",
    raw: `$${tex}$`,
    originalTex: tex,
    displayMode: false,
    editing,
  });
  const firstTextblockEnd = (doc) => {
    let end;
    doc.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      end = pos + 1 + node.content.size;
      return false;
    });
    assert.notEqual(end, undefined, "test document must contain a textblock");
    return end;
  };
  const applyTextAndMath = (doc, position, text, withHistory = false) => {
    const state = EditorState.create({
      schema: mathSchema,
      doc,
      selection: TextSelection.create(doc, position),
      plugins: withHistory ? [history(), inlineMathPlugin] : [inlineMathPlugin],
    });
    return state.applyTransaction(state.tr.insertText(text, position)).state;
  };
  const appendTextAndApplyMath = (doc, text, withHistory = false) => {
    return applyTextAndMath(doc, firstTextblockEnd(doc), text, withHistory);
  };

  const inlineMathBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.paragraph.create(null, [
      mathSchema.text("A "),
      mathNode("x"),
      mathSchema.text(" B"),
    ]),
  ]);
  const inlineMathAfterAppend = appendTextAndApplyMath(inlineMathBaseline, " $y$");
  assert.deepEqual(
    inlineMathAfterAppend.doc.child(0).toJSON().content.map((node) => ({
      type: node.type,
      text: node.text,
      tex: node.attrs?.tex,
    })),
    [
      { type: "text", text: "A ", tex: undefined },
      { type: "inlineMath", text: undefined, tex: "x" },
      { type: "text", text: " B ", tex: undefined },
      { type: "inlineMath", text: undefined, tex: "y" },
    ],
    "inline math after an existing atom must replace the exact PM range",
  );

  const multipleMathBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.paragraph.create(null, [
      mathSchema.text("A "),
      mathNode("x"),
      mathSchema.text(" B "),
      mathNode("z"),
      mathSchema.text(" C"),
    ]),
  ]);
  const multipleMathAfterAppend = appendTextAndApplyMath(multipleMathBaseline, " $y$");
  assert.deepEqual(
    multipleMathAfterAppend.doc.child(0).toJSON().content.map((node) => ({
      type: node.type,
      text: node.text,
      tex: node.attrs?.tex,
    })),
    [
      { type: "text", text: "A ", tex: undefined },
      { type: "inlineMath", text: undefined, tex: "x" },
      { type: "text", text: " B ", tex: undefined },
      { type: "inlineMath", text: undefined, tex: "z" },
      { type: "text", text: " C ", tex: undefined },
      { type: "inlineMath", text: undefined, tex: "y" },
    ],
    "the PM offset must include every preceding inline math atom",
  );

  const imageBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.paragraph.create(null, [
      mathSchema.text("before "),
      mathSchema.nodes.image.create({ src: "image.png" }),
      mathSchema.text(" tail"),
    ]),
  ]);
  const imageAfterAppend = appendTextAndApplyMath(imageBaseline, " $y$");
  assert.equal(imageAfterAppend.doc.child(0).child(1).type.name, "image");
  assert.equal(imageAfterAppend.doc.child(0).child(2).text, " tail ");
  assert.equal(imageAfterAppend.doc.child(0).child(3).attrs.tex, "y");

  const hardBreakBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.paragraph.create(null, [
      mathSchema.text("before"),
      mathSchema.nodes.hardBreak.create(),
      mathSchema.text(" tail"),
    ]),
  ]);
  const hardBreakAfterAppend = appendTextAndApplyMath(hardBreakBaseline, " $y$");
  assert.equal(hardBreakAfterAppend.doc.child(0).child(1).type.name, "hardBreak");
  assert.equal(hardBreakAfterAppend.doc.child(0).child(3).attrs.tex, "y");

  const strongMark = mathSchema.marks.strong.create();
  const markedBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.paragraph.create(null, [
      mathSchema.text("marked ", [strongMark]),
      mathSchema.text("tail"),
    ]),
  ]);
  const markedAfterAppend = appendTextAndApplyMath(markedBaseline, " $y$");
  assert.equal(markedAfterAppend.doc.child(0).child(0).text, "marked ");
  assert.equal(markedAfterAppend.doc.child(0).child(0).marks[0].type.name, "strong");
  assert.equal(markedAfterAppend.doc.child(0).child(1).text, "tail ");
  assert.equal(markedAfterAppend.doc.child(0).child(2).attrs.tex, "y");

  const codeMark = mathSchema.marks.code.create();
  const codeMarkedBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.paragraph.create(null, [
      mathSchema.text("$code$", [codeMark]),
      mathSchema.text(" $ok$"),
    ]),
  ]);
  const codeMarkedAfterAppend = appendTextAndApplyMath(codeMarkedBaseline, "!");
  assert.equal(codeMarkedAfterAppend.doc.child(0).child(0).text, "$code$");
  assert.equal(codeMarkedAfterAppend.doc.child(0).child(0).marks[0].type.name, "code");
  assert.equal(codeMarkedAfterAppend.doc.child(0).child(1).text, " ");
  assert.equal(codeMarkedAfterAppend.doc.child(0).child(2).attrs.tex, "ok");
  assert.equal(codeMarkedAfterAppend.doc.child(0).child(3).text, "!");

  const codeBlockBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.codeBlock.create(null, mathSchema.text("$code$")),
  ]);
  const codeBlockAfterAppend = appendTextAndApplyMath(codeBlockBaseline, "!");
  assert.equal(codeBlockAfterAppend.doc.child(0).type.name, "codeBlock");
  assert.equal(codeBlockAfterAppend.doc.child(0).textContent, "$code$!");

  const listBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.bulletList.create(null, [
      mathSchema.nodes.listItem.create(null, [
        mathSchema.nodes.paragraph.create(null, [mathSchema.text("item "), mathNode("x"), mathSchema.text(" tail")]),
      ]),
    ]),
  ]);
  const listAfterAppend = appendTextAndApplyMath(listBaseline, " $y$");
  const listParagraph = listAfterAppend.doc.child(0).child(0).child(0);
  assert.equal(listParagraph.child(1).attrs.tex, "x");
  assert.equal(listParagraph.child(2).text, " tail ");
  assert.equal(listParagraph.child(3).attrs.tex, "y");

  const tableBaseline = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.table.create(null, [
      mathSchema.nodes.tableRow.create(null, [
        mathSchema.nodes.tableCell.create(null, [
          mathSchema.nodes.paragraph.create(null, [
            mathSchema.text("cell "),
            mathSchema.nodes.image.create({ src: "cell.png" }),
            mathSchema.text(" tail"),
          ]),
        ]),
      ]),
    ]),
  ]);
  const tableAfterAppend = appendTextAndApplyMath(tableBaseline, " $y$");
  const tableParagraph = tableAfterAppend.doc.child(0).child(0).child(0).child(0);
  assert.equal(tableParagraph.child(1).type.name, "image");
  assert.equal(tableParagraph.child(2).text, " tail ");
  assert.equal(tableParagraph.child(3).attrs.tex, "y");

  const historyAfterAppend = appendTextAndApplyMath(inlineMathBaseline, " $y$", true);
  let historyAfterUndo;
  assert.equal(undo(historyAfterAppend, (transaction) => {
    historyAfterUndo = historyAfterAppend.apply(transaction);
  }), true);
  assert.deepEqual(historyAfterUndo.doc.toJSON(), inlineMathBaseline.toJSON(), "undo must restore the exact pre-insert document");
  let historyAfterRedo;
  assert.equal(redo(historyAfterUndo, (transaction) => {
    historyAfterRedo = historyAfterUndo.apply(transaction);
  }), true);
  assert.deepEqual(historyAfterRedo.doc.toJSON(), historyAfterAppend.doc.toJSON(), "redo must restore the exact converted formula");

  const blockOpeningDoc = mathSchema.nodes.doc.create(null, [
    mathSchema.nodes.paragraph.create(null, [mathSchema.text("$$")]),
  ]);
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => {};
  const blockOpeningState = EditorState.create({
    schema: mathSchema,
    doc: blockOpeningDoc,
    selection: TextSelection.create(blockOpeningDoc, firstTextblockEnd(blockOpeningDoc)),
    plugins: [blockMathPlugin],
  });
  let blockDispatch;
  let blockPrevented = false;
  const blockView = {
    state: blockOpeningState,
    dom: { querySelector: () => null },
    dispatch(transaction) {
      blockDispatch = transaction;
    },
  };
  const composingEnter = {
    key: "Enter",
    isComposing: true,
    keyCode: 229,
    preventDefault() { blockPrevented = true; },
  };
  assert.equal(
    blockMathPlugin.props.handleKeyDown(blockView, composingEnter),
    false,
    "block math opening must not consume Enter during IME composition",
  );
  assert.equal(blockPrevented, false, "IME Enter must not be prevented by block math conversion");
  assert.equal(blockDispatch, undefined, "IME Enter must not replace the opening delimiter paragraph");

  const normalEnter = {
    key: "Enter",
    isComposing: false,
    keyCode: 13,
    preventDefault() { blockPrevented = true; },
  };
  assert.equal(
    blockMathPlugin.props.handleKeyDown(blockView, normalEnter),
    true,
    "a completed block math opening must still convert on Enter",
  );
  assert.equal(blockPrevented, true, "completed block math conversion must prevent the native Enter");
  assert.equal(blockDispatch?.doc.child(0).type.name, "blockMath", "completed Enter must insert a block math node");
  if (previousRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
  else globalThis.requestAnimationFrame = previousRequestAnimationFrame;

  const acceptedMathAttrs = {
    tex: "x",
    delimiter: "inline-dollar",
    raw: "$x$",
    originalTex: "x",
    displayMode: false,
  };
  const localMathAttrs = { ...acceptedMathAttrs, tex: "xy", raw: "" };
  const incomingMathAttrs = { ...acceptedMathAttrs, tex: "z", raw: "$z$" };
  assert.equal(
    resolveMathContentUpdate({ editing: true, local: localMathAttrs, accepted: acceptedMathAttrs, incoming: acceptedMathAttrs }),
    "preserve-local",
    "an unchanged incoming base must preserve a locally edited formula",
  );
  assert.equal(
    resolveMathContentUpdate({ editing: true, local: localMathAttrs, accepted: acceptedMathAttrs, incoming: localMathAttrs }),
    "ack-local",
    "an incoming node equal to the local buffer must acknowledge without closing the editor",
  );
  assert.equal(
    resolveMathContentUpdate({ editing: true, local: acceptedMathAttrs, accepted: acceptedMathAttrs, incoming: incomingMathAttrs }),
    "accept-incoming",
    "an unedited local buffer must accept an external incoming update",
  );
  assert.equal(
    resolveMathContentUpdate({ editing: true, local: localMathAttrs, accepted: acceptedMathAttrs, incoming: incomingMathAttrs }),
    "conflict",
    "different local and incoming edits must remain an explicit conflict",
  );
  assert.equal(
    resolveMathBlurDecision({ composing: true, blurPending: true, sourceConnected: true, activeInside: false }),
    "defer-composition",
    "blur during composition must defer without committing intermediate text",
  );
  assert.equal(
    resolveMathBlurDecision({ composing: false, blurPending: true, sourceConnected: true, activeInside: false }),
    "commit",
    "a completed composition may commit after focus leaves the editor",
  );
  assert.equal(
    resolveMathBlurDecision({ composing: false, blurPending: true, sourceConnected: true, activeInside: true }),
    "keep-editing",
    "focus moving to formula tools must keep the editor alive",
  );
  assert.equal(
    resolveMathBlurDecision({ composing: false, blurPending: true, sourceConnected: false, activeInside: false }),
    "wait-source",
    "a detached editor must not commit while its NodeView lifecycle is unresolved",
  );

  class TestClassList {
    values = new Set();
    add(...names) { names.forEach((name) => this.values.add(name)); }
    remove(...names) { names.forEach((name) => this.values.delete(name)); }
    contains(name) { return this.values.has(name); }
  }
  class TestElement {
    children = [];
    classList = new TestClassList();
    className = "";
    parentNode = null;
    parentElement = null;
    ownerDocument = null;
    nodeType = 1;
    tagName = "SPAN";
    _innerHTML = "";
    textContent = "";
    isConnected = true;
    style = { setProperty() {} };
    dataset = {};
    listeners = new Map();
    get innerHTML() { return this._innerHTML; }
    set innerHTML(value) {
      this._innerHTML = String(value ?? "");
      for (const child of this.children) {
        child.parentNode = null;
        child.parentElement = null;
        child.isConnected = false;
      }
      this.children = [];
    }
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this;
      child.ownerDocument ||= this.ownerDocument;
      this.children.push(child);
      return child;
    }
    insertBefore(child, reference) {
      child.parentNode = this;
      child.parentElement = this;
      child.ownerDocument ||= this.ownerDocument;
      const index = reference ? this.children.indexOf(reference) : -1;
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      return child;
    }
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parentNode = null;
      child.parentElement = null;
      child.isConnected = false;
      return child;
    }
    append(...children) {
      children.forEach((child) => this.appendChild(child));
    }
    remove() {
      this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
      this.parentElement = null;
      this.isConnected = false;
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    dispatchEvent(event) {
      event.target ||= this;
      for (const listener of this.listeners.get(event.type) ?? []) listener(event);
      return true;
    }
    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      this.listeners.set(type, listeners.filter((candidate) => candidate !== listener));
    }
    removeAttribute() {}
    setAttribute() {}
    focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
    contains(node) {
      if (node === this) return true;
      let current = node?.parentNode;
      while (current) {
        if (current === this) return true;
        current = current.parentNode;
      }
      return false;
    }
    getBoundingClientRect() { return { left: 0, width: 100 }; }
    querySelector(selector) {
      const classSelector = selector.replace(/^:scope > /, "").match(/^\.([^ ]+)$/)?.[1];
      if (!classSelector) return null;
      return this.children.find((child) => child.className.includes(classSelector)) ?? null;
    }
    scrollIntoView() {}
  }
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousNodeFilter = globalThis.NodeFilter;
  const scheduledCallbacks = [];
  const selectionState = {
    ranges: [],
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    get rangeCount() { return this.ranges.length; },
    removeAllRanges() {
      this.ranges.length = 0;
      this.anchorNode = null;
      this.focusNode = null;
      this.anchorOffset = 0;
      this.focusOffset = 0;
    },
    addRange(range) {
      this.ranges = [range];
      this.anchorNode = range.startContainer;
      this.anchorOffset = range.startOffset;
      this.focusNode = range.endContainer;
      this.focusOffset = range.endOffset;
    },
    extend(node, offset) {
      const range = globalThis.document.createRange();
      range.setStart(this.anchorNode, this.anchorOffset);
      range.setEnd(node, offset);
      this.ranges = [range];
      this.focusNode = node;
      this.focusOffset = offset;
    },
    getRangeAt(index) { return this.ranges[index] ?? null; },
  };
  globalThis.document = {
    compatMode: "CSS1Compat",
    activeElement: null,
    createElement: (tagName) => {
      const element = new TestElement();
      element.tagName = tagName.toUpperCase();
      element.ownerDocument = globalThis.document;
      return element;
    },
    createRange: () => {
      const range = {
        startContainer: null,
        startOffset: 0,
        endContainer: null,
        endOffset: 0,
        selectNodeContents(element) {
          const text = { nodeType: 3, textContent: element.textContent || "", parentNode: element };
          this.startContainer = text;
          this.startOffset = 0;
          this.endContainer = text;
          this.endOffset = text.textContent.length;
        },
        collapse(toStart) {
          if (toStart) {
            this.endContainer = this.startContainer;
            this.endOffset = this.startOffset;
          } else {
            this.startContainer = this.endContainer;
            this.startOffset = this.endOffset;
          }
        },
        setStart(container, offset) {
          this.startContainer = container;
          this.startOffset = offset;
        },
        setEnd(container, offset) {
          this.endContainer = container;
          this.endOffset = offset;
        },
        cloneRange() {
          const clone = globalThis.document.createRange();
          clone.startContainer = this.startContainer;
          clone.startOffset = this.startOffset;
          clone.endContainer = this.endContainer;
          clone.endOffset = this.endOffset;
          return clone;
        },
        toString() {
          const text = this.startContainer?.textContent || "";
          if (this.startContainer !== this.endContainer) return text;
          return text.slice(this.startOffset, this.endOffset);
        },
      };
      return range;
    },
    createTreeWalker: (element) => {
      let visited = false;
      const text = { nodeType: 3, textContent: element.textContent || "", parentNode: element };
      return { nextNode: () => (visited ? null : (visited = true, text)) };
    },
    createTextNode: (text) => {
      const node = new TestElement();
      node.nodeType = 3;
      node.textContent = text;
      return node;
    },
  };
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.window = {
    addEventListener() {},
    dispatchEvent() {},
    setTimeout: (callback) => {
      scheduledCallbacks.push({ callback, canceled: false });
      return scheduledCallbacks.length;
    },
    clearTimeout: (id) => {
      const scheduled = scheduledCallbacks[id - 1];
      if (scheduled) scheduled.canceled = true;
    },
    requestAnimationFrame: (callback) => callback(),
    getSelection: () => selectionState,
  };
  try {
    let suggestionValue = "\\alp";
    let suggestionCaret = suggestionValue.length;
    const suggestionTarget = {
      host: new TestElement(),
      anchor: new TestElement(),
      getValue: () => suggestionValue,
      setValue: (value) => { suggestionValue = value; },
      getCaret: () => suggestionCaret,
      setCaret: (position) => { suggestionCaret = position; },
      focus: () => {},
      onChange: () => {},
    };
    const suggestionController = createLatexSuggestController(suggestionTarget);
    suggestionController.sync();
    const composingEnter = {
      key: "Enter",
      isComposing: true,
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    assert.equal(
      suggestionController.handleKeyDown(composingEnter),
      false,
      "completion must not consume Enter while IME composition is active",
    );
    assert.equal(composingEnter.prevented, false);
    assert.equal(suggestionValue, "\\alp");
    const composingEscape = {
      key: "Escape",
      isComposing: true,
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    assert.equal(
      suggestionController.handleKeyDown(composingEscape),
      false,
      "completion must not consume Escape while IME composition is active",
    );
    assert.equal(composingEscape.prevented, false);
    const composingArrow = {
      key: "ArrowDown",
      isComposing: true,
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    assert.equal(
      suggestionController.handleKeyDown(composingArrow),
      false,
      "completion must not consume navigation keys while IME composition is active",
    );
    assert.equal(composingArrow.prevented, false);
    const pendingSyncArrow = {
      key: "ArrowRight",
      isComposing: false,
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    assert.equal(suggestionController.handleKeyDown(pendingSyncArrow), false);
    suggestionController.destroy();
    scheduledCallbacks.splice(0).forEach(({ callback, canceled }) => {
      if (!canceled) callback();
    });
    assert.equal(suggestionTarget.host.children.length, 0, "destroy must cancel deferred suggestion synchronization");

    const nodeViewFactory = InlineMath.config.addNodeView();
    const initialInlineNode = mathNode("x");
    const editorDoc = mathSchema.nodes.doc.create(null, [
      mathSchema.nodes.paragraph.create(null, [initialInlineNode]),
    ]);
    const nodeViewEditor = {
      view: {
        state: { doc: editorDoc },
        dispatch() {},
        focus() {},
      },
    };
    const nodeView = nodeViewFactory({
      node: initialInlineNode,
      editor: nodeViewEditor,
      getPos: () => 1,
    });
    const displayRegistrationVersion = getPendingMathEditVersion(nodeViewEditor);
    assert.ok(displayRegistrationVersion > 0, "a formula NodeView must register a pending-edit identity version");
    assert.equal(nodeView.dom.className, "math-node math-node-inline", "inline NodeView should render its display shell");
    assert.equal(hasPendingMathEdits(nodeViewEditor), false, "display-only NodeViews must not report pending math input");
    const updatedInlineNode = mathNode("y");
    nodeViewEditor.view.state.doc = mathSchema.nodes.doc.create(null, [
      mathSchema.nodes.paragraph.create(null, [updatedInlineNode]),
    ]);
    assert.equal(nodeView.update(updatedInlineNode), true, "NodeView must accept a same-type document update");
    nodeView.destroy();
    assert.ok(
      getPendingMathEditVersion(nodeViewEditor) > displayRegistrationVersion,
      "destroying a formula NodeView must advance its identity version",
    );

    const editableInlineNode = mathSchema.nodes.inlineMath.create({
      ...initialInlineNode.attrs,
      editing: true,
    });
    const editableEditorDoc = mathSchema.nodes.doc.create(null, [
      mathSchema.nodes.paragraph.create(null, [editableInlineNode]),
    ]);
    const editableTransactions = [];
    const editableNodeViewEditor = {
      view: {
        state: EditorState.create({ schema: mathSchema, doc: editableEditorDoc }),
        dispatch(transaction) {
          editableTransactions.push(transaction);
        },
        focus() {},
      },
    };
    const editableNodeView = nodeViewFactory({
      node: editableInlineNode,
      editor: editableNodeViewEditor,
      getPos: () => 1,
    });
    const sourceEditor = editableNodeView.dom.querySelector(".math-inline-source-editor");
    assert.ok(sourceEditor, "editing inline math must expose its source editor");
    const editableRegistrationVersion = getPendingMathEditVersion(editableNodeViewEditor);
    const editableInputVersion = getPendingMathInputVersion(editableNodeViewEditor);
    sourceEditor.textContent = "xy";
    sourceEditor.dispatchEvent({ type: "input" });
    const inputVersion = getPendingMathEditVersion(editableNodeViewEditor);
    assert.ok(inputVersion > editableRegistrationVersion, "formula input must advance the pending-edit version");
    assert.ok(
      getPendingMathInputVersion(editableNodeViewEditor) > editableInputVersion,
      "formula input must advance the local input version",
    );
    const inputVersionBeforeComposition = getPendingMathInputVersion(editableNodeViewEditor);
    sourceEditor.dispatchEvent({ type: "compositionstart" });
    const compositionStartVersion = getPendingMathEditVersion(editableNodeViewEditor);
    assert.ok(compositionStartVersion > inputVersion, "composition start must advance the pending-edit version");
    assert.equal(
      getPendingMathInputVersion(editableNodeViewEditor),
      inputVersionBeforeComposition,
      "composition lifecycle alone must not advance the local input version",
    );
    sourceEditor.textContent = "xyz";
    sourceEditor.dispatchEvent({ type: "input" });
    const inputVersionDuringComposition = getPendingMathInputVersion(editableNodeViewEditor);
    assert.ok(
      inputVersionDuringComposition > inputVersionBeforeComposition,
      "composition content input must advance the local input version",
    );
    sourceEditor.dispatchEvent({ type: "compositionend" });
    assert.ok(
      getPendingMathEditVersion(editableNodeViewEditor) > compositionStartVersion,
      "composition end must advance the pending-edit version",
    );
    assert.equal(
      getPendingMathInputVersion(editableNodeViewEditor),
      inputVersionDuringComposition,
      "composition end without a content change must not advance the local input version",
    );
    assert.equal(hasPendingMathEdits(editableNodeViewEditor), true, "uncommitted formula input must remain pending");
    await flushPendingMathEdits(editableNodeViewEditor, { flushId: "math-check-flush-1" });
    const flushTransaction = editableTransactions.at(-1);
    assert.ok(flushTransaction, "flushing pending formula input must dispatch a PM transaction");
    assert.equal(
      flushTransaction.getMeta("lightmarkPendingFlushId"),
      "math-check-flush-1",
      "a receipt-scoped formula flush must mark its PM transaction with the exact flush id",
    );
    assert.equal(
      getPendingMathInputVersion(editableNodeViewEditor),
      inputVersionDuringComposition,
      "committing a formula must not advance the local input version",
    );

    // A close prompt moves focus to native UI.  Exercise the production
    // NodeView with a real PM apply/update loop so the close-only finalizer
    // proves both the document transaction and the transient DOM lifecycle.
    const savedSelectionState = {
      ranges: selectionState.ranges,
      anchorNode: selectionState.anchorNode,
      anchorOffset: selectionState.anchorOffset,
      focusNode: selectionState.focusNode,
      focusOffset: selectionState.focusOffset,
    };
    const promptInitialNode = mathNode("prompt", true);
    const promptInitialDoc = mathSchema.nodes.doc.create(null, [
      mathSchema.nodes.paragraph.create(null, [promptInitialNode]),
    ]);
    const promptEditor = { view: null };
    let promptNodeView = null;
    const promptTransactions = [];
    const promptView = {
      state: EditorState.create({ schema: mathSchema, doc: promptInitialDoc, plugins: [inlineMathPlugin] }),
      dispatch(transaction) {
        const applied = promptView.state.applyTransaction(transaction);
        promptView.state = applied.state;
        promptTransactions.push(...applied.transactions);
        const nextNode = promptView.state.doc.nodeAt(1);
        if (promptNodeView && nextNode) promptNodeView.update(nextNode);
      },
      focus() {},
    };
    promptEditor.view = promptView;
    promptNodeView = nodeViewFactory({
      node: promptInitialNode,
      editor: promptEditor,
      getPos: () => 1,
    });
    const promptSource = promptNodeView.dom.querySelector(".math-inline-source-editor");
    assert.ok(promptSource, "close-prompt fixture must start in the formula source editor");
    promptSource.textContent = "prompt+1";
    promptSource.dispatchEvent({ type: "input" });
    assert.equal(hasPendingMathEdits(promptEditor), true);
    promptSource.dispatchEvent({ type: "compositionstart" });
    await assert.rejects(
      finalizePendingMathForClosePrompt(promptEditor, { flushId: "close-prompt-composing" }),
      /输入法组合尚未结束/,
      "close-prompt preparation must leave an unfinished IME composition untouched",
    );
    promptSource.dispatchEvent({ type: "compositionend" });
    await finalizePendingMathForClosePrompt(promptEditor, { flushId: "close-prompt-check" });
    assert.equal(hasPendingMathEdits(promptEditor), false, "close-prompt finalization must settle the real formula buffer");
    assert.equal(promptNodeView.dom.querySelector(".math-inline-source-editor"), null, "close-prompt finalization must close the source DOM");
    promptSource.dispatchEvent({ type: "blur" });
    assert.equal(hasPendingMathEdits(promptEditor), false, "a late dialog-focus blur must not reopen a finalized formula lifecycle");
    assert.equal(promptNodeView.dom.className, "math-node math-node-inline", "close-prompt finalization must render the display UI");
    assert.equal(promptView.state.doc.nodeAt(1)?.attrs.tex, "prompt+1");
    assert.equal(
      promptTransactions.at(-1)?.getMeta("lightmarkPendingFlushId"),
      "close-prompt-check",
      "close-prompt document reconciliation must carry the scoped flush id",
    );
    promptNodeView.destroy();
    selectionState.ranges = savedSelectionState.ranges;
    selectionState.anchorNode = savedSelectionState.anchorNode;
    selectionState.anchorOffset = savedSelectionState.anchorOffset;
    selectionState.focusNode = savedSelectionState.focusNode;
    selectionState.focusOffset = savedSelectionState.focusOffset;
    const restoredRange = document.createRange();
    restoredRange.setStart(sourceEditor, 1);
    restoredRange.collapse(true);
    selectionState.removeAllRanges();
    selectionState.addRange(restoredRange);

    const composingCtrlEnd = {
      type: "keydown",
      key: "End",
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      isComposing: true,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    sourceEditor.dispatchEvent(composingCtrlEnd);
    assert.equal(composingCtrlEnd.defaultPrevented, false, "composition must retain Ctrl+Shift+End for the IME");
    const processCtrlEnd = {
      type: "keydown",
      key: "End",
      keyCode: 229,
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    sourceEditor.dispatchEvent(processCtrlEnd);
    assert.equal(processCtrlEnd.defaultPrevented, false, "keyCode 229 must retain Ctrl+Shift+End for the IME");
    const ctrlShiftEnd = {
      type: "keydown",
      key: "End",
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    sourceEditor.dispatchEvent(ctrlShiftEnd);
    assert.equal(ctrlShiftEnd.defaultPrevented, true, "Ctrl+Shift+End must stay inside the inline math source editor");
    assert.equal(selectionState.anchorOffset, 1, "Ctrl+Shift+End must preserve the current DOM selection anchor");
    assert.equal(selectionState.focusOffset, sourceEditor.textContent.length, "Ctrl+Shift+End must extend focus to the source end");
    const ctrlHome = {
      type: "keydown",
      key: "Home",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    sourceEditor.dispatchEvent(ctrlHome);
    assert.equal(ctrlHome.defaultPrevented, true, "Ctrl+Home must stay inside the inline math source editor");
    assert.equal(selectionState.startOffset ?? selectionState.getRangeAt(0)?.startOffset, 0);
    const anchorRange = document.createRange();
    anchorRange.setStart(selectionState.anchorNode, 1);
    anchorRange.collapse(true);
    selectionState.removeAllRanges();
    selectionState.addRange(anchorRange);
    const ctrlShiftHome = {
      type: "keydown",
      key: "Home",
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    sourceEditor.dispatchEvent(ctrlShiftHome);
    assert.equal(ctrlShiftHome.defaultPrevented, true, "Ctrl+Shift+Home must stay inside the inline math source editor");
    assert.equal(selectionState.anchorOffset, 1, "Ctrl+Shift+Home must preserve the current DOM selection anchor");
    assert.equal(selectionState.focusOffset, 0, "Ctrl+Shift+Home must extend focus to the source start");
    const ctrlEnd = {
      type: "keydown",
      key: "End",
      ctrlKey: true,
      shiftKey: false,
      metaKey: false,
      isComposing: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    sourceEditor.dispatchEvent(ctrlEnd);
    assert.equal(ctrlEnd.defaultPrevented, true, "Ctrl+End must stay inside the inline math source editor");
    assert.equal(
      selectionState.getRangeAt(0)?.startOffset,
      sourceEditor.textContent.length,
      "Ctrl+End must place the DOM caret at the end of the formula source",
    );
    const caretOffset = selectionState.getRangeAt(0)?.startOffset ?? 0;
    sourceEditor.textContent = `${sourceEditor.textContent.slice(0, caretOffset)}a${sourceEditor.textContent.slice(caretOffset)}`;
    sourceEditor.dispatchEvent({ type: "input" });
    assert.equal(sourceEditor.textContent, "xyza", "typing after Ctrl+End must append inside the formula source");

    const normalTransactions = [];
    const normalNode = mathSchema.nodes.inlineMath.create({
      ...initialInlineNode.attrs,
      editing: true,
    });
    const normalEditorDoc = mathSchema.nodes.doc.create(null, [
      mathSchema.nodes.paragraph.create(null, [normalNode]),
    ]);
    const normalNodeViewEditor = {
      view: {
        state: EditorState.create({ schema: mathSchema, doc: normalEditorDoc }),
        dispatch(transaction) {
          normalTransactions.push(transaction);
        },
        focus() {},
      },
    };
    const normalNodeView = nodeViewFactory({
      node: normalNode,
      editor: normalNodeViewEditor,
      getPos: () => 1,
    });
    const normalSourceEditor = normalNodeView.dom.querySelector(".math-inline-source-editor");
    assert.ok(normalSourceEditor, "normal formula commit must expose its source editor");
    normalSourceEditor.textContent = "normal";
    normalSourceEditor.dispatchEvent({ type: "input" });
    normalSourceEditor.dispatchEvent({
      type: "keydown",
      key: "Escape",
      isComposing: false,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
    });
    assert.equal(
      normalTransactions.at(-1)?.getMeta("lightmarkPendingFlushId"),
      undefined,
      "ordinary Escape commit must not borrow a receipt flush id",
    );
    normalNodeView.destroy();

    const beforeDestroyVersion = getPendingMathEditVersion(editableNodeViewEditor);
    editableNodeView.destroy();
    assert.ok(
      getPendingMathEditVersion(editableNodeViewEditor) > beforeDestroyVersion,
      "destroying a formula with a pending buffer must advance the pending version",
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousNodeFilter === undefined) delete globalThis.NodeFilter;
    else globalThis.NodeFilter = previousNodeFilter;
  }

  const publicEvaluation = (source) => {
    const evaluation = evaluateMarkdownMath(source, { numberingMode: "none" });
    return {
      diagnostics: evaluation.diagnostics.map(({ from, to, message }) => ({ from, to, message })),
      references: evaluation.references.map(({ from, to, key, targetId }) => ({ from, to, key, targetId })),
      equations: evaluation.equations.map(({ id, tokenIndex, line, display }) => ({ id, tokenIndex, line, display })),
    };
  };
  const incremental = new IncrementalMathDiagnostics();
  let incrementalSource = "intro\nplain $x$ text\n$$\ny^2\n$$\noutro";
  incremental.reset(incrementalSource, "none");
  assert.equal(incremental.evaluate().strategy, "full");

  incremental.applyChanges([{ from: 0, to: 0, insert: "extra\n" }], "none");
  incrementalSource = `extra\n${incrementalSource}`;
  const mappedMath = incremental.evaluate();
  assert.equal(mappedMath.strategy, "mapped", "plain prose edits should only map cached math ranges");
  assert.deepEqual(
    { diagnostics: mappedMath.diagnostics, references: mappedMath.references, equations: mappedMath.equations },
    publicEvaluation(incrementalSource),
  );

  const formulaInsert = incrementalSource.indexOf("$x$") + 2;
  incremental.applyChanges([{ from: formulaInsert, to: formulaInsert, insert: "+1" }], "none");
  incrementalSource = `${incrementalSource.slice(0, formulaInsert)}+1${incrementalSource.slice(formulaInsert)}`;
  const localMath = incremental.evaluate();
  assert.equal(localMath.strategy, "formula", "an ordinary formula edit should only evaluate that formula");
  assert.deepEqual(
    { diagnostics: localMath.diagnostics, references: localMath.references, equations: localMath.equations },
    publicEvaluation(incrementalSource),
  );

  incremental.applyChanges([{ from: 0, to: 0, insert: "$" }], "none");
  incrementalSource = `$${incrementalSource}`;
  assert.equal(incremental.evaluate().strategy, "full", "delimiter changes outside known formulas require a full rebuild");

  const inlineCases = [
    ["$x$", ["x"]],
    ["$ x$", []],
    ["$x $", []],
    ["$x$2", []],
    ["$20,000 and $30,000", []],
    ["USD $5", []],
    ["\\$x$", []],
    ["`$x$`", []],
    ["``$x$``", []],
    ["a $x\\$$ b", ["x\\$"]],
    ["a $$x$$ b", ["x"]],
    ["中文$x$正文", ["x"]],
    ["$5 and $x$", ["x"]],
    ["\\(a+b\\)", ["a+b"]],
  ];
  for (const [source, expected] of inlineCases) {
    assert.deepEqual(parseMarkdownMath(source).tokens.map((token) => token.tex), expected, source);
  }

  const protectedSource = [
    "---",
    "price: $5$",
    "---",
    "```md",
    "$code$",
    "```",
    "~~~",
    "$tilde$",
    "~~~",
    "<div>",
    "$html$",
    "</div>",
    "real $x$",
  ].join("\n");
  assert.deepEqual(parseMarkdownMath(protectedSource).tokens.map((token) => token.tex), ["x"]);

  const display = "$$\n  x + y  \n$$";
  const displayToken = parseMarkdownMath(display).tokens[0];
  assert.equal(displayToken.delimiter, "display-dollar");
  assert.equal(displayToken.tex, "  x + y  ");
  assert.equal(displayToken.raw, display);
  assert.equal(serializeMathToken(displayToken), display);

  const bracket = "\\[\r\nx^2\r\n\\]";
  const bracketToken = parseMarkdownMath(bracket).tokens[0];
  assert.equal(bracketToken.delimiter, "display-bracket");
  assert.equal(bracketToken.tex, "x^2");
  assert.equal(serializeMathToken(bracketToken), bracket);

  const environment = "\\begin{align}\na &= b\n\\end{align}";
  const environmentToken = parseMarkdownMath(environment).tokens[0];
  assert.equal(environmentToken.delimiter, "environment");
  assert.equal(environmentToken.tex, environment);

  const missing = parseMarkdownMath("before\n$$\nx + y");
  assert.equal(missing.tokens.length, 0);
  assert.match(missing.diagnostics[0].message, /缺少结束分隔符/);

  const valid = mathTokenFromParts({ tex: "\\frac{1}{2}", delimiter: "inline-dollar" });
  assert.equal(validateMathToken(valid), null);
  assert.equal(renderMathToken(valid).ok, true);

  const invalid = mathTokenFromParts({ tex: "\\frac{", delimiter: "inline-dollar" });
  const diagnostic = validateMathToken(invalid);
  assert.ok(diagnostic);
  assert.match(diagnostic.message, /^公式语法错误：/);
  assert.equal(renderMathToken(invalid).ok, false);

  const sequentialMacros = [
    "Before: $x \\in \\RR$",
    "$$",
    "\\newcommand{\\RR}{\\mathbb{R}}",
    "$$",
    "After: $x \\in \\RR$",
    "Argument: $\\def\\sq#1{#1^2}\\sq{y}$",
  ].join("\n");
  const macroEvaluation = evaluateMarkdownMath(sequentialMacros);
  assert.equal(macroEvaluation.entries.length, 4);
  assert.equal(macroEvaluation.entries[0].result.ok, false, "definition must not apply backwards");
  assert.equal(macroEvaluation.entries[1].result.ok, true);
  assert.equal(macroEvaluation.entries[1].definitionOnly, true);
  assert.deepEqual(macroEvaluation.entries[1].definedMacroNames, ["\\RR"]);
  assert.equal(macroEvaluation.entries[2].result.ok, true, "definition must apply to later math");
  assert.deepEqual(macroEvaluation.entries[2].availableMacroNames, ["\\RR"]);
  assert.equal(macroEvaluation.entries[3].result.ok, true, "argument macros work in the defining formula");
  assert.deepEqual(macroEvaluation.macroNames, ["\\RR", "\\sq"]);

  const invalidDefinition = evaluateMarkdownMath([
    "$\\newcommand{\\broken}[1]{#1$",
    "$\\broken{x}$",
  ].join("\n"));
  assert.equal(invalidDefinition.entries[0].result.ok, false);
  assert.equal(invalidDefinition.entries[1].result.ok, false, "invalid definitions must not poison later context");
  assert.ok(
    invalidDefinition.entries[0].diagnostic.to > invalidDefinition.entries[0].diagnostic.from,
    "end-of-input macro errors need a visible source range",
  );
  assert.deepEqual(invalidDefinition.macroNames, []);

  const isolated = evaluateMarkdownMath("$x \\in \\RR$");
  assert.equal(isolated.entries[0].result.ok, false, "document contexts must be isolated");

  const chemistry = evaluateMarkdownMath([
    "$\\ce{H2O}$",
    "$\\ce{2H2 + O2 -> 2H2O}$",
    "$\\ce{^{227}_{90}Th+}$",
    "$\\pu{1.23e4 J mol-1}$",
    "$\\ce{CH4 + 2 $\\left( O2 + 79/21 N2 \\right)$}$",
  ].join("\n"));
  assert.equal(chemistry.entries.every((entry) => entry.result.ok), true);
  assert.equal(chemistry.usesMhchem, true);
  assert.equal(
    chemistry.entries.at(-1).token.raw,
    "$\\ce{CH4 + 2 $\\left( O2 + 79/21 N2 \\right)$}$",
    "mhchem nested math dollars must not terminate the outer Markdown formula",
  );

  const recursive = evaluateMarkdownMath("$\\def\\loop{\\loop}\\loop$");
  assert.equal(recursive.entries[0].result.ok, false);
  assert.match(recursive.diagnostics[0].message, /expand|扩展|loop/i);

  assert.deepEqual(
    extractMathMacroDefinitions("\\def\\a#1{#1}\\gdef\\b{x}\\newcommand{\\cc}[2]{#1+#2}").map((item) => item.name),
    ["\\a", "\\b", "\\cc"],
  );

  const pandocPrepared = preparePandocMath([
    "$$",
    "\\newcommand{\\RR}{\\mathbb{R}}",
    "$$",
    "$x \\in \\RR$ and $\\ce{H2O}$",
  ].join("\n"));
  assert.match(pandocPrepared.markdown, /\\globaldefs=1\s+\\newcommand/);
  assert.match(pandocPrepared.latexHeader, /usepackage\[version=4\]\{mhchem\}/);
  assert.match(pandocPrepared.latexHeader, /providecommand\{\\pu\}\[1\]\{\\ce\{#1\}\}/);
  assert.deepEqual(pandocPrepared.macroNames, ["\\RR"]);

  const numbered = evaluateMarkdownMath([
    "$\\ref{later}$",
    "$$",
    "x=1\\label{first}",
    "$$",
    "$$",
    "y=2\\tag{A}\\label{later}",
    "$$",
    "$$",
    "z=3\\label{third}",
    "$$",
  ].join("\n"), { numberingMode: "all-display" });
  assert.deepEqual(numbered.equations.map((item) => item.display), ["1", "A", "3"]);
  assert.equal(numbered.references[0].display, "A", "forward references resolve in the second pass");
  assert.match(numbered.entries[0].result.html, /math-ref-link/);
  assert.match(numbered.entries[1].result.html, /tag/);
  assert.equal(numbered.labels.length, 3);

  const numberingOff = evaluateMarkdownMath("$$\nx=1\\label{x}\n$$");
  assert.equal(numberingOff.equations.length, 1);
  assert.equal(numberingOff.equations[0].display, "");
  assert.match(numberingOff.diagnostics[0].message, /没有编号/);

  const ams = evaluateMarkdownMath([
    "$$",
    "x=1",
    "$$",
    "\\begin{equation}",
    "y=2\\label{eq:y}",
    "\\end{equation}",
    "\\begin{align*}",
    "z&=3",
    "\\end{align*}",
  ].join("\n"), { numberingMode: "ams-block" });
  assert.deepEqual(ams.equations.map((item) => item.display), ["", "1", ""]);

  const duplicate = evaluateMarkdownMath([
    "$$",
    "x=1\\tag{X}\\label{dup}",
    "$$",
    "$$",
    "y=2\\tag{Y}\\label{dup}",
    "$$",
    "$\\ref{missing}$",
  ].join("\n"));
  assert.equal(duplicate.labels[1].duplicate, true);
  assert.match(duplicate.diagnostics.map((item) => item.message).join("\n"), /重复/);
  assert.match(duplicate.diagnostics.map((item) => item.message).join("\n"), /未找到/);

  const semanticEdges = evaluateMarkdownMath([
    "$\\label{inline}x$",
    "$$",
    "x=1\\tag{A}\\tag{B}\\label{}\\label{one}\\label{two}",
    "$$",
    "$\\ref{two}$",
  ].join("\n"));
  const semanticMessages = semanticEdges.diagnostics.map((item) => item.message).join("\n");
  assert.match(semanticMessages, /只能用于块级公式/);
  assert.match(semanticMessages, /只能包含一个/);
  assert.match(semanticMessages, /不能为空/);
  assert.equal(semanticEdges.references[0].display, "A");
  assert.deepEqual(semanticEdges.equations[0].labels, ["one", "two"]);

  const numberedPandoc = preparePandocMath("$$\nx=1\\label{x}\n$$\n$\\ref{x}$", {
    numberingMode: "all-display",
  });
  assert.match(numberedPandoc.markdown, /\\tag\{1\}/);
  assert.match(numberedPandoc.markdown, /\\label\{x\}/);
  assert.match(numberedPandoc.markdown, /\\ref\{x\}/);
  assert.throws(
    () => preparePandocMath("$\\ref{missing}$", { numberingMode: "all-display" }),
    /missing/,
  );

  assert.equal(
    serializeMathToken(
      mathTokenFromParts({ tex: "x", delimiter: "inline-paren", raw: "\\(x\\)" }),
      "y",
      false,
    ),
    "\\(y\\)",
  );

  const compiledMarkdown = compileTypeScriptModuleGraph(path.resolve("src/utils/markdown.ts"), tempDir);
  const { renderMarkdown, renderMarkdownForEditor } = await import(pathToFileURL(compiledMarkdown).href);
  assert.match(renderMarkdown("中文$x$正文"), /class="katex"/);
  assert.doesNotMatch(renderMarkdown("价格是 $20,000 and $30,000"), /class="katex"/);
  assert.doesNotMatch(renderMarkdown("`$x$`"), /class="katex"/);
  assert.match(renderMarkdown("错误 $\\frac{$"), /math-render-error/);
  const editorMath = renderMarkdownForEditor("before \\( a+b \\) after");
  assert.match(editorMath, /data-math-delimiter="inline-paren"/);
  assert.match(editorMath, /data-math-raw="\\\( a\+b \\\)"/);
  const escapedDollar = renderMarkdownForEditor("literal \\$x$ and formula $y$");
  assert.match(escapedDollar, /data-type="escaped-dollar"/);
  assert.match(escapedDollar, /data-raw="\\\$"/);
  assert.equal((escapedDollar.match(/data-type="inline-math"/g) || []).length, 1);

  const markdownSource = fs.readFileSync(path.resolve("src/utils/markdown.ts"), "utf8");
  const htmlSource = fs.readFileSync(path.resolve("src/utils/html.ts"), "utf8");
  const wysiwygSource = fs.readFileSync(path.resolve("src/components/editor/WysiwygEditor.vue"), "utf8");
  const sourceEditor = fs.readFileSync(path.resolve("src/components/editor/SourceEditor.vue"), "utf8");
  assert.doesNotMatch(markdownSource, /markdownItKatex|protectInlineMath|normalizeLatexMathDelimiters/);
  assert.match(markdownSource, /parseMarkdownMath/);
  assert.match(htmlSource, /parseInlineMathText/);
  assert.match(wysiwygSource, /serializeMathToken/);
  assert.match(wysiwygSource, /EscapedDollarNode/);
  assert.match(wysiwygSource, /LightMarkInlineCode/);
  assert.match(wysiwygSource, /LIGHTMARK_TURNDOWN_HTML_BLOCK/);
  assert.match(wysiwygSource, /InlineMath/);
  assert.match(sourceEditor, /cm-math-error/);
  assert.match(sourceEditor, /mathDiagnostics\.worker\.ts/);
  const mathWorkerSource = fs.readFileSync(path.resolve("src/workers/mathDiagnostics.worker.ts"), "utf8");
  assert.match(mathWorkerSource, /IncrementalMathDiagnostics/);
  const incrementalMathSource = fs.readFileSync(path.resolve("src/editor/mathDiagnosticsIncremental.ts"), "utf8");
  assert.match(incrementalMathSource, /strategy: "full" \| "mapped" \| "formula"/);
  assert.match(incrementalMathSource, /evaluateMarkdownMath\(fragment/);
  const mathNodeSource = fs.readFileSync(path.resolve("src/extensions/MathNodes.ts"), "utf8");
  const suggestSource = fs.readFileSync(path.resolve("src/extensions/LatexSuggest.ts"), "utf8");
  const exportSource = fs.readFileSync(path.resolve("src/utils/export.ts"), "utf8");
  const rustExportSource = fs.readFileSync(path.resolve("src-tauri/src/commands/export.rs"), "utf8");
  assert.match(mathNodeSource, /math-macro-definition/);
  assert.match(mathNodeSource, /availableMacroNames/);
  assert.match(mathNodeSource, /installEditingTools/);
  assert.match(mathNodeSource, /math-tools-block-editing/);
  assert.match(mathNodeSource, /math-tools-inline-editing/);
  assert.match(mathNodeSource, /--math-block-editor-bottom/);
  assert.match(mathNodeSource, /flushPendingMathEdits/);
  assert.match(mathNodeSource, /hasPendingMathEdits/);
  assert.match(mathNodeSource, /resolveMathBlurDecision/);
  assert.match(mathNodeSource, /exitToDocument\("after"\)/, "inline Enter and Escape must restore the document selection");
  assert.match(mathNodeSource, /compositionWaiters/, "snapshot flushing must wait for IME composition");
  assert.match(mathNodeSource, /isMathCompositionKey/);
  assert.doesNotMatch(mathNodeSource, /editing = true;\s*updateAttrs\(\{ editing: true \}\)/, "entering math edit mode must not create a content transaction");
  assert.match(mathNodeSource, /event\.key === "Enter" && \(event\.ctrlKey \|\| event\.metaKey\)/, "block math needs a Ctrl+Enter commit path");
  assert.doesNotMatch(mathNodeSource, /const refresh = \(\) => \{[\s\S]{0,500}updateAttrs\(\{ tex, raw: "", editing: true \}\)/, "block previews must not write every keystroke into the document model");
  assert.doesNotMatch(mathNodeSource, /editor\.on\("transaction"/);
  assert.match(suggestSource, /getAdditionalSuggestions/);
  assert.match(suggestSource, /event\.isComposing/);
  assert.match(suggestSource, /\\\\ce/);
  assert.match(exportSource, /preparePandocMath/);
  assert.match(rustExportSource, /pandoc_latex_header/);
  assert.match(rustExportSource, /lightmark-math-header/);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
  if (originalHTMLElement === undefined) delete globalThis.HTMLElement;
  else globalThis.HTMLElement = originalHTMLElement;
  if (originalElement === undefined) delete globalThis.Element;
  else globalThis.Element = originalElement;
  if (originalSVGElement === undefined) delete globalThis.SVGElement;
  else globalThis.SVGElement = originalSVGElement;
}

console.log("math checks passed");
