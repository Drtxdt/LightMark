param([switch]$OwnedHostInstall, [string]$RunDirectory)
$ErrorActionPreference = 'Stop'
$payloadRoot = 'C:\LightMarkPayload'
$resultRoot = 'C:\LightMarkResults'
$workRoot = 'C:\LightMarkAcceptance'
$installRoot = Join-Path $workRoot 'Installed'
$fixtureRoot = Join-Path $workRoot 'fixtures'
$appIdentifier = 'com.lightmark.desktop'
$canWriteReport = $false
$report = [ordered]@{ schemaVersion=1; status='not-run'; installerExecutedOnHost=$false; checkpoints=@(); commands=@(); manualAcceptance='not-run' }
function Assert-OrdinaryPath([string]$targetPath) {
  $cursor = [IO.Path]::GetFullPath($targetPath)
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Reparse path refused: $cursor" }
    $parentPath = Split-Path -Parent $cursor
    if ($parentPath -eq $cursor) { break }; $cursor = $parentPath
  }
}
function Installation-Inventory {
  $uninstalls = @(Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'LightMark' -or $_.PSChildName -match 'LightMark' } | Select-Object PSPath,DisplayName,DisplayVersion,InstallLocation,UninstallString)
  $manufacturer = @(@('HKCU:\Software\LightMark\LightMark','HKLM:\Software\LightMark\LightMark','HKLM:\Software\WOW6432Node\LightMark\LightMark') | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { $key=Get-Item -LiteralPath $_; [pscustomobject]@{path=$_;values=@($key.GetValueNames() | Sort-Object | ForEach-Object { [pscustomobject]@{name=$_;value=$key.GetValue($_)} })} })
  $shortcuts = @(@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('StartMenu'),[Environment]::GetFolderPath('CommonStartMenu')) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | ForEach-Object { Get-ChildItem -LiteralPath $_ -Filter '*LightMark*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{path=$_.FullName;sha256=(Hash-File $_.FullName)} } })
  $startup=@(@('HKCU:\Software\Microsoft\Windows\CurrentVersion\Run','HKLM:\Software\Microsoft\Windows\CurrentVersion\Run') | Where-Object {Test-Path -LiteralPath $_} | ForEach-Object {$key=Get-Item -LiteralPath $_; if($key.GetValueNames() -contains 'LightMark'){[pscustomobject]@{path=$_;value=$key.GetValue('LightMark')}}})
  $manufacturerParents = @(@('HKCU:\Software\LightMark','HKLM:\Software\LightMark','HKLM:\Software\WOW6432Node\LightMark') | Where-Object { Test-Path -LiteralPath $_ })
  return [pscustomobject]@{uninstalls=$uninstalls;manufacturer=$manufacturer;manufacturerParents=$manufacturerParents;shortcuts=$shortcuts;startup=$startup}
}
function Remove-OwnedMetadataParent([string]$parentKey, [string[]]$baselineParents) {
  # An empty key may predate this run. Only a newly created, still-empty parent is owned.
  if ($baselineParents -contains $parentKey) { return }
  if ((Test-Path -LiteralPath $parentKey) -and -not @(Get-ChildItem -LiteralPath $parentKey).Count -and -not (Get-Item -LiteralPath $parentKey).GetValueNames().Count) { Remove-Item -LiteralPath $parentKey }
}
function Protected-Profile-State {
  $records = @()
  foreach ($base in @([Environment]::GetFolderPath('ApplicationData'),[Environment]::GetFolderPath('LocalApplicationData'))) {
    $root=Join-Path $base 'com.lightmark.desktop'
    if (Test-Path -LiteralPath $root) {
      Assert-OrdinaryPath $root
      $records += [pscustomobject]@{path=$root;directory=$true}
      foreach($file in @(Get-ChildItem -LiteralPath $root -Recurse -Force | Sort-Object FullName)) {
        if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Protected real profile contains a reparse point; cannot prove isolation.'}
        $records += [pscustomobject]@{path=$file.FullName;directory=$file.PSIsContainer;sha256=$(if(-not $file.PSIsContainer){Hash-File $file.FullName}else{$null})}
      }
    } else { $records += [pscustomobject]@{path=$root;absent=$true} }
  }
  return ConvertTo-Json -InputObject @($records) -Depth 6 -Compress
}
function Verify-Protected-State {
  if ($OwnedHostInstall -and (Protected-Profile-State) -cne $script:protectedBefore) { throw 'Existing production profile changed during acceptance; preserving evidence and refusing further actions.' }
}
function Write-Report { $report | ConvertTo-Json -Depth 24 | Set-Content -LiteralPath (Join-Path $resultRoot 'sandbox-report.json') -Encoding UTF8 }
function Hash-File([string]$filePath) { (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant() }
function Start-OwnedApp {
  # This is the interactive app being tested; only its supervising PowerShell is hidden.
  $script:ownedProcess = Start-Process -FilePath $script:installedExecutable -ArgumentList @('--profile', $lock.profileName) -PassThru -WindowStyle Normal
  $report.pid = $script:ownedProcess.Id
  $report.launchedAt = [DateTime]::UtcNow.ToString('o')
}
function Assert-OwnedProcess {
  $process = Get-Process -Id $script:ownedProcess.Id -ErrorAction Stop
  if ($process.Path -ne $script:installedExecutable) { throw 'Owned process path changed; refusing process control.' }
  if ((Hash-File $process.Path) -ne $lock.executable.sha256) { throw 'Owned process executable hash changed.' }
  return $process
}
function Checkpoint([string]$name) {
  Verify-Protected-State
  if ($name -notmatch '^[a-zA-Z0-9_-]{1,80}$') { throw 'Invalid checkpoint id.' }
  $directory = Join-Path $resultRoot $name
  if (Test-Path -LiteralPath $directory) { throw 'Checkpoint already exists.' }
  New-Item -ItemType Directory -Path $directory | Out-Null
  Copy-Item -LiteralPath $fixtureRoot -Destination (Join-Path $directory 'fixtures') -Recurse
  $profile = Join-Path ([Environment]::GetFolderPath('ApplicationData')) $appIdentifier
  $draftRoot = Join-Path $profile 'drafts'
  $drafts = @()
  if (Test-Path -LiteralPath $draftRoot) {
    Copy-Item -LiteralPath $draftRoot -Destination (Join-Path $directory 'drafts') -Recurse
    $drafts = @(Get-ChildItem -LiteralPath $draftRoot -Filter '*.json' -File | ForEach-Object {
      [pscustomobject]@{ name=$_.Name; sha256=(Hash-File $_.FullName); bytes=$_.Length; containsRecoveryMarker=([IO.File]::ReadAllText($_.FullName).Contains('DRAFT_RECOVERY_RELEASE_SENTINEL')) }
    })
  }
  $saved = Join-Path $fixtureRoot 'release-loop.md'
  $entry = [ordered]@{ id=$name; at=[DateTime]::UtcNow.ToString('o'); savedFileSha256=(Hash-File $saved); expectedSavedSha256=(Hash-File (Join-Path $payloadRoot 'expected-saved.md')); drafts=$drafts; profile=$profile }
  $entry.localProfile = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $appIdentifier
  $entry.profileExists = Test-Path -LiteralPath $profile
  $entry.localProfileExists = Test-Path -LiteralPath $entry.localProfile
  $processes = @(Get-CimInstance Win32_Process)
  $ownedBrowser = @($processes | Where-Object {
    if ($_.Name -ne 'msedgewebview2.exe') { return $false }
    $cursor=$_.ParentProcessId; $found=$false
    for($depth=0;$depth -lt 12 -and $cursor;$depth++) { if($cursor -eq $script:ownedProcess.Id){$found=$true;break}; $parentProcess=$processes|Where-Object ProcessId -eq $cursor|Select-Object -First 1; if(-not $parentProcess){break};$cursor=$parentProcess.ParentProcessId }
    return $found
  } | Where-Object { $_.CommandLine -match '--user-data-dir' } | Select-Object ProcessId,ParentProcessId,CommandLine)
  $entry.ownedWebviewProcesses=$ownedBrowser
  $entry.webviewProfileIsolated=($ownedBrowser.Count -gt 0 -and -not @($ownedBrowser|Where-Object { $_.CommandLine.IndexOf($entry.localProfile,[StringComparison]::OrdinalIgnoreCase) -lt 0 }).Count)
  $entry.exactSavedBytes = $entry.savedFileSha256 -eq $entry.expectedSavedSha256
  $report.checkpoints += $entry
  Write-Report
  return $entry
}
try {
  # The production identifier is intentionally unchanged. Never run its installer/profile on the host.
  if ($OwnedHostInstall) {
    if (-not $RunDirectory) { throw '-OwnedHostInstall requires the newly built owned RunDirectory.' }
    $resolvedRun = (Resolve-Path -LiteralPath $RunDirectory).Path
    Assert-OrdinaryPath $resolvedRun
    $prepared = Get-Content -LiteralPath (Join-Path $resolvedRun 'manifest.json') -Raw | ConvertFrom-Json
    if ($prepared.kind -ne 'windows-production-release-acceptance' -or $prepared.status -ne 'artifacts-built-acceptance-prepared' -or $prepared.runDir -ne $resolvedRun) { throw 'Owned production build manifest is missing or invalid.' }
    $payloadRoot = Join-Path $resolvedRun 'payload'; $resultRoot = Join-Path $resolvedRun 'results'; $workRoot = Join-Path $resultRoot 'owned-install-work'; $installRoot = Join-Path $workRoot 'Installed'; $fixtureRoot = Join-Path $workRoot 'fixtures'
    foreach($pathToCheck in @($payloadRoot,$resultRoot,$workRoot,$installRoot,$fixtureRoot)){Assert-OrdinaryPath $pathToCheck}
    $script:protectedBefore = Protected-Profile-State
    $report.protectedProfileBefore = $script:protectedBefore | ConvertFrom-Json
  } elseif ([Environment]::UserName -ne 'WDAGUtilityAccount' -or $env:USERPROFILE -ne 'C:\Users\WDAGUtilityAccount') { throw 'Use Windows Sandbox, or the explicit guarded -OwnedHostInstall mode.' }
  if (-not (Test-Path -LiteralPath $payloadRoot) -or -not (Test-Path -LiteralPath $resultRoot)) { throw 'Expected explicit Sandbox mapped folders are absent.' }
  $canWriteReport = $true
  $lock = Get-Content -LiteralPath (Join-Path $payloadRoot 'release-lock.json') -Raw | ConvertFrom-Json
  if ($lock.profileName -notmatch '^[a-z0-9][a-z0-9-]{0,47}$' -or $lock.profileIdentifier -ne ('com.lightmark.profile.' + $lock.profileName)) { throw 'A validated official configuration profile is required.' }
  $appIdentifier=$lock.profileIdentifier
  if ($OwnedHostInstall -and ($lock.cliVersion -ne '2.11.2' -or $lock.installerPolicy -ne 'tauri-cli-2.11.2-default-nsis-silent-no-shortcuts-no-autorun')) { throw 'Re-review the pinned NSIS template before installing a different toolchain on the host.' }
  if ((Hash-File (Join-Path $payloadRoot 'LightMark-setup.exe')) -ne $lock.installer.sha256) { throw 'Installer hash mismatch.' }
  if ((Hash-File (Join-Path $payloadRoot 'lightmark.exe')) -ne $lock.executable.sha256) { throw 'Production executable hash mismatch.' }
  $beforeInventory=Installation-Inventory; $report.beforeInventory=$beforeInventory
  if ($beforeInventory.uninstalls.Count -gt 0 -or $beforeInventory.manufacturer.Count -gt 0 -or $beforeInventory.shortcuts.Count -gt 0 -or $beforeInventory.startup.Count -gt 0 -or (Get-Process -Name 'lightmark' -ErrorAction SilentlyContinue)) { throw 'Existing LightMark installation, manufacturer/startup registration, shortcut or process found; refusing owned installation.' }
  foreach($base in @([Environment]::GetFolderPath('ApplicationData'),[Environment]::GetFolderPath('LocalApplicationData'))) { if(Test-Path -LiteralPath (Join-Path $base $appIdentifier)){throw 'Selected official profile already exists; use a fresh release run.'} }
  foreach($variable in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'WEBVIEW2_*' })) { [Environment]::SetEnvironmentVariable($variable.Name,$null,'Process') }
  [Environment]::SetEnvironmentVariable('LIGHTMARK_PROFILE',$lock.profileName,'Process')
  $report.profileIdentifier=$appIdentifier; $report.profileName=$lock.profileName
  if (Test-Path -LiteralPath $workRoot) { throw 'Fresh Sandbox work directory required.' }
  New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $payloadRoot 'release-loop.md') -Destination (Join-Path $fixtureRoot 'release-loop.md')
  $report.sourceIdentity = $lock.sourceIdentity
  $report.frontendHash = $lock.frontendHash
  $report.installerHash = $lock.installer.sha256
  $report.status = 'installing'
  $report.installStartedAt = [DateTime]::UtcNow.ToString('o')
  $report.installerExecutedOnHost=[bool]$OwnedHostInstall
  Write-Report
  # /D must be the final NSIS argument. All changes remain in the disposable Sandbox OS.
  $installerProcess = Start-Process -FilePath (Join-Path $payloadRoot 'LightMark-setup.exe') -ArgumentList @('/S', '/NS', "/D=$installRoot") -PassThru -Wait -WindowStyle Hidden
  $report.installerExitCode = $installerProcess.ExitCode
  if ($installerProcess.ExitCode -ne 0) { throw 'NSIS installation failed.' }
  $matches = @(Get-ChildItem -LiteralPath $installRoot -Filter '*.exe' -File -Recurse | Where-Object { (Hash-File $_.FullName) -eq $lock.executable.sha256 })
  if ($matches.Count -ne 1) { throw 'Installed executable does not match the locked production release hash exactly once.' }
  $script:installedExecutable = $matches[0].FullName
  $report.installedExecutable = $script:installedExecutable
  $report.installedExecutableHash = Hash-File $script:installedExecutable
  $installedSidecar = Join-Path $installRoot 'lightmark-cli.exe'
  Assert-OrdinaryPath $installedSidecar
  if (-not $lock.sidecar.sha256 -or (Hash-File $installedSidecar) -ne $lock.sidecar.sha256) { throw 'Installed Cargo sidecar does not match the locked production hash.' }
  $report.installedSidecarHash = Hash-File $installedSidecar
  $report.installedInventory=Installation-Inventory
  if ($report.installedInventory.uninstalls.Count -ne 1 -or @($report.installedInventory.uninstalls | Where-Object { $_.InstallLocation.Trim('"') -ne $installRoot -or $_.UninstallString.Trim('"') -ne (Join-Path $installRoot 'uninstall.exe') }).Count) { throw 'New uninstall registration does not belong exclusively to the owned install directory.' }
  $report.uninstallerHash = Hash-File (Join-Path $installRoot 'uninstall.exe')
  if ($report.installedInventory.shortcuts.Count -ne 0) { throw '/NS did not preserve the empty shortcut baseline.' }
  Verify-Protected-State
  $report.status = 'manual-ui-ready'
  $report.instructions = @(
    "Use the Open File button to open $fixtureRoot\release-loop.md. Select Source mode, replace all text with the EXACT contents of $payloadRoot\expected-saved.md through the real editor, then Ctrl+S.",
    'Write command.json {id,action:"checkpoint"} in the mapped result folder. exactSavedBytes must be true.',
    'Close/reopen the real app and fixture; verify visible saved text. Use {id,action:"relaunch"} after the old app has closed.',
    'Create an unsaved tab through the UI and enter DRAFT_RECOVERY_RELEASE_SENTINEL. Wait for autosave; checkpoint must contain a draft with that marker.',
    'Use {id,action:"crash-relaunch"} to stop ONLY the locked owned app process and start it again. Verify and restore the draft through the real UI.',
    'Finish via {id,action:"finish",status:"passed"|"failed",evidence:[{requirement,status,evidence}]} with all six requirements explicitly evidenced. Preparation/install alone never passes UI acceptance.'
  )
  Start-OwnedApp
  Write-Report
  $seen = [Collections.Generic.HashSet[string]]::new()
  $deadline = [DateTime]::UtcNow.AddHours(2)
  while ([DateTime]::UtcNow -lt $deadline) {
    $mailbox = Join-Path $resultRoot 'command.json'
    if (Test-Path -LiteralPath $mailbox) {
      try { $command = Get-Content -LiteralPath $mailbox -Raw | ConvertFrom-Json } catch { Start-Sleep -Milliseconds 250; continue }
      if ($command.id -and $seen.Add([string]$command.id)) {
        $receipt = [ordered]@{ id=$command.id; action=$command.action; at=[DateTime]::UtcNow.ToString('o') }
        try {
          switch ($command.action) {
            'checkpoint' { $receipt.result = Checkpoint $command.id }
            'relaunch' { if (Get-Process -Id $script:ownedProcess.Id -ErrorAction SilentlyContinue) { throw 'Close the app through its UI before relaunch.' }; Start-OwnedApp; $receipt.result='launched' }
            'crash-relaunch' { $process = Assert-OwnedProcess; Stop-Process -Id $process.Id; $process.WaitForExit(); Start-OwnedApp; $receipt.result='owned-process-crash-and-relaunch' }
            'uninstall' {
              if (Get-Process -Name 'lightmark' -ErrorAction SilentlyContinue) { throw 'Close all LightMark app windows through their UI before uninstalling.' }
              Verify-Protected-State
              $currentInventory=Installation-Inventory
              if (($currentInventory | ConvertTo-Json -Depth 12 -Compress) -cne ($report.installedInventory | ConvertTo-Json -Depth 12 -Compress)) { throw 'Installation registrations changed after installation; refusing uninstaller.' }
              $uninstaller=Join-Path $installRoot 'uninstall.exe'; Assert-OrdinaryPath $uninstaller
              if((Hash-File $uninstaller) -ne $report.uninstallerHash){throw 'Owned uninstaller hash changed; refusing execution.'}
              $uninstallProcess=Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installRoot") -PassThru -Wait -WindowStyle Hidden
              if($uninstallProcess.ExitCode -ne 0){throw 'Owned silent uninstall failed.'}
              if(Test-Path -LiteralPath $script:installedExecutable){throw 'Owned executable still exists after uninstall.'}
              # Silent uninstall leaves the app-data checkbox untouched. Remove only new, unchanged installer metadata keys.
              foreach($registry in $currentInventory.manufacturer) {
                if(Test-Path -LiteralPath $registry.path){
                  $key=Get-Item -LiteralPath $registry.path
                  $now=@($key.GetValueNames() | Sort-Object | ForEach-Object { [pscustomobject]@{name=$_;value=$key.GetValue($_)} })
                  if(($now|ConvertTo-Json -Depth 5 -Compress) -cne ($registry.values|ConvertTo-Json -Depth 5 -Compress) -or @(Get-ChildItem -LiteralPath $registry.path).Count){throw 'Installer metadata changed; refusing metadata cleanup.'}
                  Remove-Item -LiteralPath $registry.path
                  $parentKey=Split-Path -Parent $registry.path
                  Remove-OwnedMetadataParent $parentKey $report.beforeInventory.manufacturerParents
                }
              }
              $report.afterUninstallInventory=Installation-Inventory
              if(($report.afterUninstallInventory|ConvertTo-Json -Depth 12 -Compress) -cne ($report.beforeInventory|ConvertTo-Json -Depth 12 -Compress)){throw 'Installation registry/shortcut state was not restored exactly.'}
              Verify-Protected-State
              $report.uninstalledAt=[DateTime]::UtcNow.ToString('o'); $report.status=$(if($report.manualAcceptance -eq 'passed'){'passed'}else{'uninstalled-awaiting-manual-receipt'}); $receipt.result='owned-installation-removed-existing-profile-unchanged'
            }
            'finish' {
              if ($command.status -notin @('passed','failed')) { throw 'An explicit passed or failed status is required.' }
              $receipt.result = Checkpoint ('finish_' + $command.id)
              $missing = @($lock.requirements | Where-Object { $required=$_; -not @($command.evidence | Where-Object { $_.requirement -eq $required -and $_.status -eq 'passed' -and $_.evidence }).Count })
              if ($command.status -eq 'passed' -and ($missing.Count -gt 0 -or -not @($report.checkpoints | Where-Object { $_.exactSavedBytes -and $_.profileExists -and $_.localProfileExists -and $_.webviewProfileIsolated }).Count -or -not @($report.checkpoints.drafts | Where-Object { $_.containsRecoveryMarker }).Count)) { throw "Acceptance lacks required exact-save/draft/manual evidence: $($missing -join ', ')" }
              $report.status=$(if($OwnedHostInstall -and $command.status -eq 'passed' -and -not $report.uninstalledAt){'manual-ui-passed-awaiting-uninstall'}else{$command.status}); $report.manualAcceptance=$command.status; $report.evidence=$command.evidence; $report.finishedAt=[DateTime]::UtcNow.ToString('o')
            }
            default { throw 'Supported actions: checkpoint, relaunch, crash-relaunch, uninstall, finish.' }
          }
        } catch { $receipt.error=$_.Exception.Message }
        $report.commands += $receipt
        $receipt | ConvertTo-Json -Depth 15 | Set-Content -LiteralPath (Join-Path $resultRoot 'command-result.json') -Encoding UTF8
        Write-Report
        if ($report.manualAcceptance -in @('passed','failed') -and (-not $OwnedHostInstall -or $report.uninstalledAt)) { break }
      }
    }
    Start-Sleep -Milliseconds 250
  }
  if ($report.manualAcceptance -eq 'not-run') { $report.status='incomplete'; $report.reason='No explicit complete UI acceptance receipt before timeout'; Write-Report }
  if ($OwnedHostInstall -and -not $report.uninstalledAt) { $report.status='incomplete'; $report.reason='Owned installation has not been uninstalled and its registry/shortcut state verified'; Write-Report }
  # Keep the interactive window and Sandbox alive for review; closing the Sandbox discards its OS state.
} catch {
  $report.status='failed'; $report.error=$_.Exception.Message
  if ($canWriteReport) { Write-Report }
  throw
}
