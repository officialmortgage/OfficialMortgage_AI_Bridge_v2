# ================================================
# OFFICIAL MORTGAGE — LIV BRAIN UNIFY SCRIPT v4.4
# - Backs up existing brain files
# - Renames all .txt modules to .txt.bak
# - Creates 00_liv_brain_v4_4.txt placeholder
# ================================================

$brainDir    = "liv-brain-v4"
$unifiedName = "00_liv_brain_v4_4.txt"
$backupDir   = "_backup_before_v4_4"

Write-Host "=== LIV BRAIN UNIFY SCRIPT v4.4 START ==="

# 1) Make sure brain directory exists
if (-not (Test-Path $brainDir)) {
    Write-Error "Brain directory '$brainDir' not found. Update `$brainDir and rerun."
    exit 1
}

Push-Location $brainDir

# 2) Create backup folder (once)
if (-not (Test-Path $backupDir)) {
    New-Item -ItemType Directory -Path $backupDir | Out-Null
    Write-Host "Created backup folder: $backupDir"
} else {
    Write-Host "Backup folder already exists: $backupDir"
}

# 3) Backup current .txt and .bak files
Get-ChildItem -File -Include *.txt,*.bak | ForEach-Object {
    $dest = Join-Path $backupDir $_.Name
    Copy-Item $_.FullName $dest -Force
}
Write-Host "Backed up existing brain files into: $backupDir"

# 4) Rename all .txt modules to .txt.bak (except unified file if it exists)
Get-ChildItem -File -Filter *.txt | Where-Object { $_.Name -ne $unifiedName } | ForEach-Object {
    $bakName = "$($_.Name).bak"
    if (-not (Test-Path $bakName)) {
        Rename-Item -Path $_.Name -NewName $bakName
        Write-Host "Renamed: $($_.Name) -> $bakName"
    } else {
        Write-Host "Skipping (bak already exists): $($_.Name)"
    }
}

# 5) Create unified brain file placeholder if it doesn't exist
if (-not (Test-Path $unifiedName)) {
    $header = @"
[OFFICIAL MORTGAGE — LIV UNIFIED BRAIN v4.4]

# Paste the FULL unified brain v4.4 content below this line.
"@
    Set-Content -Path $unifiedName -Value $header -Encoding UTF8
    Write-Host "Created unified brain file placeholder: $unifiedName"
} else {
    Write-Host "Unified brain file already exists: $unifiedName (left unchanged)"
}

Pop-Location

Write-Host "=== LIV BRAIN UNIFY SCRIPT v4.4 COMPLETE ==="
