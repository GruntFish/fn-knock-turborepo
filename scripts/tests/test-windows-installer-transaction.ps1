# Execute the actual generated helper functions in Windows PowerShell 5.1.
# Fixtures use a unique HKLM subkey and temporary files; never the installed product.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Run this regression test with Windows PowerShell 5.1' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$hook = Join-Path $repo 'apps/fn-knock-desktop/native/installer/hooks.nsh'
$writes = @(Get-Content -Encoding UTF8 -LiteralPath $hook | Where-Object { $_ -match '^  FileWriteUTF16LE (?:/BOM )?\$R7 "(.*)"$' })
if ($writes.Count -eq 0) { throw 'The transaction helper must use UTF-16LE writes' }
# Compile the real write instructions: parsing the .nsh text alone misses ANSI
# corruption of Chinese paths on English Windows installations.
$encodingRoot = Join-Path ([IO.Path]::GetTempPath()) ('FnKnock-helper-encoding-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($encodingRoot)
try {
  $generatedPath = Join-Path $encodingRoot 'transaction.ps1'
  $writerPath = Join-Path $encodingRoot 'writer.exe'
  $writerSource = Join-Path $encodingRoot 'writer.nsi'
  $header = @('Unicode true', 'RequestExecutionLevel user', 'SilentInstall silent', '!define FNKNOCK_SERVICE "FnKnock"', ('OutFile "' + $writerPath + '"'), 'Section', ('FileOpen $R7 "' + $generatedPath + '" w'))
  [IO.File]::WriteAllLines($writerSource, @($header) + $writes + @('FileClose $R7', 'SectionEnd'), [Text.UTF8Encoding]::new($true))
  $compiler = Get-Command makensis.exe -ErrorAction SilentlyContinue
  $compilerPath = if ($compiler) { $compiler.Source } else { Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe' }
  & $compilerPath /INPUTCHARSET UTF8 $writerSource | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Could not compile the transaction helper encoding fixture' }
  $writer = [Diagnostics.Process]::Start($writerPath)
  try {
    if (-not $writer.WaitForExit(30000)) { $writer.Kill(); throw 'Transaction helper encoding fixture timed out' }
    if ($writer.ExitCode -ne 0) { throw 'Transaction helper encoding fixture failed' }
  } finally { $writer.Dispose() }
  $bytes = [IO.File]::ReadAllBytes($generatedPath)
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0xff -or $bytes[1] -ne 0xfe) { throw 'Transaction helper must start with a UTF-16LE BOM' }
  $source = [IO.File]::ReadAllText($generatedPath)
  $expected = foreach ($line in $writes) {
    [void]($line -match '^  FileWriteUTF16LE (?:/BOM )?\$R7 "(.*)"$')
    $matches[1].Replace('$\r$\n', "`r`n").Replace('$\"', '"').Replace('$$', '$').Replace('${FNKNOCK_SERVICE}', 'FnKnock')
  }
  if ($source -cne ($expected -join '')) { throw 'NSIS changed the transaction helper text or Chinese paths' }
} finally { Remove-Item -LiteralPath $encodingRoot -Recurse -Force }
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$functions = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($function in $functions) { . ([scriptblock]::Create($function.Extent.Text)) }
function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Expect-Failure([scriptblock]$Operation) {
  $failed = $false
  try { & $Operation } catch { $failed = $true }
  Assert $failed 'Expected the operation to fail closed'
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('FnKnock-transaction-tests-' + [guid]::NewGuid().ToString('N'))
$fixtureKey = 'Software\FnKnock-transaction-tests-' + [guid]::NewGuid().ToString('N')
$base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
try {
  [void][IO.Directory]::CreateDirectory($root)
  $hashFixture = Join-Path $root 'sha256-fixture'
  [IO.File]::WriteAllBytes($hashFixture, [byte[]]@(97, 98, 99))
  Assert ((Get-FnKnockFileSha256 $hashFixture) -ceq 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD') 'File SHA-256 does not match the known abc vector'
  Remove-Item -LiteralPath $hashFixture
  Expect-Failure { Get-FnKnockFileSha256 $hashFixture }
  $Action = 'test'
  $pending = Join-Path $root 'rollback\pending'
  $dataManifest = Join-Path $pending 'data-manifest.json'
  $startupBoundary = Join-Path $pending 'startup.started'
  $registrySnapshot = Join-Path $pending 'registry'
  $shortcutSnapshot = Join-Path $pending 'shortcuts'
  $persistentDataTrees = @('config','data','gateway','waf','certificates','secrets')
  $reg = Join-Path $env:SystemRoot 'System32\reg.exe'
  $registryEntries = @(@{ Name = 'fixture'; SubKey = $fixtureKey; RegKey = 'HKLM\' + $fixtureKey }, @{ Name = 'missing'; SubKey = $fixtureKey + '-missing'; RegKey = 'HKLM\' + $fixtureKey + '-missing' })
  $shortcutEntries = @(@{ Name = 'fixture'; Path = (Join-Path $root 'fixture.lnk') })
  foreach ($directory in @($pending, $registrySnapshot, $shortcutSnapshot, (Join-Path $pending 'data'), (Join-Path $root 'logs'))) { [void][IO.Directory]::CreateDirectory($directory) }
  Snapshot-FnKnockInstallerMetadata
  Restore-FnKnockInstallerMetadata 'first'
  Restore-FnKnockInstallerMetadata 'first'
  Assert (-not (Test-FnKnockRegistryKey $fixtureKey)) 'Missing registry key must be an idempotent success'
  # Reinstall with pre-existing metadata must restore it even when kind is first.
  Remove-Item -LiteralPath $registrySnapshot,$shortcutSnapshot -Recurse -Force
  $key = $base.CreateSubKey($fixtureKey); $key.SetValue('fixture','original'); $key.Dispose()
  [IO.File]::WriteAllText($shortcutEntries[0].Path, 'original shortcut')
  Snapshot-FnKnockInstallerMetadata
  $key = $base.OpenSubKey($fixtureKey, $true); $key.SetValue('fixture','changed'); $key.Dispose()
  Restore-FnKnockInstallerMetadata 'first'
  $key = $base.OpenSubKey($fixtureKey); Assert ($key.GetValue('fixture') -eq 'original') 'Registry metadata was not restored'; $key.Dispose()
  Assert ((Get-Content -Raw -LiteralPath $shortcutEntries[0].Path) -eq 'original shortcut') 'Shortcut was not restored'
  $permissionKey = $base.OpenSubKey($fixtureKey, [Microsoft.Win32.RegistryKeyPermissionCheck]::ReadWriteSubTree, [System.Security.AccessControl.RegistryRights]::ChangePermissions -bor [System.Security.AccessControl.RegistryRights]::ReadPermissions)
  $accessSection = [System.Security.AccessControl.AccessControlSections]::Access
  $originalAclSddl = $permissionKey.GetAccessControl().GetSecurityDescriptorSddlForm($accessSection)
  try {
    $deniedAcl = $permissionKey.GetAccessControl()
    $deny = [System.Security.AccessControl.RegistryAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User, [System.Security.AccessControl.RegistryRights]::Delete, [System.Security.AccessControl.AccessControlType]::Deny)
    $deniedAcl.AddAccessRule($deny); $permissionKey.SetAccessControl($deniedAcl)
    Expect-Failure { Restore-FnKnockInstallerMetadata 'first' }
    Assert (Test-Path -LiteralPath (Join-Path $registrySnapshot 'fixture.reg')) 'Failed registry restore lost its snapshot'
  } finally {
    try {
      # SetAccessControl persists only sections marked as modified. A freshly
      # read original ACL has no dirty sections, so applying it is a no-op.
      $restoredAcl = $permissionKey.GetAccessControl()
      $restoredAcl.SetSecurityDescriptorSddlForm($originalAclSddl, $accessSection)
      $permissionKey.SetAccessControl($restoredAcl)
    } finally { $permissionKey.Dispose() }
  }
  $key = $base.OpenSubKey($fixtureKey)
  try {
    Assert ($key.GetAccessControl().GetSecurityDescriptorSddlForm($accessSection) -eq $originalAclSddl) 'Permission fixture did not restore its original registry ACL'
  } finally { $key.Dispose() }


  [void][IO.Directory]::CreateDirectory((Join-Path $root 'data\storage'))
  [IO.File]::WriteAllText((Join-Path $root 'data\storage\db'), 'original')
  $kind = 'first'
  Snapshot-FnKnockPersistentData
  [IO.File]::WriteAllText((Join-Path $root 'data\storage\db'), 'modified')
  [void][IO.Directory]::CreateDirectory((Join-Path $root 'secrets'))
  [IO.File]::WriteAllText((Join-Path $root 'secrets\created'), 'new')
  Restore-FnKnockPersistentData 'first'
  Assert ((Get-Content -Raw -LiteralPath (Join-Path $root 'data\storage\db')) -eq 'original') 'Original data was not restored'
  Assert (-not (Test-Path -LiteralPath (Join-Path $root 'secrets'))) 'Originally absent directory was not restored to absence'
  Restore-FnKnockPersistentData 'first'
  # Same-length corruption must be caught before touching live data.
  [IO.File]::WriteAllText((Join-Path $pending 'data\data\storage\db'), 'corrupt!')
  Expect-Failure { Restore-FnKnockPersistentData 'first' }
  Assert ((Get-Content -Raw -LiteralPath (Join-Path $root 'data\storage\db')) -eq 'original') 'Corrupted backup modified live data'
  # Exercise the transaction entry point, not just its data restore subfunction.
  $marker = Join-Path $pending 'transaction.pending'
  $snapshotReady = Join-Path $pending 'snapshot.ready'
  [IO.File]::WriteAllText($snapshotReady, 'ready')
  $script:runtimeMutated = $false
  function Remove-PartialFnKnockInstall { $script:runtimeMutated = $true }
  function Restore-FnKnockUpgrade { $script:runtimeMutated = $true }
  foreach ($transactionKind in @('first','repair-first','upgrade')) {
    [IO.File]::WriteAllText($marker, $transactionKind)
    Expect-Failure { Rollback-FnKnockTransaction }
    Assert (-not $script:runtimeMutated) 'Corrupt snapshot allowed runtime removal or replacement'
    Assert (Test-Path -LiteralPath $marker) 'Corrupt snapshot recovery lost its pending marker'
  }
  Remove-Item -LiteralPath $snapshotReady
  $mutationMarker = Join-Path $pending 'mutation.started'
  [IO.File]::WriteAllText($mutationMarker, 'armed')
  Expect-Failure { Rollback-FnKnockTransaction }
  Assert (Test-Path -LiteralPath $marker) 'Missing ready marker after startup silently discarded recovery state'
  Remove-Item -LiteralPath $marker,$mutationMarker
  [IO.File]::WriteAllText((Join-Path $pending 'snapshot.format'), '2')
  Remove-Item -LiteralPath $dataManifest
  Expect-Failure { Restore-FnKnockPersistentData 'first' }
  Remove-Item -LiteralPath (Join-Path $pending 'snapshot.format')
  Restore-FnKnockPersistentData 'first'
  Assert ((Get-Content -Raw -LiteralPath (Join-Path $root 'data\storage\db')) -eq 'original') 'Legacy first transaction must retain live data'

  # Read only current-launch failures, preferring message while accepting old error.
  function Get-CimInstance { [pscustomobject]@{ ProcessId = $script:fixtureServicePid } }
  $script:fixtureServicePid = 1234
  [void][IO.Directory]::CreateDirectory((Join-Path $root 'state'))
  $boundary = [DateTime]::UtcNow.AddSeconds(-5)
  [IO.File]::WriteAllText($startupBoundary, $boundary.ToString('o'))
  $status = @{ service_pid = 1234; updated_at = [DateTime]::UtcNow.ToString('o'); message = 'current failure'; error = 'legacy failure'; error_code = 'test_code' }
  $statusPath = Join-Path $root 'state\status.json'
  function Save-FixtureStatus { [IO.File]::WriteAllText($statusPath, ($status | ConvertTo-Json)) }
  Save-FixtureStatus
  Assert ((Get-FnKnockStartupDetail) -eq 'current failure [test_code]') 'Current message/code were not propagated'
  $status.Remove('message'); Save-FixtureStatus
  Assert ((Get-FnKnockStartupDetail) -eq 'legacy failure [test_code]') 'Legacy error field was not accepted'
  $status.updated_at = $boundary.AddSeconds(-1).ToString('o'); Save-FixtureStatus
  Assert ([string]::IsNullOrEmpty((Get-FnKnockStartupDetail))) 'Historical failure was accepted'
  $status.updated_at = [DateTime]::UtcNow.ToString('o'); $status.service_pid = 5678; Save-FixtureStatus
  Assert ([string]::IsNullOrEmpty((Get-FnKnockStartupDetail))) 'Wrong process failure was accepted'
  $script:fixtureServicePid = 0; $status.service_pid = 1234; Save-FixtureStatus
  Assert ((Get-FnKnockStartupDetail) -eq 'legacy failure [test_code]') 'Current stopped-service failure was lost'
  Write-Host 'PowerShell 5.1 transaction regression tests passed'
} finally {
  $base.DeleteSubKeyTree($fixtureKey, $false); $base.DeleteSubKeyTree($fixtureKey + '-missing', $false); $base.Dispose()
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
