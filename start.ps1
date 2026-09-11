[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot '.env.worker')
)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$workerPython = Join-Path $projectRoot 'worker/.venv/Scripts/python.exe'
$savedEnvironment = @{}
$workerExitCode = 1
try {
    if (-not (Test-Path -LiteralPath $workerPython -PathType Leaf)) {
        throw 'Worker environment is missing. Run .\setup-worker.ps1 once.'
    }
    $allowedKeys = @('ROADLENS_RELAY_URL', 'ROADLENS_WORKER_SECRET', 'ROADLENS_MODEL_MODE', 'ROADLENS_GPU_RUNTIME', 'ROADLENS_GPU_DEVICE', 'ROADLENS_ALLOW_LOOPBACK', 'ALLOW_WORKER_CPU_FALLBACK')
    if (Test-Path -LiteralPath $configPath -PathType Leaf) {
        $seenKeys = @{}
        foreach ($configLine in [System.IO.File]::ReadAllLines($configPath)) {
            $line = $configLine.Trim()
            if ($line.Length -eq 0 -or $line.StartsWith('#')) { continue }
            if ($line -notmatch '^([A-Z][A-Z0-9_]*)\s*=(.*)$') {
                throw 'Invalid .env.worker syntax. Use literal KEY=value entries; no PowerShell expressions.'
            }
            $key = $Matches[1]
            $value = $Matches[2].Trim()
            if ($allowedKeys -notcontains $key -or $seenKeys.ContainsKey($key)) {
                throw 'Unknown or duplicate setting in .env.worker.'
            }
            $seenKeys[$key] = $true
            if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
                if ($value.Length -lt 2) { throw 'Invalid quoted value in .env.worker.' }
                $value = $value.Substring(1, $value.Length - 2)
            }
            $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
            [Environment]::SetEnvironmentVariable($key, $value, 'Process')
        }
    }
    foreach ($key in @('PYTHONUNBUFFERED', 'PYTHONDONTWRITEBYTECODE')) {
        $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, '1', 'Process')
    }
    Push-Location -LiteralPath $projectRoot
    try {
        & $workerPython -c "import sys; assert sys.version_info[:2] == (3,13), 'Worker requires isolated Python 3.13'; from worker.config import Config; Config.from_env(); import websockets, torch, PIL"
        if ($LASTEXITCODE -ne 0) { throw 'Worker configuration/packages are not ready. Check .env.worker and run setup once.' }
        Write-Host 'RoadLens optional GPU worker — foreground mode. Ctrl+C stops only this worker.'
        & $workerPython -c "import json; from worker.config import Config; from worker.runtime.gpu import preflight; print(json.dumps(preflight(Config.from_env().device), indent=2))"
        if ($LASTEXITCODE -ne 0) { throw 'NVIDIA runtime preflight failed. Python CPU fallback is disabled.' }
        & $workerPython -m worker.main
        $workerExitCode = $LASTEXITCODE
    }
    finally { Pop-Location }
}
catch {
    # Script errors contain fixed instructions, never configuration values.
    Write-Error -Message $_.Exception.Message -ErrorAction Continue
}
finally {
    foreach ($key in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process')
    }
}
exit $workerExitCode
