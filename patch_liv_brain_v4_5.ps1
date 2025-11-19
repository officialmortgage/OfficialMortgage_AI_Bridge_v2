# ============================================
# Liv Brain v4.5 Style/Tone Patch (Unified Brain)
# - Target: liv-brain-v4\00_liv_brain_v4_4.txt
# - Removes repeating tagline
# - Adds style override with new greeting + tone
# ============================================

$repoRoot  = Split-Path -Parent $MyInvocation.MyCommand.Path
$brainFile = Join-Path $repoRoot "liv-brain-v4\00_liv_brain_v4_4.txt"

Write-Host "=== LIV BRAIN v4.5 STYLE PATCH ==="
Write-Host "Repo root : $repoRoot"
Write-Host "Brain file: $brainFile"
Write-Host ""

if (-not (Test-Path $brainFile)) {
    Write-Error "Brain file not found: $brainFile"
    exit 1
}

# 1) Backup original unified brain file
$timestamp  = Get-Date -Format "yyyyMMdd_HHmmss"
$backupPath = "$brainFile.bak_$timestamp"

Copy-Item -Path $brainFile -Destination $backupPath -Force
Write-Host "Backup created: $backupPath"
Write-Host ""

# 2) Load content and remove the old repeating tagline
$oldTagline = "You can ask another question or tell me what you see on your screen."

$content = Get-Content $brainFile -Raw

$taglineCount = ([regex]::Matches($content, [regex]::Escape($oldTagline))).Count
Write-Host "Found $taglineCount occurrence(s) of old tagline."

$contentNoTagline = $content -replace [regex]::Escape($oldTagline), ""

# 3) Prepend style override block with new greeting + tone
$styleBlock = @"
[STYLE OVERRIDE — LIV v4.5 GREETING + TONE]

• Greeting to use at the start of most calls:
  "Hi, this is Liv with Official Mortgage. How can I help you today — buy a home, refinance, or pull cash out of your equity?"

• Behavioral rules:
  - Keep most responses to 1–3 sentences.
  - Answer the borrower’s question first, then give one clear next step.
  - Do not say "I've got your notes covered" or similar meta comments.
  - Do not end every response with the same line or with "You can ask another question or tell me what you see on your screen."
  - Use calm, confident loan-officer language, not chatbot-style phrasing.

[END STYLE OVERRIDE]
"@

$newContent = $styleBlock + "`r`n`r`n" + $contentNoTagline

Set-Content -Path $brainFile -Value $newContent -Encoding UTF8

Write-Host ""
Write-Host "Removed $taglineCount occurrence(s) of the old repeating tagline."
Write-Host "Prepended v4.5 style override and saved updated brain file."
Write-Host "=== PATCH COMPLETE — remember to git commit + push + redeploy ==="
