<#
.SYNOPSIS
  Runs the signing half of sign-windows.ps1 with a throwaway certificate, on a hosted test runner.

.DESCRIPTION
  The release signs with a key that exists on one machine, so signing itself — signtool sign, the timestamp, the
  check afterwards — cannot run anywhere else as it is. This makes a self-signed code-signing certificate, trusts it
  on the runner, and has sign-windows.ps1 sign and inspect two program files with it. What it cannot show is the
  release key's own provider; everything the script does around it, it does here.

  It adds a root certificate to the machine, so it runs on GitHub's hosted runners only (a fresh machine per job)
  and refuses everywhere else — a developer's PC and the release VM above all.

    -From <dir>   a directory with Windows program files to take two small ones from (they are copied, not changed)
#>
[CmdletBinding()]
param([Parameter(Mandatory)][string]$From)
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'sign-windows-selftest.ps1 trusts a test certificate machine-wide: it runs on a GitHub-hosted runner only.'
}

$script = Join-Path $PSScriptRoot 'sign-windows.ps1'
$work = Join-Path $env:RUNNER_TEMP 'sign-selftest'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
$null = New-Item -ItemType Directory -Path $work

$subject = 'CN=PrismLCA signing self-test, O=PrismLCA test, C=DE'
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddDays(2)
$cer = Join-Path $work 'selftest.cer'
$null = Export-Certificate -Cert $cert -FilePath $cer
$null = Import-Certificate -FilePath $cer -CertStoreLocation Cert:\LocalMachine\Root

# Two small program files, copied: one call with several files is what the release makes.
$picked = @(Get-ChildItem -LiteralPath $From -Recurse -File |
    Where-Object { $_.Extension -in '.pyd', '.dll' } | Sort-Object Length | Select-Object -First 2)
if ($picked.Count -lt 2) { throw "No two program files below $From to sign." }
$n = 0
$files = foreach ($p in $picked) {
  # Numbered: two packages may ship a file of the same name.
  $n++
  $copy = Join-Path $work "$n-$($p.Name)"
  Copy-Item -LiteralPath $p.FullName -Destination $copy
  $copy
}
$list = Join-Path $work 'files.txt'
[System.IO.File]::WriteAllLines($list, [string[]]$files, (New-Object System.Text.UTF8Encoding $false))

$env:PRISM_SIGN_SUBJECT = $cert.Subject
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Sign -List $list
if ($LASTEXITCODE -ne 0) { throw "sign-windows.ps1 -Sign failed (exit $LASTEXITCODE)." }

$out = Join-Path $work 'facts.json'
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $script -Inspect -List $list -Out $out
if ($LASTEXITCODE -ne 0) { throw "sign-windows.ps1 -Inspect failed (exit $LASTEXITCODE)." }
# Windows PowerShell hands a JSON list on as one object; reading it from a variable takes it apart.
$parsed = Get-Content -LiteralPath $out -Raw -Encoding UTF8 | ConvertFrom-Json
$facts = @($parsed | ForEach-Object { $_ })
if ($facts.Count -ne $files.Count) { throw "The inspection answered for $($facts.Count) of $($files.Count) files." }
foreach ($fact in $facts) {
  if ($fact.file -isnot [string]) { throw "The inspection wrote a file as something other than a string: $($fact | ConvertTo-Json -Compress)" }
  if ($fact.status -ne 'Valid' -or $fact.subject -cne $cert.Subject -or $fact.problem) {
    throw "Not signed as the release expects: $($fact | ConvertTo-Json -Compress)"
  }
  Write-Host "signed, timestamped and inspected: $($fact.file) ($($fact.type))"
}
Write-Host "The signing script signed and checked $($files.Count) files with the test certificate."
