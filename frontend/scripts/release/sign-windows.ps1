<#
.SYNOPSIS
  Signs PrismLCA's Windows program files with the SimplySign certificate, and says how files are signed.

.DESCRIPTION
  Called only through sign-windows.mjs, which decides what is signed and passes the certificate subject in
  PRISM_SIGN_SUBJECT (win.signtoolOptions.publisherName in electron-builder.yml).

    -Wait                          waits until the SimplySign sign-in has made the certificate usable (30 minutes at most)
    -Sign -List <file>             signs the files listed (one path per line), timestamps them and checks each
    -Inspect -List <file> -Out <f> writes what Windows says about each listed file's signature, as JSON; needs no key

  Ours passes when signtool verify accepts it with a timestamp, the digest is SHA-256, the signature is embedded and
  the signer's subject is exactly the expected one: the subject every installed PrismLCA compares an update against.
#>
[CmdletBinding(DefaultParameterSetName = 'Wait')]
param(
  [Parameter(ParameterSetName = 'Wait', Mandatory)][switch]$Wait,
  [Parameter(ParameterSetName = 'Sign', Mandatory)][switch]$Sign,
  [Parameter(ParameterSetName = 'Inspect', Mandatory)][switch]$Inspect,
  [Parameter(ParameterSetName = 'Sign', Mandatory)]
  [Parameter(ParameterSetName = 'Inspect', Mandatory)][string]$List,
  [Parameter(ParameterSetName = 'Inspect', Mandatory)][string]$Out
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

# Read as plain .NET strings, not with Get-Content: its lines carry PowerShell's own note properties (PSPath,
# ReadCount), and Windows PowerShell's ConvertTo-Json writes such a line as an object instead of a string.
function Read-List([string]$path) {
  @([System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8) | Where-Object { $_ })
}

# Older Windows PowerShell has no SignatureType; then the embedded table sign-windows.mjs found has to do.
function Get-SignatureType($sig) {
  if ($sig.PSObject.Properties['SignatureType']) { "$($sig.SignatureType)" } else { '' }
}

# The certificate of the signature embedded in a file, or $null when the file carries none.
function Get-EmbeddedSigner([string]$file) {
  try { [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($file) }
  catch { $null }
}

# Why a file falls short of our standard, or $null when it meets it.
function Get-SignatureProblem([string]$file, [string]$signtool) {
  if (-not (Test-Path -LiteralPath $file)) { return "Not found: $file" }
  # /tw turns a missing timestamp into a warning (exit 2); that fails here too.
  $out = & $signtool verify /pa /all /tw /v $file | Out-String
  if ($LASTEXITCODE -ne 0) { return "signtool verify rejects $file (exit $LASTEXITCODE).`n$out" }
  if ($out -notmatch 'Hash of file \(sha256\)') { return "$file is not signed with SHA-256.`n$out" }
  $sig = Get-AuthenticodeSignature -LiteralPath $file
  if ($sig.Status -ne 'Valid') { return "$file has signature status $($sig.Status)." }
  $type = Get-SignatureType $sig
  if ($type -and $type -ne 'Authenticode') { return "$file carries no embedded signature (found: $type)." }
  if ($sig.SignerCertificate.Subject -cne $Subject) {
    return "$file is signed by '$($sig.SignerCertificate.Subject)', expected '$Subject'."
  }
  if (-not $sig.TimeStamperCertificate) { return "$file has no timestamp." }
  return $null
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
$files = Read-List $List

if ($Inspect) {
  $facts = foreach ($f in $files) {
    $sig = Get-AuthenticodeSignature -LiteralPath $f
    $status = "$($sig.Status)"
    $type = Get-SignatureType $sig
    $signer = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { '' }
    if ($type -eq 'Catalog') {
      # A file that is also a part of Windows (Electron ships d3dcompiler_47.dll and dxil.dll) is answered for
      # with the catalog this machine knows it from, and nothing is said of the signature inside the file. That
      # one is what ships, so it is asked for on its own: signtool verify without a catalog option reads the
      # embedded signature alone. A file with no embedded signature keeps the catalog answer.
      $embedded = Get-EmbeddedSigner $f
      if ($embedded) {
        $null = & $signtool verify /pa $f | Out-String
        $status = if ($LASTEXITCODE -eq 0) { 'Valid' } else { "NotValid (signtool verify, exit $LASTEXITCODE)" }
        $type = 'Authenticode'
        $signer = $embedded.Subject
      }
    }
    # Ours is held to our standard; another maker's signature only has to be valid.
    $problem = if ($signer -ceq $Subject) { Get-SignatureProblem $f $signtool } else { $null }
    [pscustomobject]@{ file = "$f"; status = $status; type = "$type"; subject = "$signer"; problem = $problem }
  }
  $json = ConvertTo-Json -InputObject @($facts) -Depth 3 -Compress
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding $false))
  exit 0
}

if (-not $files) { throw 'Nothing to sign.' }
$cert = Find-Certificate
if (-not $cert) { throw "No usable certificate with subject '$Subject'. Is SimplySign Desktop signed in?" }

# Every file costs one signature from Certum's monthly allowance, so signing and timestamping are separate steps:
# a call that fails is repeated only for the files that carry no signature at all afterwards, and the timestamp
# server — the part that fails now and then — is asked again without signing anything again. A file that does
# carry a signature after the call but not our valid one stops the run: signing it again would spend another
# signature on a problem a new one does not solve (an untrusted chain on this machine, say).
$todo = $files
for ($i = 1; ; $i++) {
  & $signtool sign /fd SHA256 /sha1 $cert.Thumbprint @todo
  $code = $LASTEXITCODE
  $left = @()
  foreach ($f in $todo) {
    $sig = Get-AuthenticodeSignature -LiteralPath $f
    if (-not $sig.SignerCertificate) { $left += $f }
    elseif ($sig.SignerCertificate.Thumbprint -ne $cert.Thumbprint -or $sig.Status -ne 'Valid') {
      throw "$f is signed but not validly by us after signing ($($sig.Status), $($sig.SignerCertificate.Subject)); not signing it again."
    }
  }
  $todo = $left
  if (-not $todo) { break }
  if ($i -eq 3) { throw "signtool left $($todo.Count) file(s) unsigned (exit $code): $($todo -join ', ')" }
  Write-Host "signtool sign left $($todo.Count) file(s) unsigned (exit $code), try $i of 3"
  Start-Sleep -Seconds (10 * $i)
}
$todo = $files
for ($i = 1; ; $i++) {
  & $signtool timestamp /tr $TimestampUrl /td SHA256 @todo
  $code = $LASTEXITCODE
  $todo = @($todo | Where-Object { -not (Get-AuthenticodeSignature -LiteralPath $_).TimeStamperCertificate })
  if (-not $todo) { break }
  if ($i -eq 6) { throw "$($todo.Count) file(s) still have no timestamp (exit $code): $($todo -join ', ')" }
  Write-Host "signtool timestamp left $($todo.Count) file(s) without a timestamp (exit $code), try $i of 6"
  Start-Sleep -Seconds (15 * $i)
}
foreach ($f in $files) {
  $problem = Get-SignatureProblem $f $signtool
  if ($problem) { throw $problem }
  Write-Host "signed and checked: $f"
}
