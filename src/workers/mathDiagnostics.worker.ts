import type { MathNumberingMode } from "../utils/mathMarkdown";
import { IncrementalMathDiagnostics } from "../editor/mathDiagnosticsIncremental";

type Edit = { from: number; to: number; insert: string };
type Request =
  | { type: "reset"; markdown: string; revision: number; numberingMode: MathNumberingMode; delay?: number }
  | { type: "changes"; edits: Edit[]; revision: number; numberingMode: MathNumberingMode; delay?: number };

let revision = 0;
let timer = 0;
const diagnostics = new IncrementalMathDiagnostics();

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  revision = request.revision;
  if (request.type === "reset") {
    diagnostics.reset(request.markdown, request.numberingMode);
  } else {
    diagnostics.applyChanges(request.edits, request.numberingMode);
  }
  clearTimeout(timer);
  timer = self.setTimeout(run, request.delay ?? 140);
};

function run() {
  const expectedRevision = revision;
  const evaluation = diagnostics.evaluate();
  self.postMessage({
    revision: expectedRevision,
    strategy: evaluation.strategy,
    diagnostics: evaluation.diagnostics,
    references: evaluation.references,
    equations: evaluation.equations.map((item) => ({ id: item.id, line: item.line, display: item.display })),
  });
}
