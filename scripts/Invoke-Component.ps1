param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('bootstrap', 'start', 'stop', 'status', 'inventory', 'mobile-start', 'mobile-view', 'mobile-stop')]
    [string]$Action
)

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'config\system-map.json'

if (-not (Test-Path $configPath)) {
    throw "Missing configuration file: $configPath"
}

$config = Get-Content $configPath -Raw | ConvertFrom-Json

function Show-ComponentStatus {
    param(
        [string]$Name,
        [object]$Component
    )

    $location = $Component.location
    $status = $Component.status
    $notes = $Component.notes
    $path = Join-Path $root $location
    $presence = if (Test-Path $path) { 'present' } else { 'missing' }
    Write-Host ("{0}: {1} [{2}] ({3}) - {4}" -f $Name, $status, $presence, $location, $notes)
}

function Show-InventoryRow {
    param(
        [string]$Name,
        [object]$Component
    )

    $path = Join-Path $root $Component.location
    $exists = Test-Path $path
    $state = if ($exists) { 'present' } else { 'missing' }
    Write-Host ("{0}: {1} -> {2}" -f $Name, $state, $Component.location)
}

switch ($Action) {
    'bootstrap' {
        Write-Host 'Bootstrapping local Suna and Hermes service homes from the upstream repos.'
        & (Join-Path $root 'scripts\bootstrap-services.ps1')
    }
    'inventory' {
        Write-Host "Local AI stack inventory"
        $config.components.PSObject.Properties | ForEach-Object {
            Show-InventoryRow -Name $_.Name -Component $_.Value
        }
    }
    'status' {
        Write-Host "Local AI stack status"
        $config.components.PSObject.Properties | ForEach-Object {
            Show-ComponentStatus -Name $_.Name -Component $_.Value
        }
    }
    'start' {
        Write-Host "Start is scaffolded. Fill in the real service commands in config/system-map.json and wire them here."
        $config.components.PSObject.Properties | ForEach-Object {
            Show-ComponentStatus -Name $_.Name -Component $_.Value
        }
    }
    'stop' {
        Write-Host "Stop is scaffolded. Add real shutdown commands once the services exist."
        $config.components.PSObject.Properties | ForEach-Object {
            Show-ComponentStatus -Name $_.Name -Component $_.Value
        }
    }
    'mobile-start' {
        Write-Host "Mobile backend start is scaffolded. Connect this to the emulator/backend command later."
    }
    'mobile-view' {
        Write-Host "Mobile view is scaffolded. Connect this to the emulator screen or remote view later."
    }
    'mobile-stop' {
        Write-Host "Mobile backend stop is scaffolded. Add the real shutdown command later."
    }
}
