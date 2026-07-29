import { invoke } from "@tauri-apps/api/core";
import type { AppConfig, ExportTargetId } from "./types";
import { exportCurrentDocument, exportTargets } from "./utils/export";
import { analyzeMathExportCompatibility } from "./utils/mathExportCompatibility";
import type { MathNumberingMode } from "./utils/mathMarkdown";

export interface HeadlessExportPayload {
  request: {
    mode: "export" | "check";
    inputPath: string;
    outputPath?: string;
    target?: ExportTargetId;
    overwrite: boolean;
    theme?: "light" | "dark";
    mathNumbering?: MathNumberingMode;
    configPath?: string;
    responsePath: string;
  };
  markdown: string;
  config: AppConfig;
}

export async function runHeadlessExport(payload: HeadlessExportPayload) {
  const { request, markdown } = payload;
  const settings = structuredClone(payload.config.settings!);
  settings.export.openFileAfterExport = false;
  settings.export.openFolderAfterExport = false;
  settings.export.htmlTheme = request.theme ?? (
    settings.export.htmlTheme === "dark" ? "dark" : "light"
  );
  const numberingMode = request.mathNumbering
    ?? settings.markdown.mathNumbering
    ?? "none";

  try {
    const targets = request.target
      ? exportTargets.filter((target) => target.id === request.target)
      : exportTargets;
    if (targets.length === 0) {
      return complete({
        ok: false,
        code: 2,
        message: `不支持的导出格式：${request.target}`,
      });
    }
    const checks = targets.map((target) => {
      const result = analyzeMathExportCompatibility(markdown, target.id, numberingMode);
      return {
        target: target.id,
        status: result.status,
        features: result.features,
        issues: result.issues.map(({ feature, capability, message, blocking }) => ({
          feature,
          capability,
          message,
          blocking,
        })),
      };
    });
    const blocked = checks.flatMap((check) =>
      check.issues.filter((issue) => issue.blocking).map((issue) => `${check.target}: ${issue.message}`)
    );
    if (blocked.length > 0) {
      return complete({
        ok: false,
        code: 3,
        message: blocked.join("\n"),
        checks,
      });
    }
    if (request.mode === "check") {
      return complete({
        ok: true,
        code: 0,
        message: checks.some((check) => check.status === "degraded")
          ? "兼容性检查完成，部分格式可能降级。"
          : "兼容性检查通过。",
        checks,
      });
    }
    if (!request.target || !request.outputPath) {
      return complete({
        ok: false,
        code: 2,
        message: "CLI 导出缺少目标格式或输出路径。",
      });
    }
    const result = await exportCurrentDocument({
      target: request.target,
      currentPath: request.inputPath,
      markdown,
      settings: settings.export,
      mathNumbering: numberingMode,
      outputPath: request.outputPath,
      overwrite: request.overwrite,
    });
    return complete({
      ok: true,
      code: 0,
      message: `已导出：${result.path}`,
      outputPath: result.path,
      format: result.format,
      usedPandocPath: result.usedPandocPath,
      command: result.command,
      stdout: result.stdout,
      stderr: result.stderr,
      checks,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return complete({
      ok: false,
      code: dependencyError(message) ? 4 : 5,
      message,
    });
  }
}

async function complete(response: Record<string, unknown>) {
  await invoke("complete_headless_export", { response });
}

function dependencyError(message: string) {
  return /未找到 Pandoc|未找到 Microsoft Edge|Chrome|Chromium|LaTeX|xelatex|mhchem\.sty|无法启动进程/.test(message);
}
