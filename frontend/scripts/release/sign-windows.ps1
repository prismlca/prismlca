<#
.SYNOPSIS
  Signs PrismLCA's Windows executables with the SimplySign certificate and checks the result.

.DESCRIPTION
  Called only through sign-windows.mjs, which decides which files are ours and passes the certificate subject in
  PRISM_SIGN_SUBJECT (win.signtoolOptions.publisherName in electron-builder.yml).

    -Wait             waits until the SimplySign sign-in has made the certificate usable (30 minutes at most)
    -Sign <file>      signs one file and checks it
    -Check <files>    checks files signed earlier in the build

  A file passes when signtool verify accepts it with a timestamp, the digest is SHA-256 and the signer's subject
  is exactly the expected one: the subject every installed PrismLCA compares an update against.
#>
[CmdletBinding(DefaultParameterSetName = 'Sign')]
param(
  [Parameter(ParameterSetName = 'Wait', Mandatory)][switch]$Wait,
  [Parameter(ParameterSetName = 'Sign', Mandatory)][string]$Sign,
  [Parameter(ParameterSetName = 'Check', Mandatory)][switch]$Check,
  [Parameter(ParameterSetName = 'Check', ValueFromRemainingArguments)][string[]]$Files
)
$ErrorActionPreference = 'Stop'
$TimestampUrl = 'http://time.certum.pl'
$Subject = $env:PRISM_SIGN_SUBJECT
if (-not $Subject) { throw 'PRISM_SIGN_SUBJECT is not set; sign-windows.mjs passes it.' }

function Find-SignTool {
  $tool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Select-Object -First 1
  if (-not $tool) { throw 'signtool.exe not found: the release VM needs the signing tools of the Windows SDK.' }
  $tool.FullName
}

# The newest valid certificate with exactly our subject; during a renewal two can be in the store.
function Find-Certificate {
  Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -ceq $Subject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
}

function Test-Signature([string]$file, [string]$signtool) {
  if (-not (Test-Path -LiteralPath $file)) { throw "Not found: $file" }
  # /tw turns a missing timestamp into a warning (exit 2); that fails here too.
  $out = & $signtool verify /pa /all /tw /v $file | Out-String
  if ($LASTEXITCODE -ne 0) { throw "signtool verify rejects $file (exit $LASTEXITCODE).`n$out" }
  if ($out -notmatch 'Hash of file \(sha256\)') { throw "$file is not signed with SHA-256.`n$out" }
  $sig = Get-AuthenticodeSignature -LiteralPath $file
  if ($sig.Status -ne 'Valid') { throw "$file has signature status $($sig.Status)." }
  if ($sig.SignerCertificate.Subject -cne $Subject) {
    throw "$file is signed by '$($sig.SignerCertificate.Subject)', expected '$Subject'."
  }
  if (-not $sig.TimeStamperCertificate) { throw "$file has no timestamp." }
  Write-Host "signed and checked: $file"
}

if ($Wait) {
  # release-vm.ps1 on the host watches for this note and calls whoever is at the PC to the VM.
  $note = if ($env:PRISM_SIGNAL_DIR) { Join-Path $env:PRISM_SIGNAL_DIR 'signin.txt' } else { $null }
  if ($note) { Set-Content $note (Get-Date -Format o) }
  Write-Host '::notice::Sign in to SimplySign Desktop in the release VM now (code from the phone app).'
  $deadline = (Get-Date).AddMinutes(30)
  try {
    while ($true) {
      $cert = Find-Certificate
      if ($cert) {
        try {
          # One signature over test bytes, no file: it proves the session works and brings up any PIN prompt
          # now, while someone is at the VM, rather than in the middle of the build.
          $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
          $null = $rsa.SignData([byte[]](1..32), [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
          Write-Host "Signed in: $($cert.Subject), valid until $($cert.NotAfter.ToString('yyyy-MM-dd'))."
          break
        }
        catch { Write-Host "The certificate is in the store but cannot sign yet: $($_.Exception.Message)" }
      }
      if ((Get-Date) -gt $deadline) { throw "No SimplySign sign-in within 30 minutes (expected subject: $Subject)." }
      Start-Sleep -Seconds 10
    }
  }
  finally {
    if ($note) { Remove-Item $note -ErrorAction SilentlyContinue }
  }
  exit 0
}

$signtool = Find-SignTool

if ($Check) {
  if (-not $Files) { throw 'Nothing to check.' }
  foreach ($f in $Files) { Test-Signature $f $signtool }
  exit 0
}

$cert = Find-Certificate
if (-not $cert) { throw "No usable certificate with subject '$Subject'. Is SimplySign Desktop signed in?" }
# The timestamp server is the part that fails now and then; a second or third try usually goes through.
for ($i = 1; $i -le 3; $i++) {
  & $signtool sign /fd SHA256 /tr $TimestampUrl /td SHA256 /sha1 $cert.Thumbprint $Sign
  if ($LASTEXITCODE -eq 0) { break }
  if ($i -eq 3) { throw "signtool could not sign $Sign (exit $LASTEXITCODE)." }
  Write-Host "signtool sign failed (exit $LASTEXITCODE), try $i of 3"
  Start-Sleep -Seconds (10 * $i)
}
Test-Signature $Sign $signtool
