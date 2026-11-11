param([Parameter(Mandatory=$true)][string]$Repository)
$ErrorActionPreference = 'Stop'
$benchRoot = Join-Path $Repository '.cache\plan-native-tests\backend-release-final'
New-Item -ItemType Directory -Path $benchRoot -Force | Out-Null
$testBinary = Get-ChildItem -LiteralPath (Join-Path $Repository 'src-tauri\target\release\deps') -Filter 'lightmark_lib-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $testBinary) { throw 'Release lib test executable not found.' }
$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $Repository 'src-tauri\src') -Recurse -File -Filter '*.rs') + @(Get-Item -LiteralPath (Join-Path $Repository 'src-tauri\Cargo.toml')) + @(Get-Item -LiteralPath (Join-Path $Repository 'src-tauri\Cargo.lock'))
$sourceHashes = @($sourceFiles | ForEach-Object { @{path=$_.FullName.Substring($Repository.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()} })
$manifest = [ordered]@{schemaVersion=1;kind='backend-release-lib-benchmark';startedAt=(Get-Date).ToUniversalTime().ToString('o');repository=$Repository;binary=$testBinary.FullName;binarySha256=(Get-FileHash -LiteralPath $testBinary.FullName -Algorithm SHA256).Hash.ToLowerInvariant();sources=$sourceHashes;profile='release';scope='Rust library test process; no WebView, input, DOM or rendering timing';commands=@();cases=@();metrics=@{openMs='Cumulative fixture creation, file sync and snapshot open; conservative aggregate, not pure command timing';firstSaveMs='Cumulative from fixture creation to first save completion, including initial read and edit';totalMs='Complete fixture creation, snapshot, edit, save, search, replace, undo twice, save, close and reopen';memory='Rust library test process peak working set, includes OS mmap residency; not frontend cache or JS heap'}}
foreach ($kind in @('unit','physical')) {
  $stdout = Join-Path $benchRoot ($kind+'.stdout.log')
  $stderr = Join-Path $benchRoot ($kind+'.stderr.log')
  $arguments = if ($kind -eq 'physical') { @('physical_large_file_matrix','--ignored','--nocapture') } else { @('--test-threads=4') }
  $started = Get-Date
  $process = Start-Process -FilePath $testBinary.FullName -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $peak = 0L; $samples = 0
  while (-not $process.HasExited) {
    try { $process.Refresh(); $peak=[Math]::Max($peak,$process.PeakWorkingSet64);$samples++ } catch {}
    Start-Sleep -Milliseconds 50
  }
  $process.WaitForExit()
  $manifest.commands += @{kind=$kind;pid=$process.Id;arguments=$arguments;exitCode=$process.ExitCode;elapsedMs=((Get-Date)-$started).TotalMilliseconds;peakWorkingSetBytes=$peak;samples=$samples;stdout=$stdout;stderr=$stderr}
  $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $benchRoot 'manifest.json') -Encoding utf8
  if ($process.ExitCode -ne 0) { throw "Release $kind test run failed. See $stdout" }
}
$manifest.cases = @(Get-Content -LiteralPath (Join-Path $benchRoot 'physical.stdout.log') | Where-Object { $_.StartsWith('{"bytes":') } | ForEach-Object { $_ | ConvertFrom-Json })
$manifest.finishedAt=(Get-Date).ToUniversalTime().ToString('o')
$manifest.status='passed'
$manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $benchRoot 'manifest.json') -Encoding utf8
$manifest.commands | Select-Object kind,exitCode,elapsedMs,peakWorkingSetBytes | ConvertTo-Json
$manifest.cases | ConvertTo-Json

