$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'windows-release-sandbox.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($runner, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Remove-OwnedMetadataParent' }, $true)
if (-not $definition) { throw 'Missing guarded metadata parent cleanup function.' }
Invoke-Expression $definition.Extent.Text

# Run only the extracted function with in-memory registry stand-ins; never load the supervisor.
$script:removed = @(); $script:children = @(); $script:values = @()
function Test-Path { param([string]$LiteralPath) return $true }
function Get-ChildItem { param([string]$LiteralPath) return $script:children }
function Get-Item {
  param([string]$LiteralPath)
  return [pscustomobject]@{} | Add-Member -MemberType ScriptMethod -Name GetValueNames -Value { return $script:values } -PassThru
}
function Remove-Item { param([string]$LiteralPath) $script:removed += $LiteralPath }
$parent = 'HKCU:\Software\LightMark'
Remove-OwnedMetadataParent $parent @($parent)
if ($script:removed.Count) { throw 'A preexisting empty parent was deleted.' }
Remove-OwnedMetadataParent $parent @()
if ($script:removed.Count -ne 1 -or $script:removed[0] -ne $parent) { throw 'A new empty parent was not cleaned.' }
$script:removed = @(); $script:children = @('foreign-product')
Remove-OwnedMetadataParent $parent @()
if ($script:removed.Count) { throw 'A parent containing another product was deleted.' }
$script:children = @(); $script:values = @('foreign-setting')
Remove-OwnedMetadataParent $parent @()
if ($script:removed.Count) { throw 'A parent containing another setting was deleted.' }
Write-Output 'Windows runner metadata ownership checks passed (in-memory mocks only).'
