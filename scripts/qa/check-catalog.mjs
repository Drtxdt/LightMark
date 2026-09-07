const SOURCE_CHECKS = new Set([
  "check-editor-boundaries.mjs",
  "check-editor-history.mjs",
  "check-export-preparation.mjs",
  "check-performance.mjs",
  "check-regression-closures.mjs",
]);

const ARTIFACT_CHECKS = new Set(["check-bundle-budget.mjs"]);

export const EXPLICIT_QA_GATES = Object.freeze([
  "qa/check-html-security-regression.mjs",
]);

export const CATEGORY_DESCRIPTIONS = Object.freeze({
  source: "源码结构/字符串契约门禁；不启动应用 UI",
  "state-logic": "状态或逻辑夹具门禁；按脚本自身范围运行",
  artifact: "已生成产物门禁；需要对应构建产物",
  "security-gate": "正式内容安全回归门禁；验证生产 renderer 的隔离能力边界",
});

export function classifyCheck(fileName) {
  if (EXPLICIT_QA_GATES.includes(fileName)) return "security-gate";
  if (SOURCE_CHECKS.has(fileName)) return "source";
  if (ARTIFACT_CHECKS.has(fileName)) return "artifact";
  return "state-logic";
}

export function categoryNote(fileName) {
  if (fileName === "check-performance.mjs") {
    return "静态性能架构契约；不测量 WebView/UI 时间、内存或帧率";
  }
  if (fileName === "check-bundle-budget.mjs") {
    return "读取 dist/index.html 与已生成 bundle；不负责构建产物";
  }
  return null;
}
