#Requires -Version 5.1
<#
.SYNOPSIS
    Builds a portable zip distribution of Launch Deck.

.DESCRIPTION
    Compiles the Tauri release build (or accepts an existing output directory),
    packages the executable into dist-portable\LaunchDeck-Portable-x64\,
    adds a README_PORTABLE.txt, and zips the folder to
    dist-portable\LaunchDeck-Portable-x64.zip.

.PARAMETER SkipBuild
    Skip the `npm run tauri build` step and use an existing build output.

.PARAMETER BuildOutputDir
    Path to the Tauri release output directory.
    Default: src-tauri\target\release

.EXAMPLE
    .\scripts\package-portable.ps1
    .\scripts\package-portable.ps1 -SkipBuild
#>

param(
    [switch]$SkipBuild,
    [string]$BuildOutputDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step([string]$msg) { Write-Host "`n>> $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "   OK  $msg" -ForegroundColor Green }
function Write-Err([string]$msg)  { Write-Host "   ERR $msg" -ForegroundColor Red }

function Require-File([string]$path, [string]$label) {
    if (-not (Test-Path $path)) {
        Write-Err "Expected $label not found: $path"
        exit 1
    }
    Write-Ok "Found $label"
}

# ── Resolve paths ─────────────────────────────────────────────────────────────

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TauriReleaseDir = if ($BuildOutputDir) { $BuildOutputDir } else { Join-Path $RepoRoot "src-tauri\target\release" }
$DistPortable    = Join-Path $RepoRoot "dist-portable"
$PackageDir      = Join-Path $DistPortable "LaunchDeck-Portable-x64"
$ZipPath         = Join-Path $DistPortable "LaunchDeck-Portable-x64.zip"

# ── Step 1 – build ────────────────────────────────────────────────────────────

if (-not $SkipBuild) {
    Write-Step "Building Tauri release..."
    Push-Location $RepoRoot
    try {
        npm run tauri -- build
        if ($LASTEXITCODE -ne 0) {
            Write-Err "Tauri build failed (exit $LASTEXITCODE)"
            exit 1
        }
    } finally {
        Pop-Location
    }
    Write-Ok "Build complete"
} else {
    Write-Step "Skipping build — using existing output in: $TauriReleaseDir"
}

# ── Step 2 – validate build output ───────────────────────────────────────────

Write-Step "Validating build output..."
Require-File $TauriReleaseDir "release output directory"

# Launch Deck executable
$ExePath = Join-Path $TauriReleaseDir "launch-deck.exe"
if (-not (Test-Path $ExePath)) {
    # Tauri sometimes names the exe after the productName
    $ExePath = Join-Path $TauriReleaseDir "Launch Deck.exe"
}
if (-not (Test-Path $ExePath)) {
    Write-Err "Could not find launch-deck.exe or 'Launch Deck.exe' in: $TauriReleaseDir"
    Write-Host "   Files present:" -ForegroundColor Yellow
    Get-ChildItem $TauriReleaseDir -Filter "*.exe" | ForEach-Object { Write-Host "     $_" }
    exit 1
}
Write-Ok "Found executable: $(Split-Path -Leaf $ExePath)"

# WebView2Loader.dll (bundled by Tauri)
$WebView2Dll = Join-Path $TauriReleaseDir "WebView2Loader.dll"

# ── Step 3 – prepare output directory ────────────────────────────────────────

Write-Step "Preparing output directory: $PackageDir"

if (Test-Path $PackageDir) {
    Write-Host "   Cleaning existing directory..." -ForegroundColor Yellow
    Remove-Item $PackageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $PackageDir -Force | Out-Null
Write-Ok "Directory ready"

# ── Step 4 – copy files ───────────────────────────────────────────────────────

Write-Step "Copying files..."

Copy-Item $ExePath (Join-Path $PackageDir "LaunchDeck.exe") -Force
Write-Ok "Copied LaunchDeck.exe"

if (Test-Path $WebView2Dll) {
    Copy-Item $WebView2Dll (Join-Path $PackageDir "WebView2Loader.dll") -Force
    Write-Ok "Copied WebView2Loader.dll"
} else {
    Write-Host "   NOTE WebView2Loader.dll not found — may already be installed system-wide" -ForegroundColor Yellow
}

# Copy any additional .dll files from the release directory (e.g. SQLite)
$ExtraDlls = Get-ChildItem $TauriReleaseDir -Filter "*.dll" -ErrorAction SilentlyContinue
foreach ($dll in $ExtraDlls) {
    Copy-Item $dll.FullName (Join-Path $PackageDir $dll.Name) -Force
    Write-Ok "Copied $($dll.Name)"
}

# ── Step 5 – write README_PORTABLE.txt ───────────────────────────────────────

Write-Step "Writing README_PORTABLE.txt..."

$ReadmeContent = @"
Launch Deck — Portable Build
==============================

This version of Launch Deck does NOT require installation.
You can run LaunchDeck.exe directly from this folder.

IMPORTANT NOTES
---------------

1. USER DATA
   Settings, library data, and authentication are stored in your normal
   Windows AppData folder:
     %APPDATA%\com.launchdeck.app\

   This is the same location used by the installed version. If you run both
   the installed and portable builds, they share the same data.

2. AUTO-UPDATES
   Portable builds do NOT support automatic in-place updates.
   The app will detect new versions and notify you, but will direct you to
   download the new portable zip manually.

   To update this portable build:
     1. Download the latest LaunchDeck-Portable-x64.zip from the releases page.
     2. Extract the new zip to a fresh folder.
     3. Copy your settings across if needed (they are stored in AppData, not here).
     4. Replace or delete the old portable folder.

3. WEBVIEW2
   Launch Deck requires Microsoft WebView2 Runtime.
   If it is not already installed on your system, Windows will prompt you to
   install it the first time you run the app.
   You can also install it manually from:
     https://developer.microsoft.com/microsoft-edge/webview2/

4. ANTIVIRUS
   Some antivirus tools may flag unsigned executables. This is a false positive.
   The portable build is identical to the installed version; only the delivery
   method differs. If you prefer a signed installer, use LaunchDeck-Setup-x64.exe.

"@

$ReadmePath = Join-Path $PackageDir "README_PORTABLE.txt"
$ReadmeContent | Out-File -FilePath $ReadmePath -Encoding UTF8 -Force
Write-Ok "Wrote README_PORTABLE.txt"

# ── Step 6 – zip ─────────────────────────────────────────────────────────────

Write-Step "Creating zip: $ZipPath"

if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}

# Verify we have files to zip
$FilesToZip = Get-ChildItem $PackageDir
if ($FilesToZip.Count -eq 0) {
    Write-Err "Package directory is empty — nothing to zip"
    exit 1
}

Compress-Archive -Path "$PackageDir\*" -DestinationPath $ZipPath -CompressionLevel Optimal
Write-Ok "Created $ZipPath"

# ── Done ──────────────────────────────────────────────────────────────────────

$ZipSizeMB = [math]::Round((Get-Item $ZipPath).Length / 1MB, 1)

Write-Host "`n=============================" -ForegroundColor Green
Write-Host " Portable build complete" -ForegroundColor Green
Write-Host "=============================" -ForegroundColor Green
Write-Host ""
Write-Host "  Package folder : $PackageDir"
Write-Host "  Zip file       : $ZipPath ($ZipSizeMB MB)"
Write-Host ""
Write-Host "  Files in package:"
Get-ChildItem $PackageDir | ForEach-Object {
    $sizekb = [math]::Round($_.Length / 1KB, 0)
    Write-Host "    $($_.Name)  ($sizekb KB)"
}
Write-Host ""
