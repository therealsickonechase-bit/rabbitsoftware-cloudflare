param(
    [Parameter(Mandatory = $true)]
    [string]$Vault,
    [string]$TaskName = 'RabbitOS GitHub Vault Sync'
)

$ErrorActionPreference = 'Stop'
$vaultPath = (Resolve-Path -LiteralPath $Vault).Path
$scriptPath = Join-Path $PSScriptRoot 'sync-github-vault.py'
$python = (Get-Command python -CommandType Application | Select-Object -First 1).Source
$policyPath = Join-Path $vaultPath 'GitHub Live\policy.json'
if (-not (Test-Path -LiteralPath $policyPath)) {
    throw 'Complete sync-github-vault.py --setup before installing live sync.'
}
$policy = Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
if ($policy.auto_push_private -ne $false) {
    throw 'Private repository auto-publishing must remain disabled.'
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    throw "Task already exists: $TaskName. Inspect it before replacing it."
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '"' + $scriptPath + '" --vault "' + $vaultPath + '"'
$action = New-ScheduledTaskAction -Execute $python -Argument $arguments `
    -WorkingDirectory (Split-Path -Parent $PSScriptRoot)
$interval = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 12)

Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger @($interval, $logon) -Principal $principal -Settings $settings `
    -Description 'Fetch full GitHub histories and assets; publish eligible public repo edits only.' |
    Select-Object TaskName, State
