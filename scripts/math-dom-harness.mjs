class TestClassList {
  values = new Set();
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
}

export class TestElement {
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
    if (!this.children.length) return;
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
  append(...children) { children.forEach((child) => this.appendChild(child)); }
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

export function installMathDomHarness() {
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
    documentElement: { style: {} },
    body: new TestElement(),
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
    createComment: (text) => ({ nodeType: 8, textContent: text, parentNode: null }),
    createElementNS: (_namespace, tagName) => {
      const element = new TestElement();
      element.tagName = tagName.toUpperCase();
      element.ownerDocument = globalThis.document;
      return element;
    },
  };
  globalThis.document.body.ownerDocument = globalThis.document;
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
  return {
    scheduledCallbacks,
    selectionState,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
      if (previousNodeFilter === undefined) delete globalThis.NodeFilter;
      else globalThis.NodeFilter = previousNodeFilter;
    },
  };
}
