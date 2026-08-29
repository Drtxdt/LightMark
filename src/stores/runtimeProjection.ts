import { subscribeDocumentRuntime, type DocumentDerivedState } from "../editor/documentRuntime";

export type RuntimeDerivedProjection = Record<string, DocumentDerivedState & { revision: number }>;

export function installRuntimeProjection(target: RuntimeDerivedProjection) {
  return subscribeDocumentRuntime((tabId, state) => {
    if (state) target[tabId] = { ...state, revision: state.revision ?? 0 };
    else delete target[tabId];
  });
}
