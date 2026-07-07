import type { EditorPaneId, SplitLayoutState } from "../types";

const MIN_RATIO = 0.3;
const MAX_RATIO = 0.7;

export function defaultSplitLayout(activeTabId = ""): SplitLayoutState {
  return {
    enabled: false,
    activePaneId: "main",
    mainTabId: activeTabId,
    secondaryTabId: "",
    mainTabIds: activeTabId ? [activeTabId] : [],
    secondaryTabIds: [],
    ratio: 0.5,
  };
}

export function enableSplitLayout(layout: SplitLayoutState, tabIds: string[]): SplitLayoutState {
  const normalized = normalizeSplitLayout({ ...layout, enabled: true }, tabIds, layout.mainTabId || tabIds[0] || "");
  const secondary = normalized.secondaryTabId !== normalized.mainTabId
    ? normalized.secondaryTabId
    : tabIds.find((id) => id !== normalized.mainTabId) || "";
  return normalizeSplitLayout(
    {
      ...normalized,
      enabled: true,
      activePaneId: "secondary",
      secondaryTabId: secondary,
      mainTabIds: normalized.mainTabIds.length > 0 ? normalized.mainTabIds : [normalized.mainTabId].filter(Boolean),
      secondaryTabIds: normalized.secondaryTabIds.filter((id) => id !== normalized.mainTabId).length > 0
        ? normalized.secondaryTabIds.filter((id) => id !== normalized.mainTabId)
        : [secondary].filter(Boolean),
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
      mainTabIds: paneId === "main" ? appendUnique(layout.mainTabIds, tabId) : layout.mainTabIds,
      secondaryTabIds: paneId === "secondary" ? appendUnique(layout.secondaryTabIds, tabId) : layout.secondaryTabIds,
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
      mainTabIds: removeId(layout.mainTabIds, closedTabId),
      secondaryTabIds: removeId(layout.secondaryTabIds, closedTabId),
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
  const secondaryFallback = tabIds.find((id) => id !== mainTabId) || "";
  const secondaryTabId = tabIds.includes(layout?.secondaryTabId || "") && layout?.secondaryTabId !== mainTabId ? layout!.secondaryTabId! : secondaryFallback;
  const activePaneId: EditorPaneId = layout?.activePaneId === "secondary" ? "secondary" : "main";
  const mainTabIds = normalizePaneTabIds(layout?.mainTabIds, tabIds, mainTabId);
  const secondaryTabIds = normalizePaneTabIds(layout?.secondaryTabIds, tabIds, secondaryTabId);
  return {
    enabled: Boolean(layout?.enabled && tabIds.length > 0),
    activePaneId,
    mainTabId,
    secondaryTabId,
    mainTabIds,
    secondaryTabIds,
    ratio: clampRatio(layout?.ratio),
  };
}

export function paneTabId(layout: SplitLayoutState, paneId: EditorPaneId) {
  return paneId === "secondary" ? layout.secondaryTabId : layout.mainTabId;
}

export function paneTabIds(layout: SplitLayoutState, paneId: EditorPaneId) {
  return paneId === "secondary" ? layout.secondaryTabIds : layout.mainTabIds;
}

export function otherPaneId(paneId: EditorPaneId): EditorPaneId {
  return paneId === "main" ? "secondary" : "main";
}

function clampRatio(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.max(MIN_RATIO, Math.min(MAX_RATIO, value));
}

function appendUnique(values: string[] | undefined, value: string) {
  const next = (values || []).filter(Boolean);
  return value && !next.includes(value) ? [...next, value] : next;
}

function removeId(values: string[] | undefined, value: string) {
  return (values || []).filter((id) => id && id !== value);
}

function normalizePaneTabIds(values: string[] | undefined, tabIds: string[], activeTabId: string) {
  const next = Array.from(new Set((values || []).filter((id) => tabIds.includes(id))));
  if (activeTabId && tabIds.includes(activeTabId) && !next.includes(activeTabId)) next.push(activeTabId);
  return next;
}
