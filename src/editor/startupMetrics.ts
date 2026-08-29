export type StartupStage = "shell" | "source" | "wysiwyg";

export interface StartupMetric {
  stage: StartupStage;
  readyAt: number;
  jsBytes: number;
  resources: Array<{ name: string; bytes: number; startTime: number; responseEnd: number }>;
}

declare global {
  interface Window {
    __LIGHTMARK_STARTUP_METRICS__?: Partial<Record<StartupStage, StartupMetric>>;
  }
}

export function recordStartupStage(stage: StartupStage) {
  if (typeof window === "undefined" || typeof performance === "undefined") return;
  const readyAt = performance.now();
  const resources = performance.getEntriesByType("resource")
    .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
    .filter((entry) => entry.responseEnd <= readyAt && /\.m?js(?:\?|$)/i.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      bytes: entry.transferSize || entry.encodedBodySize || 0,
      startTime: entry.startTime,
      responseEnd: entry.responseEnd,
    }));
  window.__LIGHTMARK_STARTUP_METRICS__ ||= {};
  window.__LIGHTMARK_STARTUP_METRICS__[stage] = {
    stage,
    readyAt,
    jsBytes: resources.reduce((total, resource) => total + resource.bytes, 0),
    resources,
  };
}
