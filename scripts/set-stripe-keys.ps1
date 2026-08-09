<#
.SYNOPSIS
  Put the Stripe keys into Railway, interactively.

.DESCRIPTION
  Run this in YOUR terminal - it is interactive and cannot be run by Claude.

  Each secret is typed into a masked prompt and piped straight to the Railway
  CLI over stdin. That means the value never appears in a command line, in
  PowerShell history, in this repo, or in Claude's context. Nothing is echoed
  back and nothing is written to disk.

  Usage:
    pwsh -File scripts/set-stripe-keys.ps1
    (or right-click -> Run with PowerShell, from the repo root)
#>

[CmdletBinding()]
param(
  [string]$Service = 'PBJBillingApp'
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "`n$text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "  $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  $text" -ForegroundColor Yellow }

Write-Host "Stripe keys -> Railway ($Service)" -ForegroundColor White
Write-Host "Values are masked as you type and piped straight to Railway. Nothing is stored here."

# --- Ask for each secret, validating the shape before sending anything -------

function Read-Secret {
  param(
    [Parameter(Mandatory)] [string]$Prompt,
    [Parameter(Mandatory)] [string[]]$ExpectedPrefixes
  )

  while ($true) {
    $secure = Read-Host -Prompt $Prompt -AsSecureString
    $plain = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR(
      [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    )

    if ([string]::IsNullOrWhiteSpace($plain)) {
      Write-Warn 'Nothing entered - try again, or Ctrl+C to stop.'
      continue
    }

    $plain = $plain.Trim()
    $matched = $false
    foreach ($prefix in $ExpectedPrefixes) {
      if ($plain.StartsWith($prefix)) { $matched = $true; break }
    }

    if (-not $matched) {
      # Say what was expected WITHOUT echoing what was typed.
      Write-Warn ("That does not look right - expected it to start with: " + ($ExpectedPrefixes -join ' or '))
      Write-Warn 'Nothing was sent. Try again, or Ctrl+C to stop.'
      continue
    }

    return $plain
  }
}

Write-Step '1/3  Secret key'
Write-Host '  Stripe -> Developers -> API keys. Use the RESTRICTED key you created.'
Write-Host '  In a sandbox or test mode it starts sk_test_ (live starts sk_live_).'
$secretKey = Read-Secret -Prompt '  Paste STRIPE_SECRET_KEY' -ExpectedPrefixes @('sk_test_', 'sk_live_', 'rk_test_', 'rk_live_')

if ($secretKey.StartsWith('sk_live_') -or $secretKey.StartsWith('rk_live_')) {
  Write-Warn 'That is a LIVE key. Real money will move once invoices are sent.'
  $confirm = Read-Host '  Type LIVE to confirm, or anything else to stop'
  if ($confirm -ne 'LIVE') { Write-Host "`nStopped. Nothing was changed." -ForegroundColor Yellow; exit 1 }
}

Write-Step '2/3  Webhook signing secret'
Write-Host '  Stripe -> Developers -> Webhooks -> your endpoint -> Signing secret.'
Write-Host '  It starts whsec_ and is NOT the same as the API key.'
$webhookSecret = Read-Secret -Prompt '  Paste STRIPE_WEBHOOK_SECRET' -ExpectedPrefixes @('whsec_')

# --- Send them, one at a time, over stdin ------------------------------------

Write-Step '3/3  Sending to Railway'

function Set-RailwayVariable {
  param([string]$Key, [string]$Value)

  # --stdin keeps the value off the command line, so it cannot leak into
  # process listings or shell history.
  $Value | & npx '@railway/cli@latest' variable set $Key --stdin --service $Service | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Railway refused to set $Key (exit $LASTEXITCODE). Are you logged in? Try: npx @railway/cli@latest login"
  }
  Write-Ok "$Key set"
}

try {
  Set-RailwayVariable -Key 'STRIPE_SECRET_KEY'     -Value $secretKey
  Set-RailwayVariable -Key 'STRIPE_WEBHOOK_SECRET' -Value $webhookSecret
}
finally {
  # Do not leave the secrets sitting in session variables.
  Remove-Variable -Name secretKey, webhookSecret -ErrorAction SilentlyContinue
}

# --- Confirm by NAME only ----------------------------------------------------

Write-Step 'Checking'
$names = & npx '@railway/cli@latest' variables --service $Service --json 2>$null |
  ConvertFrom-Json |
  Get-Member -MemberType NoteProperty |
  Select-Object -ExpandProperty Name

foreach ($key in @('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET')) {
  if ($names -contains $key) { Write-Ok "$key is present" }
  else { Write-Warn "$key is MISSING - something went wrong" }
}

Write-Host "`nDone. Railway will redeploy with the new variables." -ForegroundColor Green
Write-Host "Tell Claude they are set - it can confirm they exist without ever seeing the values."
