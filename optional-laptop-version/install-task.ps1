# Registers (or removes) the Windows scheduled task for the daily agent.
#
#   powershell -ExecutionPolicy Bypass -File install-task.ps1                 # daily at 7:45 AM
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -Time 06:30
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -Weekdays       # Mon-Fri only
#   powershell -ExecutionPolicy Bypass -File install-task.ps1 -Uninstall
#
# Run it from a normal (NOT "Run as administrator") PowerShell window, so the
# task runs as you and can use your Claude Code login.
param(
  [string]$Time = '07:45',
  [string]$TaskName = 'career-ops daily agent',
  [switch]$Weekdays,
  [switch]$Uninstall
)

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed scheduled task '$TaskName'."
  exit 0
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'run-daily.ps1'
if (-not (Test-Path (Join-Path $here '.env'))) {
  Write-Warning "No .env found in $here. Copy .env.example to .env and fill it in first."
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory $here

$at = [datetime]::ParseExact($Time, 'HH:mm', $null)
if ($Weekdays) {
  $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $at
} else {
  $trigger = New-ScheduledTaskTrigger -Daily -At $at
}

# StartWhenAvailable: if the PC was asleep/off at the scheduled time, run as soon as it's back.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 6) -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Scan job boards, screen and evaluate matches with career-ops, prepare CVs/cover letters, log to Excel, notify on WhatsApp. Never submits applications.' -Force | Out-Null

Write-Host "Scheduled '$TaskName' $(if ($Weekdays) {'Mon-Fri'} else {'daily'}) at $Time."
Write-Host "Run it now to test:  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "Logs:                $here\logs\"
