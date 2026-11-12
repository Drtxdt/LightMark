#!/bin/bash
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true ]] || exit 2
app="$(pwd)/src-tauri/target/release/bundle/macos/LightMark.app"
lsreg=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsreg" -f "$app"
root=$(mktemp -d)
notes=("$root/甲 笔记.md" "$root/乙 笔记.markdown")
for note in "${notes[@]}"; do printf 'Fixture %s\n' "$note" > "$note"; done
swift scripts/qa/desktop-default.swift "$app" "${notes[@]}"
for first in 0 1; do
  owner=''
  for i in "$first" "$((1-first))" "$first"; do
    note="${notes[$i]}"
    osascript - "$note" <<'OSA'
on run argv
  tell application "Finder" to open (POSIX file (item 1 of argv) as alias)
end run
OSA
    title="$(basename "$note") - LightMark"
    visible=''
    for t in {1..75}; do
      visible=$(osascript -e 'tell application "System Events" to tell (first application process whose bundle identifier is "com.lightmark.desktop") to get name of front window' 2>/dev/null || true)
      [[ "$visible" == "$title" ]] && break
      sleep .4
    done
    [[ "$visible" == "$title" ]] || { echo "Expected $title, observed: $visible"; exit 1; }
    instance=$(pgrep -x lightmark)
    [[ -z "$owner" || "$instance" == "$owner" ]]
    owner="$instance"
    echo "$visible PID=$owner"
  done
  kill -TERM "$owner"
  for t in {1..50}; do kill -0 "$owner" 2>/dev/null || break; sleep .2; done
  ! kill -0 "$owner" 2>/dev/null || exit 1
done
