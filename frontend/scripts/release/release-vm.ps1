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
# vmconnect's enhanced session is a Remote Desktop connection: it takes over the automatically signed-in session,
# locks it behind the password and hides the VM's local smart cards, SimplySign's among them.
if ((Get-VMHost).EnableEnhancedSessionMode) {
  throw 'Enhanced session mode is on. Turn it off for this PC first: Set-VMHost -EnableEnhancedSessionMode $false'
}
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
Write-Host "VM account: $($cred.UserName)   (-ForgetPassword asks for it again)"

$session = $null
function Invoke-InVM([scriptblock]$Block, [object[]]$Arguments = @()) {
  if (-not $script:session -or $script:session.State -ne 'Opened') {
    $script:session = New-PSSession -VMName $VMName -Credential $cred
  }
  Invoke-Command -Session $script:session -ScriptBlock $Block -ArgumentList $Arguments
}

# The token comes from the clipboard: in a hidden Read-Host, Ctrl+V types one control character instead of pasting.
# GitHub's copy button takes the whole "config.cmd --url ... --token ..." line, so the token is picked out of it, and
# the clipboard is overwritten once it is read.
function Read-RunnerToken {
  while ($true) {
    $null = Read-Host 'Copy the token (or the whole config.cmd line) on that page, then press Enter here'
    $text = [string](Get-Clipboard -Raw)
    if ($text -match '--token\s+(\S+)') { $text = $Matches[1] }
    $text = $text.Trim()
    if ($text -match '^[A-Za-z0-9_-]{20,}$') {
      try { Set-Clipboard -Value ' ' } catch { Write-Warning 'Could not clear the clipboard; the token expires within the hour.' }
      return $text
    }
    Write-Warning 'The clipboard holds no registration token (one word of letters and digits). Copy it again.'
  }
}

# GitHub refuses the runner's sign-in when the VM clock is off ("The token is not valid until ..."), and the runner
# then claims its registration was deleted. A VM started from its checkpoint can run hours off, so it gets this PC's
# time before the registration, with Hyper-V's time synchronisation switched on.
function Sync-VMClock {
  $timeSync = Get-VMIntegrationService -VMName $VMName |
    Where-Object { $_.Id -like '*2497F4DE-E9FA-4204-80E4-4B75C46419C0' }
  if ($timeSync -and -not $timeSync.Enabled) { Enable-VMIntegrationService -VMIntegrationService $timeSync }
  $skew = [TimeSpan]::FromTicks((Invoke-InVM { [DateTime]::UtcNow.Ticks }) - [DateTime]::UtcNow.Ticks)
  if ([Math]::Abs($skew.TotalSeconds) -lt 30) { return }
  $zone = Invoke-InVM { (Get-TimeZone).Id }
  $way = if ($skew.Ticks -gt 0) { 'ahead' } else { 'behind' }
  Write-Host "The VM clock is $($skew.Duration().ToString('hh\:mm\:ss')) $way (VM time zone: $zone); setting it from this PC."
  $fix = 'In the VM, set the time zone and the clock under Settings > Time & language, shut it down and take the checkpoint again.'
  try {
    Invoke-InVM {
      param($ticks)
      Set-Date -Date ([DateTime]::new($ticks, [DateTimeKind]::Utc).ToLocalTime()) -ErrorAction Stop | Out-Null
    } @([DateTime]::UtcNow.Ticks)
  }
  catch { throw "Could not set the VM clock ($($_.Exception.Message.TrimEnd('.'))). $fix" }
  $skew = [TimeSpan]::FromTicks((Invoke-InVM { [DateTime]::UtcNow.Ticks }) - [DateTime]::UtcNow.Ticks)
  if ([Math]::Abs($skew.TotalSeconds) -ge 30) {
    throw "The VM clock is still $($skew.Duration().ToString('hh\:mm\:ss')) off. $fix"
  }
}

# The reset wipes the VM, so the runner's own logs are copied to the host first. A Worker log exists only when the
# runner ran a job; without one, the end of the Runner log says why it stopped.
$name = $null
$ranJob = $false
function Save-RunnerLog {
  if (-not $script:name) { return }
  try {
    $logs = @(Invoke-InVM {
        Get-ChildItem 'C:\actions-runner\_diag' -Filter '*.log' -ErrorAction SilentlyContinue |
          ForEach-Object { [pscustomobject]@{ Name = $_.Name; Text = Get-Content $_.FullName -Raw } }
      })
  }
  catch { Write-Warning "Could not copy the runner logs: $($_.Exception.Message)"; return }
  $dir = Join-Path (Split-Path $credFile) "logs\$script:name"
  New-Item $dir -ItemType Directory -Force | Out-Null
  foreach ($log in $logs) { Set-Content (Join-Path $dir $log.Name) $log.Text -Encoding UTF8 }
  Write-Host "Runner logs: $dir"
  $script:ranJob = [bool]($logs | Where-Object { $_.Name -like 'Worker_*' })
  if (-not $script:ranJob) {
    Write-Warning 'The runner ran no job. The end of its log:'
    $last = $logs | Where-Object { $_.Name -like 'Runner_*' } | Select-Object -Last 1
    if ($last) { ($last.Text -split "`r?`n") | Select-Object -Last 30 | ForEach-Object { Write-Host "  $_" } }
  }
}

try {
  Reset-ReleaseVM
  Start-VM -Name $VMName
  Write-Host 'Waiting for the VM to start and sign in by itself ...'
  $bootDeadline = (Get-Date).AddMinutes(10)
  # While Windows boots, PowerShell Direct refuses; a wrong account refuses the same way, so the answer is shown.
  $lastError = $null
  $nextReport = (Get-Date).AddMinutes(1)
  while ($true) {
    try { if (Invoke-InVM { [bool](Get-Process explorer -ErrorAction SilentlyContinue) }) { break } }
    catch { $session = $null; $lastError = $_.Exception.Message }
    if ((Get-Date) -gt $bootDeadline) {
      $why = if ($lastError) { " Last answer from the VM: $lastError" } else { ' The account signed in, but no desktop.' }
      throw ('The VM did not reach its desktop within 10 minutes.' + $why +
        ' Wrong account or password: run again with -ForgetPassword. No desktop: check Autologon in the VM.')
    }
    if ($lastError -and (Get-Date) -gt $nextReport) {
      Write-Host "  still waiting - last answer from the VM: $lastError"
      $nextReport = (Get-Date).AddMinutes(1)
    }
    Start-Sleep -Seconds 5
  }
  Sync-VMClock

  Write-Host ''
  Write-Host 'Registration token: open this page (signed in to GitHub on this PC, never in the VM). In the box'
  Write-Host '"Configure", copy the token after --token; the whole config.cmd line works as well.'
  Write-Host "  $Repo/settings/actions/runners/new?arch=x64&os=win"
  $name = 'prism-release-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  for ($try = 1; ; $try++) {
    $token = Read-RunnerToken
    try {
      Invoke-InVM {
        param($repo, $token, $name)
        Set-Location 'C:\actions-runner'
        & .\config.cmd --unattended --url $repo --token $token --name $name --labels prism-release-win --ephemeral
        if ($LASTEXITCODE -ne 0) { throw "Runner registration failed (config.cmd exit $LASTEXITCODE)." }
      } @($Repo, $token, $name)
      break
    }
    catch {
      if ($try -ge 3) { throw }
      Write-Warning ("GitHub refused the registration: $($_.Exception.Message)")
      Write-Warning 'A token works once and for one hour. Reload the page and copy the fresh one.'
    }
    finally { $token = $null }
  }
  Invoke-InVM { Start-ScheduledTask -TaskName 'PrismRunner' }
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
  Save-RunnerLog
  if ($session) { Remove-PSSession $session -ErrorAction SilentlyContinue }
  Reset-ReleaseVM
}
if ($ranJob) { Write-Host "Next: approve the release on GitHub ($Repo/actions)." }
