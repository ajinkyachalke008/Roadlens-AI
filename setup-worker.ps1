[CmdletBinding()]
param(
    [string]$PythonExecutable = 'py',
    [switch]$BuildTensorRT,
    [ValidateRange(5, 100)][int]$BenchmarkIterations = 20,
    [string]$BenchmarkOutput = 'docs/evidence/gpu-benchmark.json'
)
$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$venvPath = Join-Path $projectRoot 'worker/.venv'
$workerPython = Join-Path $venvPath 'Scripts/python.exe'
$requirementsPath = Join-Path $projectRoot 'worker/requirements.txt'
if ($BuildTensorRT) { $requirementsPath = Join-Path $projectRoot 'worker/requirements-tensorrt.txt' }
$setupExitCode = 1
try {
    if (-not (Test-Path -LiteralPath $requirementsPath -PathType Leaf)) {
        throw 'Pinned worker/requirements.txt is missing.'
    }
    if (-not (Test-Path -LiteralPath $workerPython -PathType Leaf)) {
        if (Test-Path -LiteralPath $venvPath) { throw 'Incomplete worker/.venv exists. Inspect it before choosing a replacement; setup will not delete it.' }
        Write-Host 'Creating project-isolated Python 3.13 environment.'
        if ([System.IO.Path]::GetFileNameWithoutExtension($PythonExecutable) -eq 'py') {
            & $PythonExecutable -3.13 -m venv $venvPath
        }
        else {
            & $PythonExecutable -c "import sys; assert sys.version_info[:2] == (3,13), 'Python 3.13 required'"
            if ($LASTEXITCODE -ne 0) { throw 'Select a Python 3.13 executable.' }
            & $PythonExecutable -m venv $venvPath
        }
        if ($LASTEXITCODE -ne 0) { throw 'Could not create isolated Python 3.13 environment.' }
    }
    & $workerPython -c "import sys; assert sys.version_info[:2] == (3,13), 'Python 3.13 required'"
    if ($LASTEXITCODE -ne 0) { throw 'Existing worker environment has an unsupported Python version.' }
    Push-Location -LiteralPath $projectRoot
    try {
        Write-Host 'Installing pinned packages only into worker/.venv. This is the explicit first-setup step.'
        & $workerPython -m pip install --disable-pip-version-check -r $requirementsPath
        if ($LASTEXITCODE -ne 0) { throw 'Pinned worker package installation failed.' }
        & $workerPython -m worker.runtime.gpu
        if ($LASTEXITCODE -ne 0) { throw 'Actual CUDA preflight failed. CPU inference is not a fallback.' }
        $prepareArgs = @('-m', 'worker.runtime.prepare')
        if ($BuildTensorRT) { $prepareArgs += '--build-tensorrt' }
        & $workerPython @prepareArgs
        if ($LASTEXITCODE -ne 0) { throw 'Cached model preparation failed.' }
        & $workerPython -m pytest worker/tests -q
        if ($LASTEXITCODE -ne 0) { throw 'Worker self-tests failed.' }
        $benchmarkArgs = @('-m', 'worker.runtime.benchmark', '--iterations', $BenchmarkIterations, '--warmup', 5, '--output', $BenchmarkOutput)
        if ($BuildTensorRT) { $benchmarkArgs += @('--runtimes', 'pytorch_cuda', 'onnx_cuda', 'tensorrt') }
        & $workerPython @benchmarkArgs
        if ($LASTEXITCODE -ne 0) { throw 'Real CUDA model benchmark failed.' }
        $examplePath = Join-Path $projectRoot '.env.worker.example'
        $configPath = Join-Path $projectRoot '.env.worker'
        if (-not (Test-Path -LiteralPath $configPath) -and (Test-Path -LiteralPath $examplePath -PathType Leaf)) {
            Copy-Item -LiteralPath $examplePath -Destination $configPath
        }
        Write-Host 'Setup complete. Cached models now include the optional plate artifacts when they are catalogued; start.ps1 never downloads.'
        Write-Host 'Configure .env.worker with the deployed relay URL and matching machine secret; then run .\start.ps1.'
        $setupExitCode = 0
    }
    finally { Pop-Location }
}
catch { Write-Error -Message $_.Exception.Message -ErrorAction Continue }
exit $setupExitCode
