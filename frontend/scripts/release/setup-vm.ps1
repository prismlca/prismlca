<#
.SYNOPSIS
  One-time setup of the PrismLCA release VM: build tools, the GitHub runner (downloaded, not registered) and the
  task that starts it.

.DESCRIPTION
  Run once inside the VM, in an elevated Windows PowerShell, signed in as the account the runner will use. Then
  install SimplySign Desktop, set up the automatic sign-in, shut the VM down and take the checkpoint "clean":
  release-vm.ps1 on the host resets the VM to that checkpoint for every release.

  Nothing secret is kept in the VM: no GitHub token, no browser login, no password manager.
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
# Invoke-WebRequest is many times slower while it draws a progress bar.
$ProgressPreference = 'SilentlyContinue'

$RunnerDir = 'C:\actions-runner'
$Account = "$env:USERDOMAIN\$env:USERNAME"

function Step([string]$text) { Write-Host "`n== $text" -ForegroundColor Cyan }

function Install-WingetPackage([string]$id, [string[]]$extra = @()) {
  winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements `
    --disable-interactivity @extra
  # Exit codes differ for "already installed" and "restart needed"; what counts is checked below.
  if ($LASTEXITCODE -ne 0) { Write-Warning "winget ended with $LASTEXITCODE for $id - checked below." }
}

Step 'Checking winget'
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw 'winget is missing. Open the Microsoft Store, update "App Installer" under Library, then run this again.'
}

Step 'Installing Git, the Visual C++ runtime and the signing tools of the Windows SDK'
Install-WingetPackage 'Git.Git'
Install-WingetPackage 'Microsoft.VCRedist.2015+.x64'
# Only signtool.exe, not the whole SDK.
Install-WingetPackage 'Microsoft.WindowsSDK.10.0.26100' @('--override', '/features OptionId.SigningTools /quiet /norestart')

$vcKeys = 'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64'
if (-not ($vcKeys | Where-Object { (Get-ItemProperty $_ -ErrorAction SilentlyContinue).Installed -eq 1 })) {
  throw ('The Visual C++ runtime (x64) is missing. Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe ' +
    'and run this again.')
}
$git = Join-Path $env:ProgramFiles 'Git\cmd\git.exe'
$bash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
if (-not (Test-Path $git) -or -not (Test-Path $bash)) {
  throw "Git for Windows is missing ($git, $bash). Install it from https://git-scm.com and run this again."
}
$signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
  Sort-Object FullName -Descending | Select-Object -First 1
if (-not $signtool) {
  throw ('signtool.exe is missing. Install the Windows SDK with only "Windows SDK Signing Tools for Desktop Apps" ' +
    '(https://developer.microsoft.com/windows/downloads/windows-sdk/), then run this again.')
}

Step 'Putting Git Bash on the PATH (the release workflow runs its steps in bash)'
$gitBin = Split-Path $bash
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if (($machinePath -split ';') -notcontains $gitBin) {
  [Environment]::SetEnvironmentVariable('Path', "$gitBin;$machinePath", 'Machine')
}

Step 'Allowing long paths (the backend bundle nests deep)'
Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1 -Type DWord
& $git config --system core.longpaths true

Step 'No automatic Windows updates: the VM returns to its checkpoint every run, updates go into it by hand'
$au = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU'
New-Item $au -Force | Out-Null
Set-ItemProperty $au -Name NoAutoUpdate -Value 1 -Type DWord

Step 'No sleep and no screen-off'
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /change hibernate-timeout-ac 0

Step 'Defender skips the runner work folder (a build writes tens of thousands of files)'
Add-MpPreference -ExclusionPath (Join-Path $RunnerDir '_work')

Step 'Downloading the GitHub Actions runner (checked, not registered)'
$release = Invoke-RestMethod 'https://api.github.com/repos/actions/runner/releases/latest'
$asset = $release.assets | Where-Object { $_.name -like 'actions-runner-win-x64-*.zip' } | Select-Object -First 1
if (-not $asset) { throw 'The latest runner release has no Windows x64 package.' }
$want = $null
if ($asset.digest -match '^sha256:([0-9a-f]{64})$') { $want = $Matches[1] }
elseif ($release.body -match '<!-- BEGIN SHA win-x64 -->([0-9a-f]{64})<!-- END SHA win-x64 -->') { $want = $Matches[1] }
if (-not $want) { throw 'The runner release names no SHA-256 for the Windows package.' }
$zip = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
$have = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
if ($have -ne $want) { throw "Checksum mismatch for $($asset.name): got $have, expected $want." }
New-Item $RunnerDir -ItemType Directory -Force | Out-Null
Expand-Archive $zip -DestinationPath $RunnerDir -Force
Remove-Item $zip
# The runner runs without elevation, so the account needs full rights on its folder.
icacls $RunnerDir /grant "${Account}:(OI)(CI)F" /T /Q | Out-Null

Step 'Launcher and the task that starts the runner in this desktop session'
$launcher = @'
# Started by the task PrismRunner (release-vm.ps1 on the host starts it) in the signed-in desktop session:
# signtool reaches the SimplySign certificate only there. The runner is ephemeral and exits after one job.
$Host.UI.RawUI.WindowTitle = 'PrismLCA release runner'
$signal = 'C:\actions-runner\signal'
New-Item $signal -ItemType Directory -Force | Out-Null
Remove-Item "$signal\*" -Force -ErrorAction SilentlyContinue
# The release workflow leaves a note here while it waits for the SimplySign sign-in; release-vm.ps1 reads it.
$env:PRISM_SIGNAL_DIR = $signal
Set-Location 'C:\actions-runner'
& .\run.cmd
Set-Content "$signal\finished.txt" "exit $LASTEXITCODE"
'@
Set-Content (Join-Path $RunnerDir 'prism-run.ps1') $launcher -Encoding ASCII
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$RunnerDir\prism-run.ps1`""
$principal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'PrismRunner' -Action $action -Principal $principal -Settings $settings -Force |
  Out-Null

Step 'Fetching Sysinternals Autologon for the automatic sign-in'
$alZip = Join-Path $env:TEMP 'AutoLogon.zip'
Invoke-WebRequest 'https://download.sysinternals.com/files/AutoLogon.zip' -OutFile $alZip -UseBasicParsing
$alDir = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Autologon'
Expand-Archive $alZip -DestinationPath $alDir -Force
Remove-Item $alZip
$sig = Get-AuthenticodeSignature (Join-Path $alDir 'Autologon64.exe')
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
  Remove-Item $alDir -Recurse -Force
  throw 'Autologon64.exe does not carry a valid Microsoft signature and was deleted.'
}

Step 'Done'
Write-Host "signtool: $($signtool.FullName)"
Write-Host "runner:   $RunnerDir (registered by release-vm.ps1 for each release, never here)"
Write-Host 'Next: install SimplySign Desktop, then run Autologon64.exe from the Autologon folder on the desktop.'
