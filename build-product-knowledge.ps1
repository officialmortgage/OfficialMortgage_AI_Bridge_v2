# =====================================================================
# OFFICIAL MORTGAGE - LIV PRODUCT MATRIX INGESTION ENGINE v3
# Converts all product PDF matrices into TXT + JSON for Liv Brain v4
# =====================================================================

# ---- CONFIG ----------------------------------------------------------

# Path to pdftotext.exe
$PdfToText = "C:\Program Files\poppler-25.11.0\Library\bin\pdftotext.exe"

# Your REAL folder containing all PDFs (from screenshot)
$SourceFolder = "C:\OfficialMortgage_AI_Bridge\product-matrices\MATRIX AND PRODUCTS\pdf"

# Output folder for normalized text + metadata
$OutputFolder = "C:\OfficialMortgage_AI_Bridge\liv-brain-v4\product-knowledge"

# Ensure output folder exists
if (!(Test-Path $OutputFolder)) {
    New-Item -ItemType Directory -Path $OutputFolder | Out-Null
}

Write-Host "------------------------------------------------------------"
Write-Host " LIV PRODUCT MATRIX INGESTION ENGINE STARTING..."
Write-Host "------------------------------------------------------------"

# ---- LOAD PDF FILES --------------------------------------------------

$PdfFiles = Get-ChildItem -Path $SourceFolder -Filter *.pdf

if ($PdfFiles.Count -eq 0) {
    Write-Host " ERROR: No PDF files found at:"
    Write-Host "        $SourceFolder"
    exit
}

foreach ($Pdf in $PdfFiles) {

    Write-Host "`nProcessing: $($Pdf.Name)"

    # Output names
    $BaseName = [System.IO.Path]::GetFileNameWithoutExtension($Pdf.FullName)
    $TxtOut = Join-Path $OutputFolder "$BaseName.txt"
    $JsonOut = Join-Path $OutputFolder "$BaseName.json"

    # ---- 1. Extract text from PDF ------------------------------------
    Write-Host " • Extracting text…"
    & $PdfToText -layout "`"$($Pdf.FullName)`"" "`"$TxtOut`""

    if (!(Test-Path $TxtOut)) {
        Write-Host "   ERROR extracting text. Skipping $($Pdf.Name)"
        continue
    }

    # ---- 2. Clean + normalize text -----------------------------------
    Write-Host " • Cleaning text…"
    $Raw = Get-Content $TxtOut -Raw

    $Clean = $Raw `
        -replace "\s{2,}", " " `
        -replace "•", "-" `
        -replace "[“”]", '"' `
        -replace "[’']", "'" `
        -replace "–|—", "-" `
        -replace "\t", " " `
        -replace "`r`n", "`n"

    Set-Content -Path $TxtOut -Value $Clean

    # ---- 3. Auto-tag product category --------------------------------
    Write-Host " • Identifying product category…"

    $Category = "Unknown"

    if ($BaseName -match "FHA") { $Category = "FHA" }
    elseif ($BaseName -match "VA") { $Category = "VA" }
    elseif ($BaseName -match "Conv|Conventional") { $Category = "Conventional" }
    elseif ($BaseName -match "NONI|NON-QM|NonQM|DSCR|Investor") { $Category = "DSCR / Non-QM" }
    elseif ($BaseName -match "Jumbo") { $Category = "Jumbo" }
    elseif ($BaseName -match "ARM") { $Category = "ARM" }

    # ---- 4. Create JSON metadata -------------------------------------
    Write-Host " • Creating JSON metadata…"

    $Meta = [PSCustomObject]@{
        file              = $Pdf.Name
        base_name         = $BaseName
        product_category  = $Category
        extracted_text    = $Clean
        ingested_at       = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    }

    $Meta | ConvertTo-Json -Depth 10 | Set-Content -Path $JsonOut

    Write-Host " ✓ Completed: $BaseName"
}

Write-Host "`n------------------------------------------------------------"
Write-Host " INGESTION COMPLETE — Files ready in product-knowledge/"
Write-Host "------------------------------------------------------------"
