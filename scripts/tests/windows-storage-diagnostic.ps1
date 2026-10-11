# Called by the runtime smoke harness on its test-owned, stopped database.
param([Parameter(Mandatory=$true)][string]$ServiceExecutable, [Parameter(Mandatory=$true)][string]$Database, [switch]$ExpectRunning)
$ErrorActionPreference = 'Stop'
function Run-Diagnostic([string[]]$Arguments) {
  $info = [Diagnostics.ProcessStartInfo]::new()
  $info.FileName = $ServiceExecutable; $info.UseShellExecute = $false
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  foreach ($argument in $Arguments) { [void]$info.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($info)
  try {
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $text = $stdout.GetAwaiter().GetResult(); $errorText = $stderr.GetAwaiter().GetResult()
    if ($errorText) { throw "Diagnostic wrote unexpected stderr: $errorText" }
    return @{ code = $process.ExitCode; report = ($text | ConvertFrom-Json) }
  } finally { $process.Dispose() }
}
function Get-SourceHashes {
  $hashes = [ordered]@{}
  foreach ($suffix in @('','-wal','-shm','-journal')) {
    $path = $Database + $suffix
    $hashes[$suffix] = if (Test-Path -LiteralPath $path) { (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash } else { 'absent' }
  }
  return ($hashes | ConvertTo-Json -Compress)
}
if ($ExpectRunning) {
  $running = Run-Diagnostic @('diagnose-storage','--json')
  if ($running.code -ne 2) { throw 'Diagnostic accepted the running service database' }
  $global:LASTEXITCODE = 0
  return
}
$before = Get-SourceHashes
$success = Run-Diagnostic @('diagnose-storage','--json')
if ($success.code -ne 0 -or -not $success.report.result.initialization_passed -or $success.report.service_identity_verified) { throw 'Offline healthy database diagnostic failed or claimed service identity verification' }
if ((Get-SourceHashes) -cne $before) { throw 'Diagnostic modified the source database or companions' }
# A conflicting writer must prevent copying, not be bypassed.
$writer = [IO.File]::Open($Database, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
try {
  $locked = Run-Diagnostic @('diagnose-storage','--json')
  if ($locked.code -ne 2) { throw 'Diagnostic accepted an active database writer' }
} finally { $writer.Dispose() }
# Explicit path must win over the healthy default database.
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('fn-knock-invalid-db-' + [guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($fixture, 'not a SQLite database')
try {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $fixture).Hash
  $bad = Run-Diagnostic @('diagnose-storage','--database',$fixture,'--json')
  if ($bad.code -ne 1 -or $bad.report.result.failure.code -notlike 'sqlite:NotADatabase:*') { throw 'Diagnostic did not report the explicitly selected invalid database' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $fixture).Hash -ne $hash) { throw 'Diagnostic changed invalid source bytes' }
} finally { Remove-Item -LiteralPath $fixture -Force }
if ((Get-SourceHashes) -cne $before) { throw 'Diagnostic failure paths modified the source' }
Write-Host 'Offline diagnostic source-preservation tests passed'
$global:LASTEXITCODE = 0
