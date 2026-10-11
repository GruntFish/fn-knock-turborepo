!include "LogicLib.nsh"

; Public installer branding and transactional service lifecycle hooks.
Caption "Knock 敲门"
UninstallCaption "卸载 Knock 敲门"
!define MUI_WELCOMEPAGE_TITLE "欢迎使用 Knock 敲门 安装程序"
!define MUI_WELCOMEPAGE_TEXT "此向导将安装 Knock 敲门。$\r$\n$\r$\n单击“下一步”继续。"
!define MUI_DIRECTORYPAGE_TEXT_TOP "请选择 Knock 敲门 的安装位置。"
!define MUI_FINISHPAGE_TITLE "Knock 敲门 安装完成"
!define MUI_FINISHPAGE_TEXT "Knock 敲门 已成功安装。"
!define MUI_UNWELCOMEPAGE_TITLE "卸载 Knock 敲门"
!define MUI_UNWELCOMEPAGE_TEXT "此向导将从计算机中卸载 Knock 敲门。"

!define FNKNOCK_SERVICE "FnKnock"
Var FnKnockTransactionDir
Var FnKnockTransactionScript
Var FnKnockTransactionReady
Var FnKnockTransactionCreated

Function FnKnockProtectTransactionDirectory
  StrCpy $0 0
  StrCpy $1 ""

  ; Program Files is the protected parent. GetFileAttributes failure also
  ; produces all bits set and is rejected by the same mask.
  Push $2
  System::Call 'kernel32::GetFileAttributesW(w "$FnKnockTransactionDir") i.r2'
  IntOp $2 $2 & 0x400
  ${If} $2 != 0
    StrCpy $0 1
    StrCpy $1 "the installer transaction directory is a reparse point or could not be inspected"
    Pop $2
    Return
  ${EndIf}
  Pop $2

  ; This directory was just created below Program Files and was already checked
  ; for reparse-point substitution. Only claim the root here. The helper file
  ; inherits from this protected directory and is handled separately below.
  nsExec::ExecToStack '"$SYSDIR\takeown.exe" /F "$FnKnockTransactionDir" /A'
  Pop $0
  Pop $1
  ${If} $0 != 0
    StrCpy $1 "unable to take ownership of the installer transaction directory"
    Return
  ${EndIf}

  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$FnKnockTransactionDir" /reset /L /Q'
  Pop $0
  Pop $1
  ${If} $0 != 0
    StrCpy $1 "unable to reset the installer transaction directory ACL"
    Return
  ${EndIf}

  ; Establish a safe write allowlist before the helper exists. Some Windows 10
  ; builds preserve read-only application-package ACEs here; once loaded from
  ; this non-writable directory, the helper replaces the DACL through the .NET
  ; ACL API and verifies the exact canonical result.
  ; Never apply directory-only (OI)(CI) rules recursively to a regular file.
  ; Windows 11 can protect that file while leaving it with an empty effective
  ; DACL. Configure only the directory and let the known helper inherit it.
  nsExec::ExecToStack '"$SYSDIR\icacls.exe" "$FnKnockTransactionDir" /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /L /Q'
  Pop $0
  Pop $1
  ${If} $0 != 0
    StrCpy $1 "unable to apply the installer transaction directory allowlist"
    Return
  ${EndIf}

  ; Some Windows 11 configurations reject the owner transfer when icacls is a
  ; direct NSIS child, while the same elevated token succeeds when PowerShell
  ; dispatches icacls. Use the latter path before PowerShell reads the helper;
  ; the helper independently reapplies and verifies the exact owner/DACL.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = $\'Stop$\'; & $\'$SYSDIR\icacls.exe$\' $\'$FnKnockTransactionDir$\' /setowner $\'*S-1-5-18$\' /L /Q; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    StrCpy $1 "unable to transfer the installer transaction directory ownership through PowerShell (exit $0): $1"
    Return
  ${EndIf}

  ${If} ${FileExists} "$FnKnockTransactionScript"
    Push $2
    System::Call 'kernel32::GetFileAttributesW(w "$FnKnockTransactionScript") i.r2'
    IntOp $2 $2 & 0x400
    ${If} $2 != 0
      StrCpy $0 1
      StrCpy $1 "the installer transaction helper is a reparse point or could not be inspected"
      Pop $2
      Return
    ${EndIf}
    Pop $2
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = $\'Stop$\'; & $\'$SYSDIR\icacls.exe$\' $\'$FnKnockTransactionScript$\' /setowner $\'*S-1-5-18$\' /L /Q; if ($$LASTEXITCODE -ne 0) { exit $$LASTEXITCODE }"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      StrCpy $1 "unable to transfer the installer transaction helper ownership through PowerShell (exit $0): $1"
      Return
    ${EndIf}
  ${EndIf}
  StrCpy $0 0
  StrCpy $1 ""
FunctionEnd

Function FnKnockCleanupTransactionDirectory
  ${If} $FnKnockTransactionCreated == 1
    RMDir /r "$FnKnockTransactionDir"
    StrCpy $FnKnockTransactionCreated 0
    StrCpy $FnKnockTransactionReady 0
  ${EndIf}
FunctionEnd

; Keep the PowerShell command line short enough for NSIS' string limit. The
; transaction implementation is emitted below protected Program Files in small
; chunks and reused by PREINSTALL, POSTINSTALL and failure callbacks.
Function FnKnockWriteTransactionScript
  StrCpy $0 0
  StrCpy $1 ""

  ; The initialized helper is immutable and self-verifying. Never reset its ACL
  ; again between transaction actions.
  ${If} $FnKnockTransactionReady == 1
    Return
  ${EndIf}

  Push $2
  System::Call 'kernel32::GetCurrentProcessId() i.r2'
  StrCpy $FnKnockTransactionDir "$PROGRAMFILES64\.FnKnock-installer-$2"
  StrCpy $FnKnockTransactionScript "$FnKnockTransactionDir\transaction.ps1"
  Pop $2

  ; A PID collision or previous residue must never be reused. Prove absence;
  ; access denied and every error except FILE/PATH_NOT_FOUND fail closed.
  Push $2
  Push $3
  System::Call 'kernel32::GetFileAttributesW(w "$FnKnockTransactionDir") i.r2 ?e'
  Pop $3
  ${If} $2 != -1
    StrCpy $0 1
    StrCpy $1 "the installer transaction directory existed before secure initialization"
    Pop $3
    Pop $2
    Return
  ${EndIf}
  ${If} $3 != 2
  ${AndIf} $3 != 3
    StrCpy $0 1
    StrCpy $1 "unable to prove that the installer transaction directory is absent"
    Pop $3
    Pop $2
    Return
  ${EndIf}
  Pop $3
  Pop $2

  ClearErrors
  CreateDirectory "$FnKnockTransactionDir"
  ${If} ${Errors}
    StrCpy $0 1
    StrCpy $1 "unable to create the installer transaction directory"
    Return
  ${EndIf}
  StrCpy $FnKnockTransactionCreated 1

  Call FnKnockProtectTransactionDirectory
  ${If} $0 != 0
    Return
  ${EndIf}

  ClearErrors
  FileOpen $R7 "$FnKnockTransactionScript" w
  ${If} ${Errors}
    StrCpy $0 1
    StrCpy $1 "unable to create the installer transaction helper"
    Return
  ${EndIf}

  ; Preserve Chinese paths on every Windows ANSI code page; PowerShell 5.1 reads the BOM.
  FileWriteUTF16LE /BOM $R7 "[CmdletBinding()]$\r$\n"
  FileWriteUTF16LE $R7 "param([Parameter(Mandatory=$$true)][ValidateSet('begin','stop','snapshot','rollback','protect-rollback','prepare-start','wait-ready')][string]$$Action, [Parameter(Mandatory=$$true)][string]$$InstallDir, [Parameter(Mandatory=$$true)][string]$$ProgramFilesDir)$\r$\n"
  FileWriteUTF16LE $R7 "$$ErrorActionPreference = 'Stop'$\r$\n"
  ; Keep every initialization and action error within the concise diagnostic
  ; boundary. This must begin after param(), which PowerShell requires first.
  FileWriteUTF16LE $R7 "try {$\r$\n"
  FileWriteUTF16LE $R7 "function Assert-FnKnockInstallerAcl($$Acl, [string]$$Path, [string[]]$$AllowedSids) {$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not $$Acl.AreAccessRulesProtected) { throw ('installer ACL inherits permissions: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$Acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-18') { throw ('installer object is not owned by SYSTEM: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "  $$rules = @($$Acl.GetAccessRules($$true, $$false, [System.Security.Principal.SecurityIdentifier]))$\r$\n"
  FileWriteUTF16LE $R7 "  $$isDirectory = $$Acl -is [System.Security.AccessControl.DirectorySecurity]$\r$\n"
  ; Windows enforces read-compatible Program Files ACEs for packaged apps even
  ; after SetAccessControl replaces a protected DACL. Accept those two
  ; well-known identities only when their access mask cannot mutate contents,
  ; delete objects, change the DACL/owner, or request generic write/all access.
  FileWriteUTF16LE $R7 "  $$platformReadSids = @('S-1-15-2-1','S-1-15-2-2'); $$knownSids = @($$AllowedSids) + $$platformReadSids$\r$\n"
  FileWriteUTF16LE $R7 "  if (@($$rules | Where-Object { $$knownSids -notcontains $$_.IdentityReference.Value }).Count -ne 0) { throw ('installer ACL has unexpected identities: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "  $$full = [System.Security.AccessControl.FileSystemRights]::FullControl; $$allow = [System.Security.AccessControl.AccessControlType]::Allow; $$noInheritance = [System.Security.AccessControl.InheritanceFlags]::None; $$container = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit; $$both = $$container -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit; $$noPropagation = [System.Security.AccessControl.PropagationFlags]::None; $$inheritOnly = [System.Security.AccessControl.PropagationFlags]::InheritOnly$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$rule in @($$rules | Where-Object { $$AllowedSids -contains $$_.IdentityReference.Value })) { if ($$rule.AccessControlType -ne $$allow -or $$rule.FileSystemRights -ne $$full -or $$rule.PropagationFlags -ne $$noPropagation -or ($$rule.InheritanceFlags -ne $$noInheritance -and $$rule.InheritanceFlags -ne $$both)) { throw ('installer ACL contains a non-exact trusted rule: ' + $$Path) } }$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$rule in @($$rules | Where-Object { $$platformReadSids -contains $$_.IdentityReference.Value })) { $$rightsMask = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int32]$$rule.FileSystemRights), 0); if ($$rule.AccessControlType -ne $$allow -or $$rightsMask -eq 0 -or ($$rightsMask -band [uint32]0x530D0146) -ne 0) { throw ('installer ACL gives an application package unsafe access: ' + $$Path) }; if ((-not $$isDirectory -and ($$rule.InheritanceFlags -ne $$noInheritance -or $$rule.PropagationFlags -ne $$noPropagation)) -or ($$isDirectory -and (($$rule.InheritanceFlags -band (-bnot $$both)) -ne $$noInheritance -or ($$rule.PropagationFlags -ne $$noPropagation -and $$rule.PropagationFlags -ne $$inheritOnly) -or ($$rule.PropagationFlags -eq $$inheritOnly -and $$rule.InheritanceFlags -eq $$noInheritance)))) { throw ('installer ACL has unexpected application-package inheritance: ' + $$Path) } }$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$sid in $$AllowedSids) { $$sidRules = @($$rules | Where-Object { $$_.IdentityReference.Value -eq $$sid }); if ($$sidRules.Count -ne 1) { throw ('installer ACL has an unexpected trusted SID rule count: ' + $$Path) }; $$expectedInheritance = if ($$isDirectory) { $$both } else { $$noInheritance }; if ($$sidRules[0].InheritanceFlags -ne $$expectedInheritance) { throw ('installer ACL has unexpected trusted inheritance flags: ' + $$Path) } }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "function Assert-FnKnockInstallerTreeAcl([string]$$Path) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$allowedSids = @('S-1-5-18','S-1-5-32-544')$\r$\n"
  FileWriteUTF16LE $R7 "  $$queue = [System.Collections.Generic.Queue[string]]::new()$\r$\n"
  FileWriteUTF16LE $R7 "  $$queue.Enqueue([IO.Path]::GetFullPath($$Path))$\r$\n"
  FileWriteUTF16LE $R7 "  while ($$queue.Count -gt 0) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$directory = $$queue.Dequeue()$\r$\n"
  FileWriteUTF16LE $R7 "    $$attributes = [IO.File]::GetAttributes($$directory)$\r$\n"
  FileWriteUTF16LE $R7 "    if (($$attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('installer tree contains a reparse point: ' + $$directory) }$\r$\n"
  FileWriteUTF16LE $R7 "    Assert-FnKnockInstallerAcl ([IO.Directory]::GetAccessControl($$directory)) $$directory $$allowedSids$\r$\n"
  FileWriteUTF16LE $R7 "    foreach ($$entry in [IO.Directory]::EnumerateFileSystemEntries($$directory)) {$\r$\n"
  FileWriteUTF16LE $R7 "      $$entryAttributes = [IO.File]::GetAttributes($$entry)$\r$\n"
  FileWriteUTF16LE $R7 "      if (($$entryAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('installer tree contains a reparse point: ' + $$entry) }$\r$\n"
  FileWriteUTF16LE $R7 "      if (($$entryAttributes -band [IO.FileAttributes]::Directory) -ne 0) { $$queue.Enqueue($$entry) } else { Assert-FnKnockInstallerAcl ([IO.File]::GetAccessControl($$entry)) $$entry $$allowedSids }$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$$serviceName = '${FNKNOCK_SERVICE}'$\r$\n"
  FileWriteUTF16LE $R7 "$$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')$\r$\n"
  FileWriteUTF16LE $R7 "$$administratorsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')$\r$\n"
  ; NSIS is a 32-bit executable even for x64 bundles. Pass its trusted
  ; $PROGRAMFILES64 value instead of resolving ProgramFiles inside WOW64 PS.
  FileWriteUTF16LE $R7 "$$programFiles = $$ProgramFilesDir$\r$\n"
  FileWriteUTF16LE $R7 "if ([string]::IsNullOrWhiteSpace($$programFiles) -or -not [IO.Path]::IsPathRooted($$programFiles) -or $$programFiles.StartsWith('\\')) { throw 'the 64-bit ProgramFiles known folder is invalid' }$\r$\n"
  FileWriteUTF16LE $R7 "$$programFiles = [IO.Path]::GetFullPath($$programFiles).TrimEnd([char]'\')$\r$\n"
  FileWriteUTF16LE $R7 "$$allowedInstallRoot = [IO.Path]::GetFullPath((Join-Path $$programFiles 'Knock 敲门')).TrimEnd([char]'\')$\r$\n"
  FileWriteUTF16LE $R7 "$$legacyInstallRoot = [IO.Path]::GetFullPath((Join-Path $$allowedInstallRoot 'current')).TrimEnd([char]'\')$\r$\n"
  FileWriteUTF16LE $R7 "$$install = [IO.Path]::GetFullPath($$InstallDir).TrimEnd([char]'\')$\r$\n"
  FileWriteUTF16LE $R7 "$$isCurrentInstallRoot = $$install.Equals($$allowedInstallRoot, [StringComparison]::OrdinalIgnoreCase)$\r$\n"
  FileWriteUTF16LE $R7 "$$isLegacyInstallRoot = $$install.Equals($$legacyInstallRoot, [StringComparison]::OrdinalIgnoreCase)$\r$\n"
  FileWriteUTF16LE $R7 "if (-not $$isCurrentInstallRoot -and -not $$isLegacyInstallRoot) { throw ('InstallDir must be Program Files\Knock 敲门: ' + $$install) }$\r$\n"
  ; Enumerate each trusted parent so access-denied entries cannot be mistaken
  ; for absent paths by Directory.Exists.
  FileWriteUTF16LE $R7 "$$fnKnockEntry = [IO.DirectoryInfo]::new($$programFiles).EnumerateFileSystemInfos('Knock 敲门', [IO.SearchOption]::TopDirectoryOnly) | Select-Object -First 1$\r$\n"
  FileWriteUTF16LE $R7 "if ($$null -ne $$fnKnockEntry -and (($$fnKnockEntry.Attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($$fnKnockEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Program Files\Knock 敲门 is not a trusted ordinary directory' }$\r$\n"
  FileWriteUTF16LE $R7 "$$legacyEntry = $$null$\r$\n"
  FileWriteUTF16LE $R7 "if ($$isLegacyInstallRoot -and $$null -ne $$fnKnockEntry) { $$legacyEntry = [IO.DirectoryInfo]::new($$allowedInstallRoot).EnumerateFileSystemInfos('current', [IO.SearchOption]::TopDirectoryOnly) | Select-Object -First 1; if ($$null -ne $$legacyEntry -and (($$legacyEntry.Attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($$legacyEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Program Files\Knock 敲门\current is not a trusted ordinary directory' } }$\r$\n"
  FileWriteUTF16LE $R7 "$$installEntry = if ($$isCurrentInstallRoot) { $$fnKnockEntry } else { $$legacyEntry }$\r$\n"
  FileWriteUTF16LE $R7 "$$programData = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)$\r$\n"
  FileWriteUTF16LE $R7 "if ([string]::IsNullOrWhiteSpace($$programData) -or -not [IO.Path]::IsPathRooted($$programData) -or $$programData.StartsWith('\\')) { throw 'the CommonApplicationData known folder is invalid' }$\r$\n"
  FileWriteUTF16LE $R7 "$$programData = [IO.Path]::GetFullPath($$programData)$\r$\n"
  FileWriteUTF16LE $R7 "$$root = Join-Path $$programData 'FnKnock'$\r$\n"
  FileWriteUTF16LE $R7 "$$state = Join-Path $$root 'state'$\r$\n"
  FileWriteUTF16LE $R7 "$$rollback = Join-Path $$root 'rollback'$\r$\n"
  FileWriteUTF16LE $R7 "$$pending = Join-Path $$rollback 'pending'$\r$\n"
  FileWriteUTF16LE $R7 "$$persistentDataTrees = @('config','data','gateway','waf','certificates','secrets')$\r$\n"
  FileWriteUTF16LE $R7 "$$marker = Join-Path $$pending 'transaction.pending'$\r$\n"
  FileWriteUTF16LE $R7 "$$snapshotReady = Join-Path $$pending 'snapshot.ready'$\r$\n"
  FileWriteUTF16LE $R7 "$$dataManifest = Join-Path $$pending 'data-manifest.json'$\r$\n"
  FileWriteUTF16LE $R7 "$$startupBoundary = Join-Path $$pending 'startup.started'$\r$\n"
  FileWriteUTF16LE $R7 "$$serviceExe = Join-Path $$install 'fn-knock-service.exe'$\r$\n"
  FileWriteUTF16LE $R7 "$$gatewayExe = Join-Path $$install 'fn-knock-gateway.exe'$\r$\n"
  FileWriteUTF16LE $R7 "$$bundleIdentityPath = Join-Path $$install 'bundle.json'$\r$\n"
  FileWriteUTF16LE $R7 "$$registrySnapshot = Join-Path $$pending 'registry'$\r$\n"
  FileWriteUTF16LE $R7 "$$shortcutSnapshot = Join-Path $$pending 'shortcuts'$\r$\n"
  FileWriteUTF16LE $R7 "$$systemDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::System)$\r$\n"
  FileWriteUTF16LE $R7 "if ([string]::IsNullOrWhiteSpace($$systemDirectory) -or -not [IO.Path]::IsPathRooted($$systemDirectory) -or $$systemDirectory.StartsWith('\\')) { throw 'the System known folder is invalid' }$\r$\n"
  FileWriteUTF16LE $R7 "$$systemDirectory = [IO.Path]::GetFullPath($$systemDirectory)$\r$\n"
  FileWriteUTF16LE $R7 "$$sc = Join-Path $$systemDirectory 'sc.exe'$\r$\n"
  FileWriteUTF16LE $R7 "$$icacls = Join-Path $$systemDirectory 'icacls.exe'$\r$\n"
  FileWriteUTF16LE $R7 "$$takeown = Join-Path $$systemDirectory 'takeown.exe'$\r$\n"
  FileWriteUTF16LE $R7 "$$reg = Join-Path $$systemDirectory 'reg.exe'$\r$\n"
  FileWriteUTF16LE $R7 "if (-not (Test-Path -LiteralPath $$sc -PathType Leaf) -or -not (Test-Path -LiteralPath $$icacls -PathType Leaf) -or -not (Test-Path -LiteralPath $$takeown -PathType Leaf) -or -not (Test-Path -LiteralPath $$reg -PathType Leaf)) { throw 'required System32 tools are missing' }$\r$\n"
  FileWriteUTF16LE $R7 "$$registryEntries = @([pscustomobject]@{ Name = 'product'; SubKey = 'Software\KCI-LNK Corporation\Knock 敲门'; RegKey = 'HKLM\Software\KCI-LNK Corporation\Knock 敲门' }, [pscustomobject]@{ Name = 'uninstall'; SubKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Knock 敲门'; RegKey = 'HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\Knock 敲门' })$\r$\n"
  FileWriteUTF16LE $R7 "$$commonPrograms = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms)$\r$\n"
  FileWriteUTF16LE $R7 "$$commonDesktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)$\r$\n"
  FileWriteUTF16LE $R7 "foreach ($$knownFolder in @($$commonPrograms, $$commonDesktop)) { if ([string]::IsNullOrWhiteSpace($$knownFolder) -or -not [IO.Path]::IsPathRooted($$knownFolder) -or $$knownFolder.StartsWith('\\')) { throw 'an all-users shortcut known folder is invalid' } }$\r$\n"
  FileWriteUTF16LE $R7 "$$shortcutEntries = @([pscustomobject]@{ Name = 'start-menu'; Path = Join-Path $$commonPrograms 'Knock 敲门.lnk' }, [pscustomobject]@{ Name = 'desktop'; Path = Join-Path $$commonDesktop 'Knock 敲门.lnk' })$\r$\n"
  ; A service with our name but a different binary must not receive temporary
  ; ProgramData access or be stopped/deleted by this installer. Older builds
  ; registered the same exact executable without the explicit --service flag.
  FileWriteUTF16LE $R7 "$$existingService = Get-Service -Name $$serviceName -ErrorAction SilentlyContinue$\r$\n"
  FileWriteUTF16LE $R7 "$$serviceRecord = Get-CimInstance -ClassName Win32_Service -Filter 'Name=''FnKnock''' -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "if (($$null -eq $$existingService) -ne ($$null -eq $$serviceRecord)) { throw 'SCM and Win32_Service returned inconsistent FnKnock service state' }$\r$\n"
  FileWriteUTF16LE $R7 "$$expectedServiceCommand = ([char]34 + $$serviceExe + [char]34 + ' --service'); $$legacyServiceCommand = ([char]34 + $$serviceExe + [char]34)$\r$\n"
  FileWriteUTF16LE $R7 "if ($$null -ne $$serviceRecord) { $$registeredCommand = ([string]$$serviceRecord.PathName).Trim(); if (-not $$registeredCommand.Equals($$expectedServiceCommand, [StringComparison]::OrdinalIgnoreCase) -and -not $$registeredCommand.Equals($$legacyServiceCommand, [StringComparison]::OrdinalIgnoreCase)) { throw ('the existing FnKnock service points outside the selected install root or has unexpected arguments: ' + $$registeredCommand) } }$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Stop-FnKnock {$\r$\n"
  FileWriteUTF16LE $R7 "  $$service = Get-Service -Name $$serviceName -ErrorAction SilentlyContinue$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$null -eq $$service) { return }$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$service.Status -ne 'Stopped' -and $$service.Status -ne 'StopPending') { Stop-Service -Name $$serviceName -ErrorAction Stop }$\r$\n"
  FileWriteUTF16LE $R7 "  $$service.Refresh()$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$service.Status -ne 'Stopped') { $$service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20)) }$\r$\n"
  FileWriteUTF16LE $R7 "  $$service.Refresh()$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$service.Status -ne 'Stopped') { throw 'FnKnock did not stop within 20 seconds' }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function New-FnKnockDirectoryAcl($$SystemSid, $$AdministratorsSid, $$ServiceSid, $$ReadSid = $$null) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$acl = [System.Security.AccessControl.DirectorySecurity]::new()$\r$\n"
  FileWriteUTF16LE $R7 "  $$acl.SetAccessRuleProtection($$true, $$false)$\r$\n"
  FileWriteUTF16LE $R7 "  $$inherit = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit$\r$\n"
  FileWriteUTF16LE $R7 "  $$none = [System.Security.AccessControl.PropagationFlags]::None$\r$\n"
  FileWriteUTF16LE $R7 "  $$allow = [System.Security.AccessControl.AccessControlType]::Allow$\r$\n"
  FileWriteUTF16LE $R7 "  [void]$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$SystemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $$inherit, $$none, $$allow))$\r$\n"
  FileWriteUTF16LE $R7 "  [void]$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$AdministratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $$inherit, $$none, $$allow))$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$null -ne $$ServiceSid) { [void]$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$ServiceSid, [System.Security.AccessControl.FileSystemRights]::Modify, $$inherit, $$none, $$allow)) }$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$null -ne $$ReadSid) { [void]$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$ReadSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $$inherit, $$none, $$allow)) }$\r$\n"
  FileWriteUTF16LE $R7 "  return $$acl$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function New-FnKnockFileAcl($$SystemSid, $$AdministratorsSid, $$ServiceSid, $$ReadSid = $$null) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$acl = [System.Security.AccessControl.FileSecurity]::new()$\r$\n"
  FileWriteUTF16LE $R7 "  $$acl.SetAccessRuleProtection($$true, $$false)$\r$\n"
  FileWriteUTF16LE $R7 "  $$allow = [System.Security.AccessControl.AccessControlType]::Allow$\r$\n"
  FileWriteUTF16LE $R7 "  [void]$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$SystemSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $$allow))$\r$\n"
  FileWriteUTF16LE $R7 "  [void]$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$AdministratorsSid, [System.Security.AccessControl.FileSystemRights]::FullControl, $$allow))$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$null -ne $$ServiceSid) { [void]$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$ServiceSid, [System.Security.AccessControl.FileSystemRights]::Modify, $$allow)) }$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$null -ne $$ReadSid) { [void]$$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($$ReadSid, [System.Security.AccessControl.FileSystemRights]::ReadAndExecute, $$allow)) }$\r$\n"
  FileWriteUTF16LE $R7 "  return $$acl$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Set-FnKnockDataTreeAcl([string]$$Path, $$SystemSid, $$AdministratorsSid, $$ServiceSid, $$ReadSid = $$null) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$queue = [System.Collections.Generic.Queue[string]]::new()$\r$\n"
  FileWriteUTF16LE $R7 "  $$queue.Enqueue([IO.Path]::GetFullPath($$Path))$\r$\n"
  FileWriteUTF16LE $R7 "  while ($$queue.Count -gt 0) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$directory = $$queue.Dequeue()$\r$\n"
  FileWriteUTF16LE $R7 "    $$attributes = [IO.File]::GetAttributes($$directory)$\r$\n"
  FileWriteUTF16LE $R7 "    if (($$attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('refusing a reparse point in ProgramData: ' + $$directory) }$\r$\n"
  FileWriteUTF16LE $R7 "    [IO.Directory]::SetAccessControl($$directory, (New-FnKnockDirectoryAcl $$SystemSid $$AdministratorsSid $$ServiceSid $$ReadSid))$\r$\n"
  FileWriteUTF16LE $R7 "    foreach ($$entry in [IO.Directory]::EnumerateFileSystemEntries($$directory)) {$\r$\n"
  FileWriteUTF16LE $R7 "      $$entryAttributes = [IO.File]::GetAttributes($$entry)$\r$\n"
  FileWriteUTF16LE $R7 "      if (($$entryAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('refusing a reparse point in ProgramData: ' + $$entry) }$\r$\n"
  FileWriteUTF16LE $R7 "      if (($$entryAttributes -band [IO.FileAttributes]::Directory) -ne 0) { $$queue.Enqueue($$entry) } else { [IO.File]::SetAccessControl($$entry, (New-FnKnockFileAcl $$SystemSid $$AdministratorsSid $$ServiceSid $$ReadSid)) }$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Assert-NoReparseTree([string]$$Path) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$fullPath = [IO.Path]::GetFullPath($$Path)$\r$\n"
  FileWriteUTF16LE $R7 "  try { $$rootAttributes = [IO.File]::GetAttributes($$fullPath) } catch [IO.FileNotFoundException] { return } catch [IO.DirectoryNotFoundException] { return }$\r$\n"
  FileWriteUTF16LE $R7 "  if (($$rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('refusing a reparse point before a recursive installer operation: ' + $$fullPath) }$\r$\n"
  FileWriteUTF16LE $R7 "  if (($$rootAttributes -band [IO.FileAttributes]::Directory) -eq 0) { return }$\r$\n"
  FileWriteUTF16LE $R7 "  $$queue = [System.Collections.Generic.Queue[string]]::new(); $$queue.Enqueue($$fullPath)$\r$\n"
  FileWriteUTF16LE $R7 "  while ($$queue.Count -gt 0) { $$directory = $$queue.Dequeue(); foreach ($$entry in [IO.Directory]::EnumerateFileSystemEntries($$directory)) { $$attributes = [IO.File]::GetAttributes($$entry); if (($$attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('refusing a reparse point before a recursive installer operation: ' + $$entry) }; if (($$attributes -band [IO.FileAttributes]::Directory) -ne 0) { $$queue.Enqueue($$entry) } } }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Set-FnKnockDataTreeOwner([string]$$Path, [string]$$Icacls) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$ownerArgs = @($$Path, '/setowner', '*S-1-5-18', '/T', '/L', '/Q')$\r$\n"
  FileWriteUTF16LE $R7 "  & $$Icacls @ownerArgs | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  $$ownerExitCode = $$LASTEXITCODE$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$ownerExitCode -ne 0) { throw ('unable to transfer ProgramData\FnKnock ownership to SYSTEM; icacls exited with code ' + $$ownerExitCode) }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"
  FileWriteUTF16LE $R7 "function Bootstrap-FnKnockDataTreeAccess([string]$$Path, [string]$$Takeown, [string]$$Icacls, [string]$$ServiceGrant) {$\r$\n"
  ; takeown's recursive no-follow switch is not documented and is absent on
  ; otherwise supported Windows 10 builds. Claim only the already validated
  ; root with portable takeown syntax. Every recursive operation is delegated
  ; to documented icacls /L, which operates on links rather than their targets.
  FileWriteUTF16LE $R7 "  $$rootAttributes = [IO.File]::GetAttributes($$Path)$\r$\n"
  FileWriteUTF16LE $R7 "  if (($$rootAttributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($$rootAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('refusing an untrusted ProgramData root: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "  $$rootTakeownArgs = @('/F', $$Path, '/A')$\r$\n"
  FileWriteUTF16LE $R7 "  & $$Takeown @rootTakeownArgs | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  $$rootTakeownExitCode = $$LASTEXITCODE$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$rootTakeownExitCode -ne 0) { throw ('unable to take ownership of the ProgramData\FnKnock root; takeown exited with code ' + $$rootTakeownExitCode) }$\r$\n"
  ; Neutralize a stale explicit deny on the now-owned root, then make it
  ; traversable before the recursive owner repair. Keep the live service SID
  ; while begin runs so a failed preflight does not strand the existing runtime
  ; without its normal ProgramData access.
  FileWriteUTF16LE $R7 "  & $$Icacls $$Path /reset /L /Q | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  $$rootResetExitCode = $$LASTEXITCODE$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$rootResetExitCode -ne 0) { throw ('unable to reset the ProgramData\FnKnock root ACL; icacls exited with code ' + $$rootResetExitCode) }$\r$\n"
  FileWriteUTF16LE $R7 "  $$rootGrantArgs = @($$Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not [string]::IsNullOrWhiteSpace($$ServiceGrant)) { $$rootGrantArgs += $$ServiceGrant }$\r$\n"
  FileWriteUTF16LE $R7 "  $$rootGrantArgs += @('/L', '/Q')$\r$\n"
  FileWriteUTF16LE $R7 "  & $$Icacls @rootGrantArgs | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  $$rootGrantExitCode = $$LASTEXITCODE$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$rootGrantExitCode -ne 0) { throw ('unable to grant bootstrap access to the ProgramData\FnKnock root; icacls exited with code ' + $$rootGrantExitCode) }$\r$\n"
  FileWriteUTF16LE $R7 "  $$ownerArgs = @($$Path, '/setowner', '*S-1-5-32-544', '/T', '/L', '/Q')$\r$\n"
  FileWriteUTF16LE $R7 "  & $$Icacls @ownerArgs | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  $$ownerExitCode = $$LASTEXITCODE$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$ownerExitCode -ne 0) { throw ('unable to repair ProgramData\FnKnock ownership; icacls exited with code ' + $$ownerExitCode) }$\r$\n"
  ; Ownership alone does not neutralize an explicit deny ACE left by an old or
  ; interrupted install. Reset the complete DACL before applying the allowlist.
  ; Do not use /C: a skipped child would fail later with an opaque .NET
  ; SetAccessControl UnauthorizedAccessException.
  FileWriteUTF16LE $R7 "  & $$Icacls $$Path /reset /T /L /Q | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  $$resetExitCode = $$LASTEXITCODE$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$resetExitCode -ne 0) { throw ('unable to reset ProgramData\FnKnock ACLs; icacls exited with code ' + $$resetExitCode) }$\r$\n"
  FileWriteUTF16LE $R7 "  $$grantArgs = @($$Path, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F')$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not [string]::IsNullOrWhiteSpace($$ServiceGrant)) { $$grantArgs += $$ServiceGrant }$\r$\n"
  FileWriteUTF16LE $R7 "  $$grantArgs += @('/T', '/L', '/Q')$\r$\n"
  FileWriteUTF16LE $R7 "  & $$Icacls @grantArgs | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  $$grantExitCode = $$LASTEXITCODE$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$grantExitCode -ne 0) { throw ('unable to grant bootstrap access to ProgramData\FnKnock; icacls exited with code ' + $$grantExitCode) }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Assert-TreeCopy([string]$$Source, [string]$$Destination) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$base = (Get-Item -LiteralPath $$Source).FullName.TrimEnd([char]'\')$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$file in Get-ChildItem -LiteralPath $$Source -File -Recurse -Force) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$relative = $$file.FullName.Substring($$base.Length).TrimStart([char]'\')$\r$\n"
  FileWriteUTF16LE $R7 "    $$copy = Join-Path $$Destination $$relative$\r$\n"
  FileWriteUTF16LE $R7 "    if (-not (Test-Path -LiteralPath $$copy -PathType Leaf)) { throw ('rollback snapshot is missing ' + $$relative) }$\r$\n"
  FileWriteUTF16LE $R7 "    if ((Get-Item -LiteralPath $$copy).Length -ne $$file.Length) { throw ('rollback snapshot size mismatch for ' + $$relative) }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Write-FnKnockInstallerDiagnostic([string]$$Event, [string]$$Detail) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$log = Join-Path $$root 'logs\installer.log'$\r$\n"
  FileWriteUTF16LE $R7 "  try {$\r$\n"
  FileWriteUTF16LE $R7 "    Assert-NoReparseTree (Join-Path $$root 'logs')$\r$\n"
  FileWriteUTF16LE $R7 "    if ((Test-Path -LiteralPath $$log) -and (Get-Item -LiteralPath $$log).Length -gt 524288) {$\r$\n"
  FileWriteUTF16LE $R7 "      Move-Item -LiteralPath $$log -Destination ($$log + '.1') -Force$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "    $$record = [ordered]@{ time = [DateTime]::UtcNow.ToString('o'); action = $$Action; event = $$Event; detail = $$Detail }$\r$\n"
  FileWriteUTF16LE $R7 "    [IO.File]::AppendAllText($$log, (($$record | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine), [Text.UTF8Encoding]::new($$false))$\r$\n"
  FileWriteUTF16LE $R7 "  } catch { [Console]::Error.WriteLine('FnKnock installer diagnostic log could not be written') }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"
  ; Hash through .NET: the NSIS child PowerShell may not discover Get-FileHash.
  FileWriteUTF16LE $R7 "function Get-FnKnockFileSha256([string]$$Path) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$sha256 = [Security.Cryptography.SHA256]::Create()$\r$\n"
  FileWriteUTF16LE $R7 "  try {$\r$\n"
  FileWriteUTF16LE $R7 "    $$stream = [IO.File]::OpenRead($$Path)$\r$\n"
  FileWriteUTF16LE $R7 "    try { return [BitConverter]::ToString($$sha256.ComputeHash($$stream)).Replace('-', '') }$\r$\n"
  FileWriteUTF16LE $R7 "    finally { $$stream.Dispose() }$\r$\n"
  FileWriteUTF16LE $R7 "  } finally { $$sha256.Dispose() }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "function Get-FnKnockTreeManifest([string]$$Path) {$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath $$Path)) { return [ordered]@{ exists = $$false; directories = @(); files = @() } }$\r$\n"
  FileWriteUTF16LE $R7 "  Assert-NoReparseTree $$Path$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath $$Path -PathType Container)) { throw ('persistent data tree is not a directory: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "  $$base = (Get-Item -LiteralPath $$Path).FullName.TrimEnd([char]'\')$\r$\n"
  FileWriteUTF16LE $R7 "  $$directories = @(Get-ChildItem -LiteralPath $$Path -Directory -Force -Recurse | ForEach-Object { $$_.FullName.Substring($$base.Length).TrimStart([char]'\') } | Sort-Object)$\r$\n"
  FileWriteUTF16LE $R7 "  $$files = @(Get-ChildItem -LiteralPath $$Path -File -Force -Recurse | Sort-Object FullName | ForEach-Object {$\r$\n"
  FileWriteUTF16LE $R7 "    [ordered]@{ path = $$_.FullName.Substring($$base.Length).TrimStart([char]'\'); size = $$_.Length; sha256 = (Get-FnKnockFileSha256 $$_.FullName) }$\r$\n"
  FileWriteUTF16LE $R7 "  })$\r$\n"
  FileWriteUTF16LE $R7 "  return [ordered]@{ exists = $$true; directories = $$directories; files = $$files }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"
  FileWriteUTF16LE $R7 "function Assert-FnKnockManifestTree([string]$$Path, $$Expected) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$actualJson = Get-FnKnockTreeManifest $$Path | ConvertTo-Json -Compress -Depth 8$\r$\n"
  FileWriteUTF16LE $R7 "  $$expectedJson = $$Expected | ConvertTo-Json -Compress -Depth 8$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$actualJson -cne $$expectedJson) { throw ('persistent data snapshot hash/structure mismatch: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"
  FileWriteUTF16LE $R7 "function Snapshot-FnKnockPersistentData {$\r$\n"
  FileWriteUTF16LE $R7 "  $$trees = [ordered]@{}$\r$\n"
  FileWriteUTF16LE $R7 "  $$hasExistingData = $$false$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$name in $$persistentDataTrees) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$source = Join-Path $$root $$name$\r$\n"
  FileWriteUTF16LE $R7 "    $$trees[$$name] = Get-FnKnockTreeManifest $$source$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$trees[$$name].exists) {$\r$\n"
  FileWriteUTF16LE $R7 "      $$copy = Join-Path (Join-Path $$pending 'data') $$name$\r$\n"
  FileWriteUTF16LE $R7 "      Copy-Item -LiteralPath $$source -Destination $$copy -Recurse -Force$\r$\n"
  FileWriteUTF16LE $R7 "      Assert-FnKnockManifestTree $$copy $$trees[$$name]$\r$\n"
  FileWriteUTF16LE $R7 "      Assert-FnKnockManifestTree $$source $$trees[$$name]$\r$\n"
  FileWriteUTF16LE $R7 "      if (@($$trees[$$name].files | Where-Object { $$name -ne 'data' -or $$_.path -notlike 'runtime\*' }).Count -gt 0) { $$hasExistingData = $$true }$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "  $$manifest = [ordered]@{ schema_version = 1; has_existing_data = $$hasExistingData; trees = $$trees }$\r$\n"
  FileWriteUTF16LE $R7 "  [IO.File]::WriteAllText($$dataManifest, ($$manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($$false))$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$hasExistingData) { [IO.File]::WriteAllText((Join-Path $$pending 'retained-data'), 'retained') }$\r$\n"
  FileWriteUTF16LE $R7 "  Write-FnKnockInstallerDiagnostic 'snapshot' ('kind=' + $$kind + '; has_existing_data=' + $$hasExistingData)$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"
  FileWriteUTF16LE $R7 "function Read-FnKnockPersistentSnapshot {$\r$\n"
  FileWriteUTF16LE $R7 "  if (Test-Path -LiteralPath $$dataManifest -PathType Leaf) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $$dataManifest | ConvertFrom-Json$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$manifest.schema_version -ne 1 -or @($$manifest.trees.PSObject.Properties).Count -ne $$persistentDataTrees.Count) { throw 'invalid persistent data snapshot manifest' }$\r$\n"
  FileWriteUTF16LE $R7 "    # Verify every tree before removing any live data. Only fixed allowlisted roots are used.$\r$\n"
  FileWriteUTF16LE $R7 "    foreach ($$name in $$persistentDataTrees) {$\r$\n"
  FileWriteUTF16LE $R7 "      $$entry = $$manifest.trees.PSObject.Properties[$$name]$\r$\n"
  FileWriteUTF16LE $R7 "      if ($$null -eq $$entry) { throw ('missing snapshot manifest tree: ' + $$name) }$\r$\n"
  FileWriteUTF16LE $R7 "      Assert-FnKnockManifestTree (Join-Path (Join-Path $$pending 'data') $$name) $$entry.Value$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "    return $$manifest$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "  if (Test-Path -LiteralPath (Join-Path $$pending 'snapshot.format')) { throw 'the persistent data snapshot manifest is missing; recovery state was preserved' }$\r$\n"
  FileWriteUTF16LE $R7 "  return $$null$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"
  FileWriteUTF16LE $R7 "function Restore-FnKnockPersistentData([string]$$Kind) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$manifest = Read-FnKnockPersistentSnapshot$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$null -ne $$manifest) {$\r$\n"
  FileWriteUTF16LE $R7 "    foreach ($$name in $$persistentDataTrees) {$\r$\n"
  FileWriteUTF16LE $R7 "      $$current = Join-Path $$root $$name$\r$\n"
  FileWriteUTF16LE $R7 "      if (Test-Path -LiteralPath $$current) { Remove-Item -LiteralPath $$current -Recurse -Force -ErrorAction Stop }$\r$\n"
  FileWriteUTF16LE $R7 "      if ($$manifest.trees.$$name.exists) { Copy-Item -LiteralPath (Join-Path (Join-Path $$pending 'data') $$name) -Destination $$current -Recurse -Force }$\r$\n"
  FileWriteUTF16LE $R7 "      Assert-FnKnockManifestTree $$current $$manifest.trees.$$name$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "  } elseif ($$Kind -eq 'upgrade') {$\r$\n"
  FileWriteUTF16LE $R7 "    # Legacy upgrade snapshots predate manifests. Legacy first installs never backed up data.$\r$\n"
  FileWriteUTF16LE $R7 "    foreach ($$name in $$persistentDataTrees) {$\r$\n"
  FileWriteUTF16LE $R7 "      $$current = Join-Path $$root $$name$\r$\n"
  FileWriteUTF16LE $R7 "      if (Test-Path -LiteralPath $$current) { Remove-Item -LiteralPath $$current -Recurse -Force -ErrorAction Stop }$\r$\n"
  FileWriteUTF16LE $R7 "      $$snapshot = Join-Path (Join-Path $$pending 'data') $$name$\r$\n"
  FileWriteUTF16LE $R7 "      if (Test-Path -LiteralPath $$snapshot) { Copy-Item -LiteralPath $$snapshot -Destination $$current -Recurse -Force; Assert-TreeCopy $$snapshot $$current }$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"
  FileWriteUTF16LE $R7 "function Get-FnKnockStartupDetail {$\r$\n"
  FileWriteUTF16LE $R7 "  try {$\r$\n"
  FileWriteUTF16LE $R7 "    $$boundary = [DateTimeOffset]::Parse((Get-Content -Raw -LiteralPath $$startupBoundary)).UtcDateTime$\r$\n"
  FileWriteUTF16LE $R7 "    $$status = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $$root 'state\status.json') | ConvertFrom-Json$\r$\n"
  FileWriteUTF16LE $R7 "    $$updated = if ($$status.updated_at -is [DateTime]) { $$status.updated_at.ToUniversalTime() } else { [DateTimeOffset]::Parse([string]$$status.updated_at).UtcDateTime }$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$updated -lt $$boundary -or $$updated -gt [DateTime]::UtcNow.AddSeconds(5)) { return '' }$\r$\n"
  FileWriteUTF16LE $R7 "    if ([uint32]$$status.service_pid -eq 0) { return '' }$\r$\n"
  FileWriteUTF16LE $R7 "    $$record = Get-CimInstance -ClassName Win32_Service -Filter 'Name=''FnKnock''' -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$null -ne $$record -and [uint32]$$record.ProcessId -ne 0 -and [uint32]$$record.ProcessId -ne [uint32]$$status.service_pid) { return '' }$\r$\n"
  FileWriteUTF16LE $R7 "    $$detail = if ($$status.message) { [string]$$status.message } elseif ($$status.error) { [string]$$status.error } else { '' }$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$status.error_code) { $$detail += ' [' + [string]$$status.error_code + ']' }$\r$\n"
  FileWriteUTF16LE $R7 "    Write-FnKnockInstallerDiagnostic 'service-status' ($$status | ConvertTo-Json -Compress -Depth 5)$\r$\n"
  FileWriteUTF16LE $R7 "    return $$detail$\r$\n"
  FileWriteUTF16LE $R7 "  } catch { return '' }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"

  FileWriteUTF16LE $R7 "function Test-FnKnockRegistryKey([string]$$SubKey) {$\r$\n"
  FileWriteUTF16LE $R7 "  $$baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)$\r$\n"
  FileWriteUTF16LE $R7 "  try { $$key = $$baseKey.OpenSubKey($$SubKey, $$false); try { return $$null -ne $$key } finally { if ($$null -ne $$key) { $$key.Dispose() } } } finally { $$baseKey.Dispose() }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Get-FnKnockShortcutState([string]$$Path) {$\r$\n"
  FileWriteUTF16LE $R7 "  try { $$attributes = [IO.File]::GetAttributes($$Path) } catch [IO.FileNotFoundException] { return 'missing' } catch [IO.DirectoryNotFoundException] { return 'missing' }$\r$\n"
  FileWriteUTF16LE $R7 "  if (($$attributes -band [IO.FileAttributes]::Directory) -ne 0) { throw ('the FnKnock shortcut path is a directory: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "  if (($$attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('the FnKnock shortcut path is a reparse point: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "  return 'file'$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Remove-FnKnockShortcut([string]$$Path) {$\r$\n"
  FileWriteUTF16LE $R7 "  try { $$attributes = [IO.File]::GetAttributes($$Path) } catch [IO.FileNotFoundException] { return } catch [IO.DirectoryNotFoundException] { return }$\r$\n"
  FileWriteUTF16LE $R7 "  if (($$attributes -band [IO.FileAttributes]::Directory) -ne 0) { throw ('refusing to remove a directory at the FnKnock shortcut path: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "  [IO.File]::Delete($$Path)$\r$\n"
  FileWriteUTF16LE $R7 "  if ([IO.File]::Exists($$Path)) { throw ('unable to remove the FnKnock shortcut: ' + $$Path) }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Snapshot-FnKnockInstallerMetadata {$\r$\n"
  FileWriteUTF16LE $R7 "  New-Item -ItemType Directory -Force -Path $$registrySnapshot | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  New-Item -ItemType Directory -Force -Path $$shortcutSnapshot | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$entry in $$registryEntries) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$existsMarker = Join-Path $$registrySnapshot ($$entry.Name + '.exists'); $$missingMarker = Join-Path $$registrySnapshot ($$entry.Name + '.missing'); $$exportPath = Join-Path $$registrySnapshot ($$entry.Name + '.reg')$\r$\n"
  FileWriteUTF16LE $R7 "    if (Test-FnKnockRegistryKey $$entry.SubKey) { & $$reg export $$entry.RegKey $$exportPath /y /reg:64 | Out-Null; if ($$LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $$exportPath -PathType Leaf)) { throw ('unable to export registry key ' + $$entry.RegKey) }; [IO.File]::WriteAllText($$existsMarker, 'exists') } else { [IO.File]::WriteAllText($$missingMarker, 'missing') }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$entry in $$shortcutEntries) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$existsMarker = Join-Path $$shortcutSnapshot ($$entry.Name + '.exists'); $$missingMarker = Join-Path $$shortcutSnapshot ($$entry.Name + '.missing'); $$copyPath = Join-Path $$shortcutSnapshot ($$entry.Name + '.lnk')$\r$\n"
  FileWriteUTF16LE $R7 "    if ((Get-FnKnockShortcutState $$entry.Path) -eq 'file') { [IO.File]::Copy($$entry.Path, $$copyPath, $$false); if ((Get-FnKnockFileSha256 $$entry.Path) -ne (Get-FnKnockFileSha256 $$copyPath)) { throw ('shortcut snapshot verification failed for ' + $$entry.Path) }; [IO.File]::WriteAllText($$existsMarker, 'exists') } else { [IO.File]::WriteAllText($$missingMarker, 'missing') }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Assert-FnKnockInstallerMetadataSnapshot {$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$entry in $$registryEntries) { $$existsMarker = Join-Path $$registrySnapshot ($$entry.Name + '.exists'); $$missingMarker = Join-Path $$registrySnapshot ($$entry.Name + '.missing'); $$exportPath = Join-Path $$registrySnapshot ($$entry.Name + '.reg'); $$exists = Test-Path -LiteralPath $$existsMarker -PathType Leaf; $$missing = Test-Path -LiteralPath $$missingMarker -PathType Leaf; if ($$exists -eq $$missing -or ($$exists -and -not (Test-Path -LiteralPath $$exportPath -PathType Leaf))) { throw ('registry transaction snapshot is incomplete for ' + $$entry.RegKey) } }$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$entry in $$shortcutEntries) { $$existsMarker = Join-Path $$shortcutSnapshot ($$entry.Name + '.exists'); $$missingMarker = Join-Path $$shortcutSnapshot ($$entry.Name + '.missing'); $$copyPath = Join-Path $$shortcutSnapshot ($$entry.Name + '.lnk'); $$exists = Test-Path -LiteralPath $$existsMarker -PathType Leaf; $$missing = Test-Path -LiteralPath $$missingMarker -PathType Leaf; if ($$exists -eq $$missing -or ($$exists -and -not (Test-Path -LiteralPath $$copyPath -PathType Leaf))) { throw ('shortcut transaction snapshot is incomplete for ' + $$entry.Path) } }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"
  FileWriteUTF16LE $R7 "function Restore-FnKnockInstallerMetadata([string]$$Kind) {$\r$\n"
  FileWriteUTF16LE $R7 "  Assert-FnKnockInstallerMetadataSnapshot$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$entry in $$registryEntries) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)$\r$\n"
  FileWriteUTF16LE $R7 "    try { $$baseKey.DeleteSubKeyTree($$entry.SubKey, $$false) } finally { $$baseKey.Dispose() }$\r$\n"
  FileWriteUTF16LE $R7 "    if (Test-FnKnockRegistryKey $$entry.SubKey) { throw ('unable to remove installer registry key before rollback restore: ' + $$entry.RegKey) }$\r$\n"
  FileWriteUTF16LE $R7 "    if ((Test-Path -LiteralPath (Join-Path $$registrySnapshot ($$entry.Name + '.exists')) -PathType Leaf)) { $$exportPath = Join-Path $$registrySnapshot ($$entry.Name + '.reg'); & $$reg import $$exportPath /reg:64 | Out-Null; if ($$LASTEXITCODE -ne 0 -or -not (Test-FnKnockRegistryKey $$entry.SubKey)) { throw ('unable to restore installer registry key ' + $$entry.RegKey) } }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "  foreach ($$entry in $$shortcutEntries) {$\r$\n"
  FileWriteUTF16LE $R7 "    Remove-FnKnockShortcut $$entry.Path$\r$\n"
  FileWriteUTF16LE $R7 "    if ((Test-Path -LiteralPath (Join-Path $$shortcutSnapshot ($$entry.Name + '.exists')) -PathType Leaf)) { $$copyPath = Join-Path $$shortcutSnapshot ($$entry.Name + '.lnk'); [IO.File]::Copy($$copyPath, $$entry.Path, $$false); if ((Get-FnKnockFileSha256 $$copyPath) -ne (Get-FnKnockFileSha256 $$entry.Path)) { throw ('shortcut rollback verification failed for ' + $$entry.Path) } }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Repair-FnKnockDataTreeAfterServiceInstall {$\r$\n"
  FileWriteUTF16LE $R7 "  $$installedService = Get-Service -Name $$serviceName -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "  $$installedServiceSid = ([System.Security.Principal.NTAccount]::new('NT SERVICE', $$serviceName)).Translate([System.Security.Principal.SecurityIdentifier])$\r$\n"
  FileWriteUTF16LE $R7 "  $$installedServiceGrant = ('*' + $$installedServiceSid.Value + ':(OI)(CI)M')$\r$\n"
  FileWriteUTF16LE $R7 "  Bootstrap-FnKnockDataTreeAccess $$root $$takeown $$icacls $$installedServiceGrant$\r$\n"
  FileWriteUTF16LE $R7 "  Set-FnKnockDataTreeAcl $$root $$systemSid $$administratorsSid $$installedServiceSid$\r$\n"
  FileWriteUTF16LE $R7 "  Set-FnKnockDataTreeOwner $$root $$icacls$\r$\n"
  FileWriteUTF16LE $R7 "  $$usersSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')$\r$\n"
  FileWriteUTF16LE $R7 "  Set-FnKnockDataTreeAcl $$state $$systemSid $$administratorsSid $$installedServiceSid $$usersSid$\r$\n"
  FileWriteUTF16LE $R7 "  Set-FnKnockDataTreeOwner $$state $$icacls$\r$\n"
  FileWriteUTF16LE $R7 "  Bootstrap-FnKnockDataTreeAccess $$rollback $$takeown $$icacls $$null$\r$\n"
  FileWriteUTF16LE $R7 "  Set-FnKnockDataTreeAcl $$rollback $$systemSid $$administratorsSid $$null$\r$\n"
  FileWriteUTF16LE $R7 "  Set-FnKnockDataTreeOwner $$rollback $$icacls$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Wait-FnKnockReady {$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath $$bundleIdentityPath -PathType Leaf)) { throw 'the installed bundle identity is missing' }$\r$\n"
  FileWriteUTF16LE $R7 "  $$bundleIdentity = Get-Content -Raw -LiteralPath $$bundleIdentityPath | ConvertFrom-Json$\r$\n"
  FileWriteUTF16LE $R7 "  $$expectedVersion = [string]$$bundleIdentity.version$\r$\n"
  ; Bundles produced before control_api_version was added already implement
  ; version 1 of the local control contract. Keep that one legacy shape
  ; upgradeable, while still rejecting an explicitly invalid value.
  FileWriteUTF16LE $R7 "  $$controlApiProperty = $$bundleIdentity.PSObject.Properties['control_api_version']$\r$\n"
  FileWriteUTF16LE $R7 "  $$expectedControlApiVersion = if ($$null -eq $$controlApiProperty) { 1 } else { [int]$$controlApiProperty.Value }$\r$\n"
  FileWriteUTF16LE $R7 "  if ([string]::IsNullOrWhiteSpace($$expectedVersion) -or $$expectedControlApiVersion -le 0) { throw 'the installed bundle identity is invalid' }$\r$\n"
  FileWriteUTF16LE $R7 "  $$port = 7991$\r$\n"
  FileWriteUTF16LE $R7 "  $$runtime = Join-Path $$root 'config\runtime.json'$\r$\n"
  FileWriteUTF16LE $R7 "  if (Test-Path -LiteralPath $$runtime) {$\r$\n"
  FileWriteUTF16LE $R7 "    try { $$configured = Get-Content -Raw -LiteralPath $$runtime | ConvertFrom-Json; if ($$configured.admin_port) { $$port = [int]$$configured.admin_port } } catch {}$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "  $$deadline = [DateTime]::UtcNow.AddSeconds(60)$\r$\n"
  FileWriteUTF16LE $R7 "  $$consecutiveReady = 0$\r$\n"
  FileWriteUTF16LE $R7 "  $$lastDetail = 'the service has not exposed its readiness endpoint'$\r$\n"
  FileWriteUTF16LE $R7 "  while ([DateTime]::UtcNow -lt $$deadline) {$\r$\n"
  FileWriteUTF16LE $R7 "    $$service = Get-Service -Name $$serviceName -ErrorAction SilentlyContinue$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$null -eq $$service) { throw 'the FnKnock service disappeared during startup' }$\r$\n"
  FileWriteUTF16LE $R7 "    $$service.Refresh()$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$service.Status -eq 'Stopped') {$\r$\n"
  FileWriteUTF16LE $R7 "      $$detail = 'the FnKnock service stopped before the runtime became ready'$\r$\n"
  FileWriteUTF16LE $R7 "      $$statusPath = Join-Path $$root 'state\status.json'$\r$\n"
  FileWriteUTF16LE $R7 "      $$serviceDetail = Get-FnKnockStartupDetail; if ($$serviceDetail) { $$detail += ': ' + $$serviceDetail }$\r$\n"
  FileWriteUTF16LE $R7 "      throw $$detail$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "    try {$\r$\n"
  FileWriteUTF16LE $R7 "      $$runtimeService = Get-CimInstance -ClassName Win32_Service -Filter 'Name=''FnKnock''' -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "      if ($$service.Status -ne 'Running' -or $$null -eq $$runtimeService -or $$runtimeService.State -ne 'Running' -or [uint32]$$runtimeService.ProcessId -eq 0) { $$lastDetail = 'service state is ' + [string]$$service.Status; $$consecutiveReady = 0; Start-Sleep -Milliseconds 750; continue }$\r$\n"
  FileWriteUTF16LE $R7 "      $$serviceProcessId = [uint32]$$runtimeService.ProcessId$\r$\n"
  FileWriteUTF16LE $R7 "      $$listener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $$port -ErrorAction Stop | Where-Object { [uint32]$$_.OwningProcess -eq $$serviceProcessId } | Select-Object -First 1$\r$\n"
  FileWriteUTF16LE $R7 "      if ($$null -eq $$listener) { $$lastDetail = 'the running service process is not listening on 127.0.0.1:' + $$port; $$consecutiveReady = 0; Start-Sleep -Milliseconds 750; continue }$\r$\n"
  FileWriteUTF16LE $R7 "      $$response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri ('http://127.0.0.1:' + $$port + '/__fn-knock/readyz')$\r$\n"
  FileWriteUTF16LE $R7 "      $$body = $$response.Content | ConvertFrom-Json$\r$\n"
  FileWriteUTF16LE $R7 "      $$components = $$body.components$\r$\n"
  FileWriteUTF16LE $R7 "      $$contractReady = $$response.StatusCode -eq 200 -and $$body.ready -eq $$true -and ([string]$$body.version).Equals($$expectedVersion, [StringComparison]::Ordinal) -and [int]$$body.control_api_version -eq $$expectedControlApiVersion -and $$components.storage -eq $$true -and $$components.gateway_bundle -eq $$true -and $$components.gateway_process -eq $$true -and $$components.gateway_dataplane -eq $$true -and $$components.auth_bridge -eq $$true$\r$\n"
  FileWriteUTF16LE $R7 "      $$service.Refresh(); $$confirmedService = Get-CimInstance -ClassName Win32_Service -Filter 'Name=''FnKnock''' -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "      $$confirmedListener = Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort $$port -ErrorAction Stop | Where-Object { [uint32]$$_.OwningProcess -eq $$serviceProcessId } | Select-Object -First 1$\r$\n"
  FileWriteUTF16LE $R7 "      if ($$contractReady -and $$service.Status -eq 'Running' -and $$null -ne $$confirmedService -and $$confirmedService.State -eq 'Running' -and [uint32]$$confirmedService.ProcessId -eq $$serviceProcessId -and $$null -ne $$confirmedListener) { $$consecutiveReady += 1; if ($$consecutiveReady -ge 2) { return } } else { $$lastDetail = 'readyz contract mismatch: ' + ($$body | ConvertTo-Json -Compress -Depth 5); $$consecutiveReady = 0 }$\r$\n"
  FileWriteUTF16LE $R7 "    } catch { $$lastDetail = $$_.Exception.Message; $$consecutiveReady = 0 }$\r$\n"
  FileWriteUTF16LE $R7 "    Start-Sleep -Milliseconds 750$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "  $$serviceDetail = Get-FnKnockStartupDetail; if ($$serviceDetail) { $$lastDetail += '; service status: ' + $$serviceDetail }$\r$\n"
  FileWriteUTF16LE $R7 "  throw ('the complete FnKnock runtime did not become ready within 60 seconds: ' + $$lastDetail)$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Install-And-StartFnKnock {$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath $$serviceExe -PathType Leaf)) { throw 'fn-knock-service.exe is missing' }$\r$\n"
  FileWriteUTF16LE $R7 "  & $$serviceExe install$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$LASTEXITCODE -ne 0) { throw ('service registration failed with exit code ' + $$LASTEXITCODE) }$\r$\n"
  FileWriteUTF16LE $R7 "  Repair-FnKnockDataTreeAfterServiceInstall$\r$\n"
  FileWriteUTF16LE $R7 "  $$service = Get-Service -Name $$serviceName -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$service.Status -ne 'Running' -and $$service.Status -ne 'StartPending') {$\r$\n"
  FileWriteUTF16LE $R7 "    [IO.File]::WriteAllText($$startupBoundary, [DateTime]::UtcNow.ToString('o'))$\r$\n"
  FileWriteUTF16LE $R7 "    & $$serviceExe start$\r$\n"
  FileWriteUTF16LE $R7 "    $$startCode = $$LASTEXITCODE$\r$\n"
  FileWriteUTF16LE $R7 "    $$service = Get-Service -Name $$serviceName -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$startCode -ne 0 -and $$service.Status -ne 'Running') { throw ('service start failed with exit code ' + $$startCode + ': ' + (Get-FnKnockStartupDetail)) }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "  Wait-FnKnockReady$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Remove-PartialFnKnockInstall {$\r$\n"
  FileWriteUTF16LE $R7 "  Stop-FnKnock$\r$\n"
  FileWriteUTF16LE $R7 "  Assert-NoReparseTree $$root; Assert-NoReparseTree $$pending; Assert-NoReparseTree $$install$\r$\n"
  FileWriteUTF16LE $R7 "  if (Test-Path -LiteralPath $$serviceExe -PathType Leaf) { try { & $$serviceExe uninstall | Out-Null } catch {} }$\r$\n"
  FileWriteUTF16LE $R7 "  $$service = Get-Service -Name $$serviceName -ErrorAction SilentlyContinue$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$null -ne $$service) { & $$sc delete $$serviceName | Out-Null; if ($$LASTEXITCODE -ne 0 -and $$LASTEXITCODE -ne 1072) { throw ('SCM service deletion failed with exit code ' + $$LASTEXITCODE) } }$\r$\n"
  FileWriteUTF16LE $R7 "  Get-NetFirewallRule -DisplayName 'FnKnock Gateway' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "  if ((Test-Path -LiteralPath $$snapshotReady -PathType Leaf) -and (Test-Path -LiteralPath $$install -PathType Container)) { Get-ChildItem -LiteralPath $$install -Force -ErrorAction Stop | Remove-Item -Recurse -Force }$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Restore-FnKnockUpgrade {$\r$\n"
  FileWriteUTF16LE $R7 "  Stop-FnKnock$\r$\n"
  FileWriteUTF16LE $R7 "  Assert-NoReparseTree $$root; Assert-NoReparseTree $$pending; Assert-NoReparseTree $$install$\r$\n"
  FileWriteUTF16LE $R7 "  $$bundle = Join-Path $$pending 'bundle'$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath $$snapshotReady -PathType Leaf)) {$\r$\n"
  FileWriteUTF16LE $R7 "    Install-And-StartFnKnock$\r$\n"
  FileWriteUTF16LE $R7 "    return$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath (Join-Path $$bundle 'fn-knock-service.exe') -PathType Leaf)) { throw 'the rollback bundle is incomplete' }$\r$\n"
  FileWriteUTF16LE $R7 "  $$bundleManifestPath = Join-Path $$pending 'bundle-manifest.json'$\r$\n"
  FileWriteUTF16LE $R7 "  if (Test-Path -LiteralPath $$bundleManifestPath) { Assert-FnKnockManifestTree $$bundle (Get-Content -Raw -Encoding UTF8 -LiteralPath $$bundleManifestPath | ConvertFrom-Json) }$\r$\n"
  FileWriteUTF16LE $R7 "  elseif (Test-Path -LiteralPath (Join-Path $$pending 'snapshot.format')) { throw 'the bundle snapshot manifest is missing' }$\r$\n"
  FileWriteUTF16LE $R7 "  New-Item -ItemType Directory -Force -Path $$install | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "  Get-ChildItem -LiteralPath $$install -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force$\r$\n"
  FileWriteUTF16LE $R7 "  Get-ChildItem -LiteralPath $$bundle -Force | Copy-Item -Destination $$install -Recurse -Force$\r$\n"
  FileWriteUTF16LE $R7 "  Assert-TreeCopy $$bundle $$install$\r$\n"
  FileWriteUTF16LE $R7 "  Restore-FnKnockPersistentData 'upgrade'$\r$\n"
  ; Restore the old externally visible identity before attempting to start the
  ; old runtime. If startup still fails, Add/Remove Programs and shortcuts no
  ; longer advertise the failed new version while the snapshot is preserved.
  FileWriteUTF16LE $R7 "  Restore-FnKnockInstallerMetadata 'upgrade'$\r$\n"
  FileWriteUTF16LE $R7 "  Install-And-StartFnKnock$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  FileWriteUTF16LE $R7 "function Rollback-FnKnockTransaction {$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath $$marker -PathType Leaf)) { return }$\r$\n"
  FileWriteUTF16LE $R7 "  Assert-NoReparseTree $$pending$\r$\n"
  FileWriteUTF16LE $R7 "  Write-FnKnockInstallerDiagnostic 'rollback' (Get-FnKnockStartupDetail)$\r$\n"
  FileWriteUTF16LE $R7 "  $$kind = (Get-Content -Raw -LiteralPath $$marker).Trim()$\r$\n"
  ; Before snapshot.ready is committed, extraction and installer metadata
  ; mutation have not started. A crash in this window may leave only a partial
  ; metadata snapshot, so preserve the live registry/shortcuts and discard the
  ; unarmed transaction after making an existing upgrade runtime ready again.
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath $$snapshotReady -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $$pending 'mutation.started'))) { throw 'installation mutation was armed but snapshot.ready is missing; recovery state was preserved' }$\r$\n"
  FileWriteUTF16LE $R7 "  if (-not (Test-Path -LiteralPath $$snapshotReady -PathType Leaf)) { if ($$kind -eq 'upgrade') { Install-And-StartFnKnock } elseif ($$kind -ne 'first' -and $$kind -ne 'repair-first') { throw ('unknown installer transaction kind ' + $$kind) }; Remove-Item -LiteralPath $$marker -Force; Remove-Item -LiteralPath $$pending -Recurse -Force -ErrorAction SilentlyContinue; return }$\r$\n"
  FileWriteUTF16LE $R7 "  Assert-FnKnockInstallerMetadataSnapshot$\r$\n"
  FileWriteUTF16LE $R7 "  $$null = Read-FnKnockPersistentSnapshot$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$kind -eq 'upgrade') { Restore-FnKnockUpgrade } elseif ($$kind -eq 'first' -or $$kind -eq 'repair-first') { if (Test-Path -LiteralPath $$snapshotReady -PathType Leaf) { Remove-PartialFnKnockInstall } } else { throw ('unknown installer transaction kind ' + $$kind) }$\r$\n"
  FileWriteUTF16LE $R7 "  if ($$kind -ne 'upgrade') { Restore-FnKnockPersistentData $$kind; Restore-FnKnockInstallerMetadata $$kind }$\r$\n"
  FileWriteUTF16LE $R7 "  Remove-Item -LiteralPath $$marker -Force$\r$\n"
  FileWriteUTF16LE $R7 "  Remove-Item -LiteralPath $$pending -Recurse -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"
  FileWriteUTF16LE $R7 "$\r$\n"

  ; icacls retains the Program Files application-package ACEs on supported
  ; Windows 10 builds even after /inheritance:r. The helper was loaded from a
  ; directory where those identities cannot write its contents; now replace
  ; every DACL with the same exact ACL constructors used for protected runtime
  ; data and fail closed unless owner/DACL verification agrees.
  FileWriteUTF16LE $R7 "  Set-FnKnockDataTreeAcl $$PSScriptRoot $$systemSid $$administratorsSid $$null$\r$\n"
  FileWriteUTF16LE $R7 "  Assert-FnKnockInstallerTreeAcl $$PSScriptRoot$\r$\n"
  FileWriteUTF16LE $R7 "  switch ($$Action) {$\r$\n"
  FileWriteUTF16LE $R7 "    'begin' {$\r$\n"
  ; Do not inspect a stale transaction until ProgramData and its existing tree
  ; have an installer-owned ACL. Preserve the live service SID during upgrades.
  ; Directory.Exists returns false for some access-denied trees. Enumerate the
  ; trusted ProgramData parent so an inaccessible existing root is recovered
  ; instead of being mistaken for a missing directory.
  FileWriteUTF16LE $R7 "    $$rootEntry = [IO.DirectoryInfo]::new($$programData).EnumerateFileSystemInfos('FnKnock', [IO.SearchOption]::TopDirectoryOnly) | Select-Object -First 1$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$null -eq $$rootEntry) { [void][IO.Directory]::CreateDirectory($$root) } else {$\r$\n"
  FileWriteUTF16LE $R7 "      if (($$rootEntry.Attributes -band [IO.FileAttributes]::Directory) -eq 0) { throw 'ProgramData\FnKnock exists but is not a directory' }$\r$\n"
  FileWriteUTF16LE $R7 "      if (($$rootEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'refusing a reparse point at ProgramData\FnKnock' }$\r$\n"
  FileWriteUTF16LE $R7 "    }$\r$\n"
  FileWriteUTF16LE $R7 "    $$serviceSid = $$null$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$null -ne (Get-Service -Name $$serviceName -ErrorAction SilentlyContinue)) { $$serviceSid = ([System.Security.Principal.NTAccount]::new('NT SERVICE', $$serviceName)).Translate([System.Security.Principal.SecurityIdentifier]) }$\r$\n"
  FileWriteUTF16LE $R7 "    $$serviceGrant = $$null$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$null -ne $$serviceSid) { $$serviceGrant = ('*' + $$serviceSid.Value + ':(OI)(CI)M') }$\r$\n"
  FileWriteUTF16LE $R7 "    Bootstrap-FnKnockDataTreeAccess $$root $$takeown $$icacls $$serviceGrant$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeAcl $$root $$systemSid $$administratorsSid $$serviceSid$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeOwner $$root $$icacls$\r$\n"
  FileWriteUTF16LE $R7 "    foreach ($$directory in @('logs','state','rollback')) { New-Item -ItemType Directory -Force -Path (Join-Path $$root $$directory) | Out-Null }$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeAcl $$root $$systemSid $$administratorsSid $$serviceSid$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeOwner $$root $$icacls$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeAcl $$rollback $$systemSid $$administratorsSid $$null$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeOwner $$rollback $$icacls$\r$\n"
  FileWriteUTF16LE $R7 "    Rollback-FnKnockTransaction$\r$\n"
  FileWriteUTF16LE $R7 "    Remove-Item -LiteralPath $$pending -Recurse -Force -ErrorAction SilentlyContinue$\r$\n"
  FileWriteUTF16LE $R7 "    if (Test-Path -LiteralPath $$pending) { throw 'a stale installer transaction could not be removed' }$\r$\n"
  FileWriteUTF16LE $R7 "    New-Item -ItemType Directory -Force -Path (Join-Path $$pending 'bundle') | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "    New-Item -ItemType Directory -Force -Path (Join-Path $$pending 'data') | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeAcl $$pending $$systemSid $$administratorsSid $$null$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeOwner $$pending $$icacls$\r$\n"
  ; Upgrade is accepted only for a complete old runtime. A matching dangling
  ; SCM entry with no files is an explicit repair-first case; every partial or
  ; foreign state is preserved and rejected.
  FileWriteUTF16LE $R7 "    $$requiredBundlePaths = @($$serviceExe, $$gatewayExe, $$bundleIdentityPath); $$presentRequiredBundleFiles = 0$\r$\n"
  FileWriteUTF16LE $R7 "    foreach ($$requiredPath in $$requiredBundlePaths) { $$requiredExists = $$true; try { $$requiredAttributes = [IO.File]::GetAttributes($$requiredPath) } catch [IO.FileNotFoundException] { $$requiredExists = $$false } catch [IO.DirectoryNotFoundException] { $$requiredExists = $$false }; if ($$requiredExists) { if (($$requiredAttributes -band [IO.FileAttributes]::Directory) -ne 0 -or ($$requiredAttributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('a required bundle path is not an ordinary file: ' + $$requiredPath) }; $$presentRequiredBundleFiles += 1 } }$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$presentRequiredBundleFiles -gt 0 -and $$presentRequiredBundleFiles -lt $$requiredBundlePaths.Count) { throw 'the existing FnKnock bundle is partial; all existing content was preserved' }$\r$\n"
  FileWriteUTF16LE $R7 "    $$currentService = Get-Service -Name $$serviceName -ErrorAction SilentlyContinue; $$currentServiceRecord = Get-CimInstance -ClassName Win32_Service -Filter 'Name=''FnKnock''' -ErrorAction Stop$\r$\n"
  FileWriteUTF16LE $R7 "    if (($$null -eq $$currentService) -ne ($$null -eq $$currentServiceRecord)) { throw 'SCM and Win32_Service returned inconsistent FnKnock service state during classification' }$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$null -ne $$currentServiceRecord) { $$currentRegisteredCommand = ([string]$$currentServiceRecord.PathName).Trim(); if (-not $$currentRegisteredCommand.Equals($$expectedServiceCommand, [StringComparison]::OrdinalIgnoreCase) -and -not $$currentRegisteredCommand.Equals($$legacyServiceCommand, [StringComparison]::OrdinalIgnoreCase)) { throw ('the FnKnock service changed to an unexpected command during transaction recovery: ' + $$currentRegisteredCommand) } }$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$presentRequiredBundleFiles -eq $$requiredBundlePaths.Count) {$\r$\n"
  FileWriteUTF16LE $R7 "      Assert-NoReparseTree $$install$\r$\n"
  FileWriteUTF16LE $R7 "      try {$\r$\n"
  FileWriteUTF16LE $R7 "        $$existingBundleIdentity = Get-Content -Raw -LiteralPath $$bundleIdentityPath | ConvertFrom-Json$\r$\n"
  FileWriteUTF16LE $R7 "        $$existingBundleVersion = [string]$$existingBundleIdentity.version$\r$\n"
  FileWriteUTF16LE $R7 "        $$existingControlApiProperty = $$existingBundleIdentity.PSObject.Properties['control_api_version']$\r$\n"
  FileWriteUTF16LE $R7 "        $$existingControlApiVersion = if ($$null -eq $$existingControlApiProperty) { 1 } else { [int]$$existingControlApiProperty.Value }$\r$\n"
  FileWriteUTF16LE $R7 "        $$existingTarget = [string]$$existingBundleIdentity.target$\r$\n"
  FileWriteUTF16LE $R7 "      } catch { throw ('the existing FnKnock bundle identity is malformed and was preserved: ' + $$_.Exception.Message) }$\r$\n"
  FileWriteUTF16LE $R7 "      if ([string]::IsNullOrWhiteSpace($$existingBundleVersion) -or $$existingControlApiVersion -le 0 -or -not $$existingTarget.Equals('windows-x86_64', [StringComparison]::Ordinal)) { throw 'the existing FnKnock bundle identity is invalid and was preserved' }$\r$\n"
  FileWriteUTF16LE $R7 "      $$kind = 'upgrade'$\r$\n"
  FileWriteUTF16LE $R7 "    } elseif ($$null -ne $$currentService) { $$kind = 'repair-first' } else { $$kind = 'first' }$\r$\n"
  FileWriteUTF16LE $R7 "    if (($$kind -eq 'first' -or $$kind -eq 'repair-first') -and $$null -ne $$installEntry) { $$unexpectedInstallEntry = Get-ChildItem -LiteralPath $$install -Force -ErrorAction Stop | Select-Object -First 1; if ($$null -ne $$unexpectedInstallEntry) { throw ('refusing ' + $$kind + ' installation into a non-empty directory; existing content was preserved: ' + $$unexpectedInstallEntry.FullName) } }$\r$\n"
  FileWriteUTF16LE $R7 "    Snapshot-FnKnockInstallerMetadata$\r$\n"
  FileWriteUTF16LE $R7 "    [IO.File]::WriteAllText((Join-Path $$pending 'snapshot.format'), '2')$\r$\n"
  FileWriteUTF16LE $R7 "    [IO.File]::WriteAllText($$marker, $$kind)$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeAcl $$pending $$systemSid $$administratorsSid $$null$\r$\n"
  FileWriteUTF16LE $R7 "    Set-FnKnockDataTreeOwner $$pending $$icacls$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "    'stop' { Stop-FnKnock }$\r$\n"
  FileWriteUTF16LE $R7 "    'snapshot' {$\r$\n"
  FileWriteUTF16LE $R7 "    if (-not (Test-Path -LiteralPath $$marker -PathType Leaf)) { throw 'the installer transaction marker is missing' }$\r$\n"
  FileWriteUTF16LE $R7 "    Assert-NoReparseTree $$root; Assert-NoReparseTree $$pending; Assert-NoReparseTree $$install$\r$\n"
  FileWriteUTF16LE $R7 "    $$kind = (Get-Content -Raw -LiteralPath $$marker).Trim()$\r$\n"
  FileWriteUTF16LE $R7 "    Stop-FnKnock$\r$\n"
  FileWriteUTF16LE $R7 "    Snapshot-FnKnockPersistentData$\r$\n"
  FileWriteUTF16LE $R7 "    if ($$kind -eq 'upgrade') {$\r$\n"
  FileWriteUTF16LE $R7 "      $$bundle = Join-Path $$pending 'bundle'$\r$\n"
  FileWriteUTF16LE $R7 "      Get-ChildItem -LiteralPath $$install -Force | Copy-Item -Destination $$bundle -Recurse -Force$\r$\n"
  FileWriteUTF16LE $R7 "      Assert-TreeCopy $$install $$bundle$\r$\n"
  FileWriteUTF16LE $R7 "      $$bundleManifest = Get-FnKnockTreeManifest $$install$\r$\n"
  FileWriteUTF16LE $R7 "      Assert-FnKnockManifestTree $$bundle $$bundleManifest$\r$\n"
  FileWriteUTF16LE $R7 "      [IO.File]::WriteAllText((Join-Path $$pending 'bundle-manifest.json'), ($$bundleManifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($$false))$\r$\n"
  FileWriteUTF16LE $R7 "      foreach ($$required in @('fn-knock-service.exe','fn-knock-gateway.exe','bundle.json')) { if (-not (Test-Path -LiteralPath (Join-Path $$bundle $$required) -PathType Leaf)) { throw ('rollback snapshot is missing ' + $$required) } }$\r$\n"
  FileWriteUTF16LE $R7 "      [IO.File]::WriteAllText($$snapshotReady, 'ready')$\r$\n"
  FileWriteUTF16LE $R7 "      [IO.File]::WriteAllText((Join-Path $$pending 'mutation.started'), 'armed')$\r$\n"
  FileWriteUTF16LE $R7 "      Get-ChildItem -LiteralPath $$install -Force -ErrorAction Stop | Remove-Item -Recurse -Force$\r$\n"
  FileWriteUTF16LE $R7 "      & $$icacls $$install /reset /Q | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "      if ($$LASTEXITCODE -ne 0) { throw ('unable to reset the install directory ACL; icacls exited with code ' + $$LASTEXITCODE) }$\r$\n"
  FileWriteUTF16LE $R7 "    } elseif ($$kind -eq 'first' -or $$kind -eq 'repair-first') {$\r$\n"
  FileWriteUTF16LE $R7 "      if ($$null -ne $$installEntry) {$\r$\n"
  FileWriteUTF16LE $R7 "        $$unexpectedInstallEntry = Get-ChildItem -LiteralPath $$install -Force -ErrorAction Stop | Select-Object -First 1$\r$\n"
  FileWriteUTF16LE $R7 "        if ($$null -ne $$unexpectedInstallEntry) { Remove-Item -LiteralPath $$marker -Force -ErrorAction Stop; throw ('the ' + $$kind + ' directory became non-empty before extraction; existing content was preserved: ' + $$unexpectedInstallEntry.FullName) }$\r$\n"
  FileWriteUTF16LE $R7 "        & $$icacls $$install /reset /Q | Out-Null$\r$\n"
  FileWriteUTF16LE $R7 "        if ($$LASTEXITCODE -ne 0) { throw ('unable to reset the empty install directory ACL; icacls exited with code ' + $$LASTEXITCODE) }$\r$\n"
  FileWriteUTF16LE $R7 "      }$\r$\n"
  FileWriteUTF16LE $R7 "      [IO.File]::WriteAllText($$snapshotReady, 'ready')$\r$\n"
  FileWriteUTF16LE $R7 "      [IO.File]::WriteAllText((Join-Path $$pending 'mutation.started'), 'armed')$\r$\n"
  FileWriteUTF16LE $R7 "    } else { throw ('unknown installer transaction kind ' + $$kind) }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "    'rollback' { Rollback-FnKnockTransaction }$\r$\n"
  FileWriteUTF16LE $R7 "    'protect-rollback' { Repair-FnKnockDataTreeAfterServiceInstall }$\r$\n"
  FileWriteUTF16LE $R7 "    'prepare-start' { [IO.File]::WriteAllText($$startupBoundary, [DateTime]::UtcNow.ToString('o')) }$\r$\n"
  FileWriteUTF16LE $R7 "    'wait-ready' { Wait-FnKnockReady }$\r$\n"
  FileWriteUTF16LE $R7 "  }$\r$\n"
  FileWriteUTF16LE $R7 "} catch {$\r$\n"
  ; PowerShell's default non-interactive error record is much longer than an
  ; NSIS string and used to hide the actionable exception behind formatting.
  FileWriteUTF16LE $R7 "  $$failureDetail = $$_.Exception.Message$\r$\n"
  FileWriteUTF16LE $R7 "  if (Get-Command Write-FnKnockInstallerDiagnostic -ErrorAction SilentlyContinue) { Write-FnKnockInstallerDiagnostic 'failed' $$failureDetail }$\r$\n"
  FileWriteUTF16LE $R7 "  [Console]::Error.WriteLine(('FnKnock installer ' + $$Action + ' failed: ' + $$failureDetail))$\r$\n"
  FileWriteUTF16LE $R7 "  exit 1$\r$\n"
  FileWriteUTF16LE $R7 "}$\r$\n"

  ${If} ${Errors}
    FileClose $R7
    StrCpy $0 1
    StrCpy $1 "unable to write the installer transaction helper"
    Return
  ${EndIf}
  FileClose $R7
  ; File creation gives the elevated administrator ownership. Reapply the exact
  ; allowlist and SYSTEM owner before PowerShell reads the helper.
  Call FnKnockProtectTransactionDirectory
  ${If} $0 == 0
    StrCpy $FnKnockTransactionReady 1
  ${EndIf}
FunctionEnd

!macro FNKNOCK_RUN_TRANSACTION ACTION
  Call FnKnockWriteTransactionScript
  ${If} $0 == 0
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$FnKnockTransactionScript" -Action ${ACTION} -InstallDir "$INSTDIR" -ProgramFilesDir "$PROGRAMFILES64"'
    Pop $0
    Pop $1
  ${EndIf}
!macroend

; Stop is cooperative: Rust asks Go to drain for up to 15 seconds. Never touch
; the bundle or SQLite until SCM confirms the whole runtime group is stopped.
!macro FNKNOCK_STOP_AND_WAIT
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = $\'Stop$\'; $$service = Get-Service -Name $\'${FNKNOCK_SERVICE}$\' -ErrorAction SilentlyContinue; if ($$null -ne $$service -and $$service.Status -ne $\'Stopped$\') { Stop-Service -Name $\'${FNKNOCK_SERVICE}$\' -ErrorAction Stop; $$service.WaitForStatus($\'Stopped$\', [TimeSpan]::FromSeconds(20)) }; if ($$null -ne (Get-Service -Name $\'${FNKNOCK_SERVICE}$\' -ErrorAction SilentlyContinue) -and (Get-Service -Name $\'${FNKNOCK_SERVICE}$\').Status -ne $\'Stopped$\') { throw $\'FnKnock did not stop within 20 seconds$\' }"'
  Pop $0
  Pop $1
!macroend

; MUI owns .onUserAbort. This callback is invoked from MUI before the installer
; exits, so a normal cancel is covered by the same idempotent transaction path.
!define MUI_CUSTOMFUNCTION_ABORT FnKnockInstallerUserAbort

Function FnKnockInstallerUserAbort
  ${If} $FnKnockTransactionReady == 1
    SetOutPath "$PROGRAMFILES64"
    !insertmacro FNKNOCK_RUN_TRANSACTION rollback
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "FnKnock could not roll back the cancelled setup. The recovery snapshot was preserved under ProgramData\FnKnock\rollback\pending: $1" /SD IDOK
      Abort
    ${EndIf}
  ${EndIf}
FunctionEnd

; File extraction and registry failures happen between PREINSTALL and
; POSTINSTALL. These callbacks make those failures transactional too.
Function .onInstFailed
  ${If} $FnKnockTransactionReady == 1
    SetOutPath "$PROGRAMFILES64"
    !insertmacro FNKNOCK_RUN_TRANSACTION rollback
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "FnKnock automatic rollback failed. The recovery snapshot was preserved under ProgramData\FnKnock\rollback\pending: $1" /SD IDOK
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  ; Idempotent final safety net. A successful install has already removed the
  ; transaction marker, so this is a no-op on the normal path.
  ${If} $FnKnockTransactionReady == 1
    SetOutPath "$PROGRAMFILES64"
    !insertmacro FNKNOCK_RUN_TRANSACTION rollback
  ${EndIf}
  Call FnKnockCleanupTransactionDirectory
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  ; Reject /D= and registry-derived paths before launching any elevated helper.
  ${If} $INSTDIR != "$PROGRAMFILES64\Knock 敲门"
  ${AndIf} $INSTDIR != "$PROGRAMFILES64\Knock 敲门\current"
    Abort "Knock 敲门只能安装到 64 位 Program Files\Knock 敲门。未更改任何文件。"
  ${EndIf}
  ; The installer enters $INSTDIR before this hook. Use a trusted working directory for
  ; every external process, then restore the extraction directory at the end.
  SetOutPath "$PROGRAMFILES64"

  ; Check the GUI before stopping SCM so cancellation cannot take the gateway down.
  !insertmacro CheckIfAppIsRunning "fn-knock.exe" "FnKnock"

  !insertmacro FNKNOCK_RUN_TRANSACTION begin
  ${If} $0 != 0
    Abort "Unable to initialize the FnKnock installer transaction. Any existing recovery snapshot was preserved under ProgramData\FnKnock\rollback\pending: $1"
  ${EndIf}

  DetailPrint "Stopping the FnKnock runtime group"
  !insertmacro FNKNOCK_RUN_TRANSACTION stop
  ${If} $0 != 0
    StrCpy $R9 "FnKnock did not stop safely: $1"
    !insertmacro FNKNOCK_RUN_TRANSACTION rollback
    ${If} $0 != 0
      Abort "$R9 Automatic recovery also failed; ProgramData\FnKnock\rollback\pending was preserved: $1"
    ${EndIf}
    Abort "$R9 The previous installation was restored."
  ${EndIf}

  ; The helper copies and verifies the complete old bundle plus config/SQLite,
  ; writes snapshot.ready, and only then removes files from $INSTDIR.
  DetailPrint "Creating and verifying the FnKnock rollback snapshot"
  !insertmacro FNKNOCK_RUN_TRANSACTION snapshot
  ${If} $0 != 0
    StrCpy $R9 "FnKnock rollback snapshot or old-bundle cleanup failed: $1"
    !insertmacro FNKNOCK_RUN_TRANSACTION rollback
    ${If} $0 != 0
      Abort "$R9 Automatic recovery also failed; ProgramData\FnKnock\rollback\pending was preserved: $1"
    ${EndIf}
    Abort "$R9 The previous installation was restored."
  ${EndIf}

  SetOutPath "$INSTDIR"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Per-machine SetShellVarContext maps $APPDATA to %ProgramData%.
  CreateDirectory "$APPDATA\FnKnock\config"
  CreateDirectory "$APPDATA\FnKnock\data"
  CreateDirectory "$APPDATA\FnKnock\certificates"
  CreateDirectory "$APPDATA\FnKnock\waf"
  CreateDirectory "$APPDATA\FnKnock\logs"
  CreateDirectory "$APPDATA\FnKnock\state"
  CreateDirectory "$APPDATA\FnKnock\rollback"

  ; The signed service binary is the single owner of SCM recovery, ACL and
  ; program-level Domain/Private firewall configuration.
  nsExec::ExecToStack '"$INSTDIR\fn-knock-service.exe" install'
  Pop $0
  Pop $1
  ${If} $0 != 0
    StrCpy $R9 "service registration failed: $1"
    Goto fnknock_rollback
  ${EndIf}

  ; Both legacy and current service installers may recursively touch
  ; ProgramData ACLs. Reassert the rollback allowlist before any service start.
  !insertmacro FNKNOCK_RUN_TRANSACTION protect-rollback
  ${If} $0 != 0
    StrCpy $R9 "rollback snapshot ACL protection failed: $1"
    Goto fnknock_rollback
  ${EndIf}

  !insertmacro FNKNOCK_RUN_TRANSACTION prepare-start
  ${If} $0 != 0
    StrCpy $R9 "unable to record the service startup boundary: $1"
    Goto fnknock_rollback
  ${EndIf}
  DetailPrint "Starting the FnKnock service"
  nsExec::ExecToStack '"$INSTDIR\fn-knock-service.exe" start'
  Pop $0
  Pop $1
  ${If} $0 != 0
    StrCpy $R9 "service start failed: $1"
    !insertmacro FNKNOCK_RUN_TRANSACTION wait-ready
    ${If} $0 != 0
      StrCpy $R9 "$R9; $1"
    ${EndIf}
    Goto fnknock_rollback
  ${EndIf}

  !insertmacro FNKNOCK_RUN_TRANSACTION wait-ready
  ${If} $0 != 0
    StrCpy $R9 "runtime startup failed: $1"
    Goto fnknock_rollback
  ${EndIf}

  ; Removing the marker commits the transaction. Delete it before best-effort
  ; snapshot cleanup so an antivirus lock cannot roll back an already-ready app.
  ClearErrors
  Delete "$APPDATA\FnKnock\rollback\pending\transaction.pending"
  ${If} ${Errors}
    StrCpy $R9 "the installer transaction could not be committed"
    Goto fnknock_rollback
  ${EndIf}
  RMDir /r "$APPDATA\FnKnock\rollback\pending"
  ClearErrors
  Goto fnknock_postinstall_done

  fnknock_rollback:
  DetailPrint "FnKnock setup failed ($R9); restoring the previous state"
  StrCpy $R8 "first-install"
  ${If} ${FileExists} "$APPDATA\FnKnock\rollback\pending\retained-data"
    StrCpy $R8 "retained-data"
  ${EndIf}
  ${If} ${FileExists} "$APPDATA\FnKnock\rollback\pending\bundle\fn-knock-service.exe"
    StrCpy $R8 "upgrade"
  ${EndIf}
  !insertmacro FNKNOCK_RUN_TRANSACTION rollback
  ${If} $0 != 0
    Abort "FnKnock setup failed ($R9), and automatic rollback failed. The snapshot is preserved at ProgramData\FnKnock\rollback\pending: $1"
  ${EndIf}
  ${If} $R8 == "upgrade"
    Abort "FnKnock setup failed ($R9). The previous bundle and data were restored and verified ready."
  ${ElseIf} $R8 == "retained-data"
    Abort "FnKnock reinstall with retained data failed ($R9). Existing persistent data was restored; diagnostics are under ProgramData\FnKnock\logs."
  ${Else}
    Abort "FnKnock first install failed ($R9). Previous persistent state was restored; diagnostics are under ProgramData\FnKnock\logs."
  ${EndIf}

  fnknock_postinstall_done:
  ; Write normalized product branding and shortcuts.
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Knock 敲门" "DisplayName" "Knock 敲门"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\Knock 敲门" "Publisher" "KCI-LNK Corporation"
  Delete "$SMPROGRAMS\fn-knock.lnk"
  Delete "$DESKTOP\fn-knock.lnk"
  Delete "$DESKTOP\Knock 敲门.lnk"
  CreateShortCut "$SMPROGRAMS\Knock 敲门.lnk" "$INSTDIR\fn-knock.exe"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Check the GUI before SCM state is removed.
  !insertmacro CheckIfAppIsRunning "fn-knock.exe" "FnKnock"

  DetailPrint "Removing the FnKnock service (ProgramData is preserved)"
  !insertmacro FNKNOCK_STOP_AND_WAIT
  ${If} $0 != 0
    Abort "FnKnock could not be stopped safely; uninstall was cancelled: $1"
  ${EndIf}
  nsExec::ExecToStack '"$INSTDIR\fn-knock-service.exe" uninstall'
  Pop $0
  Pop $1
  ${If} $0 != 0
    nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$ErrorActionPreference = $\'Stop$\'; $$sc = $\'$SYSDIR\sc.exe$\'; if (-not (Test-Path -LiteralPath $$sc -PathType Leaf)) { throw $\'System32 sc.exe is missing$\' }; $$service = Get-Service -Name $\'${FNKNOCK_SERVICE}$\' -ErrorAction SilentlyContinue; if ($$null -ne $$service) { & $$sc delete $\'${FNKNOCK_SERVICE}$\' | Out-Null; if ($$LASTEXITCODE -ne 0 -and $$LASTEXITCODE -ne 1072) { throw $\'SCM service deletion failed$\' } }; Get-NetFirewallRule -DisplayName $\'FnKnock Gateway$\' -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      Abort "FnKnock service removal failed; program files were retained to avoid a dangling SCM entry: $1"
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Intentionally preserve %ProgramData%\FnKnock for reinstall and recovery.
!macroend
