# Liara API READ-ONLY preflight. No creation, deployment, config, restart or billing.
[CmdletBinding()]
param([switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
$token = $env:LIARA_API_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    if ($NonInteractive) { throw 'LIARA_API_TOKEN is missing.' }
    $secureToken = Read-Host 'Enter Liara API token (hidden)' -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}
if ([string]::IsNullOrWhiteSpace($token)) { throw 'Token is empty.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$headers = @{ Authorization = ('Bearer ' + $token) }
try {
    $null = Invoke-RestMethod -Uri 'https://api.liara.ir/v1/projects' -Method Get -Headers $headers -TimeoutSec 20
    Write-Host '[PASS] Liara API read-only authentication request succeeded.'
    Write-Host 'Nothing was deployed or changed.'
} catch {
    $status = $null
    try { if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode } } catch {}
    if ($null -ne $status) { Write-Host ('[FAIL] HTTP ' + $status + '. No writes attempted.') }
    else { Write-Host '[FAIL] Network or API error. No writes attempted.' }
    exit 1
} finally {
    $token = $null
    $headers.Clear()
}
