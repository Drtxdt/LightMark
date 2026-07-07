import type { EditorPaneId, SplitLayoutState } from "../types";

const MIN_RATIO = 0.3;
const MAX_RATIO = 0.7;

export function defaultSplitLayout(activeTabId = ""): SplitLayoutState {
  return {
    enabled: false,
    activePaneId: "main",
    mainTabId: activeTabId,
    secondaryTabId: "",
    ratio: 0.5,
  };
}

export function enableSplitLayout(layout: SplitLayoutState, tabIds: string[]): SplitLayoutState {
  const normalized = normalizeSplitLayout({ ...layout, enabled: true }, tabIds, layout.mainTabId || tabIds[0] || "");
  const secondary = normalized.secondaryTabId || tabIds.find((id) => id !== normalized.mainTabId) || normalized.mainTabId;
  return normalizeSplitLayout(
    {
      ...normalized,
      enabled: true,
      activePaneId: "secondary",
      secondaryTabId: secondary,
    },
    tabIds,
    normalized.mainTabId,
  );
}

export function disableSplitLayout(layout: SplitLayoutState): SplitLayoutState {
  return {
    ...layout,
    enabled: false,
    activePaneId: "main",
  };
}

export function splitLayoutForPaneActivation(
  layout: SplitLayoutState,
  paneId: EditorPaneId,
  tabId: string,
  tabIds: string[],
): SplitLayoutState {
  return normalizeSplitLayout(
    {
      ...layout,
      activePaneId: paneId,
      mainTabId: paneId === "main" ? tabId : layout.mainTabId,
      secondaryTabId: paneId === "secondary" ? tabId : layout.secondaryTabId,
    },
    tabIds,
    tabId,
  );
}

export function resolveClosedTabSplitLayout(layout: SplitLayoutState, closedTabId: string, remainingTabIds: string[]): SplitLayoutState {
  const fallback = remainingTabIds[0] || "";
  return normalizeSplitLayout(
    {
      ...layout,
      mainTabId: layout.mainTabId === closedTabId ? fallback : layout.mainTabId,
      secondaryTabId: layout.secondaryTabId === closedTabId ? remainingTabIds.find((id) => id !== layout.mainTabId) || fallback : layout.secondaryTabId,
    },
    remainingTabIds,
    fallback,
  );
}

export function normalizeSplitLayout(
  layout: Partial<SplitLayoutState> | undefined,
  tabIds: string[],
  fallbackTabId = "",
): SplitLayoutState {
  const fallback = tabIds.includes(fallbackTabId) ? fallbackTabId : tabIds[0] || "";
  const mainTabId = tabIds.includes(layout?.mainTabId || "") ? layout!.mainTabId! : fallback;
  const secondaryFallback = tabIds.find((id) => id !== mainTabId) || mainTabId;
  const secondaryTabId = tabIds.includes(layout?.secondaryTabId || "") ? layout!.secondaryTabId! : secondaryFallback;
  const activePaneId: EditorPaneId = layout?.activePaneId === "secondary" ? "secondary" : "main";
  return {
    enabled: Boolean(layout?.enabled && tabIds.length > 0),
    activePaneId,
    mainTabId,
    secondaryTabId,
    ratio: clampRatio(layout?.ratio),
  };
}

export function paneTabId(layout: SplitLayoutState, paneId: EditorPaneId) {
  return paneId === "secondary" ? layout.secondaryTabId : layout.mainTabId;
}

export function otherPaneId(paneId: EditorPaneId): EditorPaneId {
  return paneId === "main" ? "secondary" : "main";
}

function clampRatio(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, value));
}
