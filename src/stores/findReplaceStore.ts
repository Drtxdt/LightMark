import { reactive } from "vue";
import type { FindReplaceOptions } from "../utils/findReplace";

export type FindCommand =
  | "refresh"
  | "next"
  | "previous"
  | "replaceCurrent"
  | "replaceAll";

export const findReplaceStore = reactive({
  open: false,
  query: "",
  replaceText: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  currentIndex: -1,
  total: 0,
  error: "",
  busy: false,
  sequence: 0,
});

export function findOptions(): FindReplaceOptions {
  return {
    caseSensitive: findReplaceStore.caseSensitive,
    wholeWord: findReplaceStore.wholeWord,
    regex: findReplaceStore.regex,
  };
}

export function openFindPanel() {
  findReplaceStore.open = true;
  window.setTimeout(() => {
    window.dispatchEvent(new CustomEvent("lightmark:find-focus"));
  }, 0);
}

export function closeFindPanel() {
  findReplaceStore.open = false;
  findReplaceStore.error = "";
  findReplaceStore.total = 0;
  findReplaceStore.currentIndex = -1;
  findReplaceStore.sequence += 1;
  runFindCommand("refresh");
}

export function runFindCommand(command: FindCommand) {
  window.dispatchEvent(new CustomEvent("lightmark:find-command", { detail: command }));
}

export function refreshFind() {
  findReplaceStore.sequence += 1;
  runFindCommand("refresh");
}

export function setFindResult(total: number, currentIndex: number, error = "") {
  findReplaceStore.total = total;
  findReplaceStore.currentIndex = total > 0 ? Math.max(0, currentIndex) : -1;
  findReplaceStore.error = error;
}
