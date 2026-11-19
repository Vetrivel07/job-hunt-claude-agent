# Wrapper that Task Scheduler runs. Task Scheduler has no console and a minimal
# PATH, so this sets PATH up and writes everything to a log file.
param([string[]]$AgentArgs = @())

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here
New-Item -ItemType Directory -Force -Path (Join-Path $here 'logs') | Out-Null
$schedLog = Join-Path $here 'logs\scheduler.log'

# Common install locations for node, npm-global claude, native claude, Git.
$extra = @(
  "$env:ProgramFiles\nodejs",
  "$env:APPDATA\npm",
  "$env:USERPROFILE\.local\bin",
  "$env:LOCALAPPDATA\Programs\claude",
  "$env:ProgramFiles\Git\cmd",
  "$env:ProgramFiles\Git\bin"
) | Where-Object { $_ -and (Test-Path $_) }
$env:Path = (($extra + ($env:Path -split ';')) | Select-Object -Unique) -join ';'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Add-Content $schedLog "$(Get-Date -Format s) ERROR: node.exe not found on PATH"
  exit 1
}

Add-Content $schedLog "$(Get-Date -Format s) start: $node daily-agent.mjs $($AgentArgs -join ' ')"
& $node (Join-Path $here 'daily-agent.mjs') @AgentArgs *>> $schedLog
$code = $LASTEXITCODE
Add-Content $schedLog "$(Get-Date -Format s) end: exit $code"
exit $code
