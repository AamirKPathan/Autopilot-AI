param(
    [switch]$Force
)

& (Join-Path $PSScriptRoot 'bootstrap-services.ps1') -Force:$Force