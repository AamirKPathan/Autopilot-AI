param(
    [switch]$Force
)

$root = Split-Path -Parent $PSScriptRoot
$services = @(
    @{ Name = 'suna'; RepoUrl = 'https://github.com/kortix-ai/suna.git'; Path = Join-Path $root 'services\suna\source' },
    @{ Name = 'hermes'; RepoUrl = 'https://github.com/NousResearch/hermes-agent.git'; Path = Join-Path $root 'services\hermes\source' }
)

function Test-ServiceRepo {
    param([string]$Path)

    return (Test-Path (Join-Path $Path '.git')) -or (Test-Path (Join-Path $Path 'package.json')) -or (Test-Path (Join-Path $Path 'pyproject.toml')) -or (Test-Path (Join-Path $Path 'setup.py'))
}

foreach ($service in $services) {
    $serviceHome = Split-Path -Parent $service.Path

    if (-not (Test-Path $serviceHome)) {
        New-Item -ItemType Directory -Path $serviceHome -Force | Out-Null
    }

    if ((Test-ServiceRepo -Path $service.Path) -and (-not $Force)) {
        Write-Host "$($service.Name): already populated at $($service.Path). Use -Force to re-clone or refresh manually."
        continue
    }

    if ((Test-ServiceRepo -Path $service.Path) -and $Force) {
        Write-Host "$($service.Name): existing content detected at $($service.Path). Refreshing is left to you to avoid clobbering local edits."
        continue
    }

    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        throw "git is required to bootstrap $($service.Name)"
    }

    if (-not (Test-Path $service.Path)) {
        New-Item -ItemType Directory -Path $service.Path -Force | Out-Null
    }

    Write-Host "Cloning $($service.Name) from $($service.RepoUrl) into $($service.Path)..."
    git clone --depth 1 $service.RepoUrl $service.Path
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to clone $($service.Name)"
    }

    Write-Host "$($service.Name): cloned successfully"
}

Write-Host 'Bootstrap complete.'