export type LightMarkResolvedTheme = "light" | "dark";

export type ExportThemePalette = {
  bg: string;
  text: string;
  muted: string;
  border: string;
  borderSubtle: string;
  heading: string;
  surface: string;
  surfaceMuted: string;
  codeBg: string;
  codeText: string;
  codeBorder: string;
  link: string;
  linkDecoration: string;
  tableHeaderBg: string;
  tableStripeBg: string;
  markBg: string;
  frontMatterBg: string;
  alertBg: string;
  alertNoteBg: string;
  alertTipBg: string;
  alertImportantBg: string;
  alertWarningBg: string;
  alertCautionBg: string;
  statusBg: string;
  statusText: string;
  statusMuted: string;
  statusMutedSoft: string;
  statusBorder: string;
  statusHover: string;
  statusRunning: string;
  statusRunningSoft: string;
  statusSuccess: string;
  statusSuccessSoft: string;
  statusError: string;
  statusErrorSoft: string;
};

export function getExportThemePalette(theme: LightMarkResolvedTheme): ExportThemePalette {
  return theme === "dark" ? darkPalette : lightPalette;
}

export function exportThemeCssVariables(theme: LightMarkResolvedTheme) {
  const palette = getExportThemePalette(theme);
  return [
    `--lm-bg: ${palette.bg};`,
    `--lm-text: ${palette.text};`,
    `--lm-muted: ${palette.muted};`,
    `--lm-border: ${palette.border};`,
    `--lm-border-subtle: ${palette.borderSubtle};`,
    `--lm-heading: ${palette.heading};`,
    `--lm-surface: ${palette.surface};`,
    `--lm-surface-muted: ${palette.surfaceMuted};`,
    `--lm-code-bg: ${palette.codeBg};`,
    `--lm-code-text: ${palette.codeText};`,
    `--lm-code-border: ${palette.codeBorder};`,
    `--lm-link: ${palette.link};`,
    `--lm-link-decoration: ${palette.linkDecoration};`,
    `--lm-table-header-bg: ${palette.tableHeaderBg};`,
    `--lm-table-stripe-bg: ${palette.tableStripeBg};`,
    `--lm-mark-bg: ${palette.markBg};`,
    `--lm-front-matter-bg: ${palette.frontMatterBg};`,
    `--lm-alert-bg: ${palette.alertBg};`,
    `--lm-alert-note-bg: ${palette.alertNoteBg};`,
    `--lm-alert-tip-bg: ${palette.alertTipBg};`,
    `--lm-alert-important-bg: ${palette.alertImportantBg};`,
    `--lm-alert-warning-bg: ${palette.alertWarningBg};`,
    `--lm-alert-caution-bg: ${palette.alertCautionBg};`,
  ].join("\n      ");
}

const lightPalette: ExportThemePalette = {
  bg: "#fbfaf7",
  text: "#333333",
  muted: "#756f66",
  border: "#d5d0c6",
  borderSubtle: "rgb(213 208 198 / 56%)",
  heading: "#2e2b26",
  surface: "#f5f3ee",
  surfaceMuted: "#f6f3ed",
  codeBg: "#f3f0ea",
  codeText: "#3f3a32",
  codeBorder: "#e0dbd1",
  link: "#2563a6",
  linkDecoration: "#9bb5d0",
  tableHeaderBg: "#f0ede6",
  tableStripeBg: "rgb(31 30 27 / 3%)",
  markBg: "#fff0a8",
  frontMatterBg: "#f6f3ed",
  alertBg: "#f6f8fa",
  alertNoteBg: "#f0f6ff",
  alertTipBg: "#f0fff4",
  alertImportantBg: "#f6f0ff",
  alertWarningBg: "#fff8c5",
  alertCautionBg: "#fff1f1",
  statusBg: "rgb(250 248 244 / 94%)",
  statusText: "#5f574c",
  statusMuted: "#8a8176",
  statusMutedSoft: "rgb(154 143 128 / 14%)",
  statusBorder: "rgb(220 214 203 / 76%)",
  statusHover: "rgb(120 113 108 / 12%)",
  statusRunning: "#8a6d3b",
  statusRunningSoft: "rgb(138 109 59 / 18%)",
  statusSuccess: "#4f7f58",
  statusSuccessSoft: "rgb(79 127 88 / 14%)",
  statusError: "#8f423a",
  statusErrorSoft: "rgb(143 66 58 / 14%)",
};

const darkPalette: ExportThemePalette = {
  bg: "#0c0c0b",
  text: "#e8e5df",
  muted: "#b9b3a8",
  border: "#1b1a18",
  borderSubtle: "rgb(91 85 75 / 62%)",
  heading: "#f0ede7",
  surface: "#121210",
  surfaceMuted: "#171613",
  codeBg: "#141311",
  codeText: "#ece7df",
  codeBorder: "#2a2721",
  link: "#9ecbff",
  linkDecoration: "#587ea3",
  tableHeaderBg: "#171613",
  tableStripeBg: "rgb(255 255 255 / 3%)",
  markBg: "#5f4f22",
  frontMatterBg: "#121210",
  alertBg: "#151719",
  alertNoteBg: "#111a25",
  alertTipBg: "#101d14",
  alertImportantBg: "#1b1428",
  alertWarningBg: "#201a0d",
  alertCautionBg: "#211313",
  statusBg: "rgb(12 12 11 / 96%)",
  statusText: "#e8e5df",
  statusMuted: "#b9b3a8",
  statusMutedSoft: "rgb(185 179 168 / 14%)",
  statusBorder: "rgb(27 26 24 / 92%)",
  statusHover: "rgb(232 229 223 / 9%)",
  statusRunning: "#c9a66d",
  statusRunningSoft: "rgb(201 166 109 / 18%)",
  statusSuccess: "#81a889",
  statusSuccessSoft: "rgb(129 168 137 / 16%)",
  statusError: "#d18a80",
  statusErrorSoft: "rgb(209 138 128 / 16%)",
};
