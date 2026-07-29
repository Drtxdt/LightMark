import type { ExportTargetId } from "../types";
import {
  evaluateMarkdownMath,
  type MathDocumentEvaluation,
  type MathNumberingMode,
} from "./mathMarkdown";

export type MathExportFeature =
  | "basic-math"
  | "macros"
  | "mhchem"
  | "numbering"
  | "references"
  | "navigation";

export type MathExportCapability = "full" | "degraded" | "dependency" | "unsupported";
export type MathExportPreflightStatus = "full" | "degraded" | "blocked";

export interface MathExportIssue {
  feature: MathExportFeature | "diagnostic" | "dependency";
  capability: MathExportCapability;
  message: string;
  blocking: boolean;
}

export interface MathExportPreflight {
  target: ExportTargetId;
  status: MathExportPreflightStatus;
  features: MathExportFeature[];
  issues: MathExportIssue[];
  evaluation: MathDocumentEvaluation;
}

const nativeTargets = new Set<ExportTargetId>(["html", "htmlPlain", "pdf", "png"]);
const latexTargets = new Set<ExportTargetId>(["pdfPandoc", "latex"]);
const officeTargets = new Set<ExportTargetId>(["docx", "odt", "rtf", "epub"]);
const textTargets = new Set<ExportTargetId>([
  "mediawiki",
  "rst",
  "textile",
  "opml",
  "revealjs",
  "markdownSpec",
  "customPandoc",
]);

export function analyzeMathExportCompatibility(
  markdown: string,
  target: ExportTargetId,
  numberingMode: MathNumberingMode = "none",
): MathExportPreflight {
  const evaluation = evaluateMarkdownMath(markdown, { numberingMode });
  const features = detectMathExportFeatures(evaluation);
  const issues: MathExportIssue[] = [];

  if (evaluation.entries.length > 0 && !nativeTargets.has(target)) {
    issues.push({
      feature: "dependency",
      capability: "dependency",
      message: latexTargets.has(target)
        ? "此格式依赖 Pandoc；PDF 还依赖可用的 LaTeX 引擎。"
        : "此格式依赖 Pandoc，最终数学表示由目标格式转换器决定。",
      blocking: false,
    });
  }

  if (officeTargets.has(target)) {
    if (features.includes("macros") || features.includes("mhchem")) {
      issues.push({
        feature: features.includes("mhchem") ? "mhchem" : "macros",
        capability: "degraded",
        message: "文档宏与化学公式在 Office/EPUB 中可能被转换为静态公式，需检查实际产物。",
        blocking: false,
      });
    }
    if (features.includes("navigation")) {
      issues.push({
        feature: "navigation",
        capability: "degraded",
        message: "公式编号和文字可保留，但文档内点击导航不保证可用。",
        blocking: false,
      });
    }
  }

  if (textTargets.has(target) && features.length > 0) {
    issues.push({
      feature: "basic-math",
      capability: "degraded",
      message: "目标文本格式可能保留公式源码或降级标记，无法保证 KaTeX 视觉效果。",
      blocking: false,
    });
    if (features.includes("navigation")) {
      issues.push({
        feature: "navigation",
        capability: "unsupported",
        message: "该目标格式不保证保留公式锚点与可点击引用。",
        blocking: false,
      });
    }
  }

  for (const diagnostic of evaluation.diagnostics) {
    const unresolvedReference = /未找到公式标签|公式引用不能为空|所在公式没有编号/.test(diagnostic.message);
    issues.push({
      feature: "diagnostic",
      capability: unresolvedReference ? "unsupported" : "degraded",
      message: `第 ${diagnostic.token?.line ?? 1} 行：${diagnostic.message}`,
      blocking: unresolvedReference,
    });
  }

  return {
    target,
    status: issues.some((issue) => issue.blocking)
      ? "blocked"
      : issues.some((issue) => issue.capability !== "full" && issue.feature !== "dependency")
        ? "degraded"
        : "full",
    features,
    issues,
    evaluation,
  };
}

export function detectMathExportFeatures(evaluation: MathDocumentEvaluation): MathExportFeature[] {
  const features: MathExportFeature[] = [];
  if (evaluation.entries.length > 0) features.push("basic-math");
  if (evaluation.macroNames.length > 0) features.push("macros");
  if (evaluation.usesMhchem) features.push("mhchem");
  if (evaluation.equations.some((equation) => Boolean(equation.display))) features.push("numbering");
  if (evaluation.references.length > 0) features.push("references");
  if (evaluation.references.some((reference) => Boolean(reference.targetId))) features.push("navigation");
  return features;
}

export function mathExportStatusLabel(status: MathExportPreflightStatus) {
  if (status === "blocked") return "需修复";
  if (status === "degraded") return "可能降级";
  return "兼容";
}
