<#
.SYNOPSIS
  Opens the PrismLCA release VM for one release and closes it again.

.DESCRIPTION
  Run on the Windows host in an elevated PowerShell. The script resets the VM to its checkpoint "clean", starts it,
  registers an ephemeral GitHub runner with a token you paste, and starts the runner in the VM's desktop session.
  Then it watches the run: when the release workflow waits for the SimplySign sign-in, it beeps and opens the VM
  window; when the runner has exited after its one job, it resets the VM. Ctrl+C, an error and the time limit
  (counted from the registration, so it covers the wait for the tag, the verify job and the Windows job) reset it
  as well, so a runner exists only while a release is being built.

  The token is never stored. The password of the VM account is kept for PowerShell Direct, encrypted for this
  Windows user (DPAPI), in %LOCALAPPDATA%\PrismRelease.

.EXAMPLE
  .\release-vm.ps1
.EXAMPLE
  .\release-vm.ps1 -ForgetPassword    # asks for the VM account again
#>
#Requires -RunAsAdministrator
#Requires -Modules Hyper-V
[CmdletBinding()]
param(
  [string]$VMName = 'PrismRelease',
  [string]$Checkpoint = 'clean',
  [int]$MaxMinutes = 210,
  [switch]$ForgetPassword
)
$ErrorActionPreference = 'Stop'
$Repo = 'https://github.com/prismlca/prismlca'
$Signal = 'C:\actions-runner\signal'

function Reset-ReleaseVM {
  if ((Get-VM -Name $VMName).State -ne 'Off') { Stop-VM -Name $VMName -TurnOff -Force }
  Restore-VMSnapshot -VMName $VMName -Name $Checkpoint -Confirm:$false
  Write-Host "VM $VMName is off and back at checkpoint '$Checkpoint'."
}

$null = Get-VM -Name $VMName
if (-not (Get-VMSnapshot -VMName $VMName -Name $Checkpoint -ErrorAction SilentlyContinue)) {
  throw "VM $VMName has no checkpoint '$Checkpoint'. Take it with the VM off: Checkpoint-VM -Name $VMName -SnapshotName $Checkpoint"
}

$credFile = Join-Path $env:LOCALAPPDATA 'PrismRelease\vm-account.xml'
if ($ForgetPassword -and (Test-Path $credFile)) { Remove-Item $credFile }
if (-not (Test-Path $credFile)) {
  New-Item (Split-Path $credFile) -ItemType Directory -Force | Out-Null
  Get-Credential -UserName 'build' -Message "Account inside the VM $VMName" | Export-Clixml $credFile
}
$cred = Import-Clixml $credFile

$session = $null
function Invoke-InVM([scriptblock]$Block, [object[]]$Arguments = @()) {
  if (-not $script:session -or $script:session.State -ne 'Opened') {
    $script:session = New-PSSession -VMName $VMName -Credential $cred
  }
  Invoke-Command -Session $script:session -ScriptBlock $Block -ArgumentList $Arguments
}

try {
  Reset-ReleaseVM
  Start-VM -Name $VMName
  Write-Host 'Waiting for the VM to start and sign in by itself ...'
  $bootDeadline = (Get-Date).AddMinutes(10)
  while ($true) {
    try { if (Invoke-InVM { [bool](Get-Process explorer -ErrorAction SilentlyContinue) }) { break } }
    catch { $session = $null }
    if ((Get-Date) -gt $bootDeadline) { throw 'The VM did not reach its desktop within 10 minutes. Is automatic sign-in set up?' }
    Start-Sleep -Seconds 5
  }

  Write-Host ''
  Write-Host 'Registration token: open this page and copy the value after --token in the "Configure" box:'
  Write-Host "  $Repo/settings/actions/runners/new?arch=x64&os=win"
  $secure = Read-Host 'Paste the token' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  $name = 'prism-release-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  Invoke-InVM {
    param($repo, $token, $name)
    Set-Location 'C:\actions-runner'
    & .\config.cmd --unattended --url $repo --token $token --name $name --labels prism-release-win --ephemeral
    if ($LASTEXITCODE -ne 0) { throw "Runner registration failed (config.cmd exit $LASTEXITCODE)." }
    Start-ScheduledTask -TaskName 'PrismRunner'
  } @($Repo, $token, $name)
  $token = $null
  $deadline = (Get-Date).AddMinutes($MaxMinutes)

  # Start-ScheduledTask only asks for the start; the runner is up once its listener process runs.
  $listenerDeadline = (Get-Date).AddSeconds(90)
  while (-not (Invoke-InVM { [bool](Get-Process Runner.Listener -ErrorAction SilentlyContinue) })) {
    if ((Get-Date) -gt $listenerDeadline) { throw 'The runner did not start in the VM. Look at its window there.' }
    Start-Sleep -Seconds 3
  }

  Write-Host ''
  Write-Host "Runner $name is running in the VM; GitHub lists it as Idle within a minute." -ForegroundColor Green
  Write-Host 'Start the release on the Linux PC now. This window says when to sign in to SimplySign.'
  Write-Host 'Ctrl+C stops here and resets the VM.'
  $phase = 'waiting'
  while ($true) {
    if ((Get-Date) -gt $deadline) { Write-Warning "Time limit of $MaxMinutes minutes reached - closing the VM."; break }
    $state = $null
    try {
      $state = Invoke-InVM {
        param($dir)
        $finished = Join-Path $dir 'finished.txt'
        [pscustomobject]@{
          SignIn   = Test-Path (Join-Path $dir 'signin.txt')
          Finished = if (Test-Path $finished) { (Get-Content $finished -Raw).Trim() } else { $null }
        }
      } @($Signal)
    }
    catch { $session = $null }
    if ($state) {
      if ($state.Finished) {
        Write-Host "The runner has exited ($($state.Finished)). Whether the Windows job passed is shown on GitHub."
        break
      }
      if ($state.SignIn -and $phase -ne 'signin') {
        $phase = 'signin'
        Write-Host ''
        Write-Host '>>> Sign in to SimplySign Desktop in the VM window now (code from the phone app).' -ForegroundColor Yellow
        [console]::Beep(880, 400)
        Start-Process vmconnect.exe -ArgumentList 'localhost', $VMName
      }
      elseif (-not $state.SignIn -and $phase -eq 'signin') {
        $phase = 'signing'
        Write-Host 'Signed in - the installer is being built and signed.' -ForegroundColor Green
      }
    }
    Start-Sleep -Seconds 10
  }
}
finally {
  if ($session) { Remove-PSSession $session -ErrorAction SilentlyContinue }
  Reset-ReleaseVM
}
Write-Host "Next: approve the release on GitHub ($Repo/actions)."
