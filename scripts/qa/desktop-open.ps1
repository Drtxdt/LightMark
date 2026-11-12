# Only install and exercise the associations in a disposable hosted runner.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Requires a disposable GitHub runner' }
$setup = @(Get-ChildItem src-tauri/target/release/bundle/nsis/*.exe)
if ($setup.Count -ne 1) { throw 'Expected one installer' }
if ((Start-Process $setup[0].FullName -ArgumentList '/S' -Wait -PassThru).ExitCode -ne 0) { throw 'Install failed' }
$dir = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP ('打开 ' + [guid]::NewGuid()))
$notes = @('甲 笔记.md', '乙 笔记.markdown') | ForEach-Object {
  $path = Join-Path $dir.FullName $_
  Set-Content -LiteralPath $path "Fixture $_"
  Get-Item -LiteralPath $path
}
foreach ($first in 0,1) {
  $owner = $null
  foreach ($i in $first,(1-$first),$first) {
    $note = $notes[$i]
    $title = $note.Name + ' - LightMark'
    Start-Process -FilePath $note.FullName -Verb Open
    $found = $null
    for ($j=0; $j -lt 120; $j++) {
      $found = @(Get-Process lightmark -ErrorAction SilentlyContinue | Where-Object MainWindowTitle -eq $title)
      if ($found.Count -eq 1) { break }
      Start-Sleep -Milliseconds 250
    }
    if ($found.Count -ne 1) { throw "Shell open did not show $title" }
    if ($owner -and $owner -ne $found[0].Id) { throw 'New instance on warm launch' }
    $owner = $found[0].Id
    Write-Output "$title PID=$owner"
  }
  $app = Get-Process -Id $owner
  if (!$app.CloseMainWindow() -or !$app.WaitForExit(30000)) { throw 'Close failed' }
}
