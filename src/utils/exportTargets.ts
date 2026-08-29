import type { ExportTarget } from "../types";

export const exportTargets: ExportTarget[] = [
  { id: "pdf", label: "PDF", extension: "pdf", kind: "native-pdf", requiresPandoc: false, enabled: true },
  { id: "html", label: "HTML", extension: "html", kind: "native-html", requiresPandoc: false, enabled: true },
  { id: "htmlPlain", label: "HTML without styles", extension: "html", kind: "native-html", requiresPandoc: false, enabled: true },
  { id: "png", label: "PNG 长图", extension: "png", kind: "native-image", requiresPandoc: false, enabled: true },
  { id: "pdfPandoc", label: "PDF (Pandoc/LaTeX)", extension: "pdf", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "docx", label: "Word (.docx)", extension: "docx", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "odt", label: "OpenOffice (.odt)", extension: "odt", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "rtf", label: "RTF", extension: "rtf", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "epub", label: "EPUB", extension: "epub", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "latex", label: "LaTeX (.tex)", extension: "tex", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "mediawiki", label: "MediaWiki", extension: "wiki", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "rst", label: "reStructuredText", extension: "rst", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "textile", label: "Textile", extension: "textile", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "opml", label: "OPML", extension: "opml", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "revealjs", label: "RevealJS", extension: "html", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "markdownSpec", label: "Markdown (Other Spec)", extension: "md", kind: "pandoc", requiresPandoc: true, enabled: true },
  { id: "customPandoc", label: "Custom Pandoc", extension: "html", kind: "pandoc", requiresPandoc: true, enabled: true },
];
