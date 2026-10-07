param(
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = Join-Path $projectRoot '.venv-ocr-svtrv2\Scripts\python.exe'
$fallbackPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
$logDirectory = Join-Path $projectRoot 'runs\launcher'

if (-not (Test-Path -LiteralPath $python)) {
    $python = $fallbackPython
}
if (-not (Test-Path -LiteralPath $python)) {
    throw 'ETRIS Python environment was not found. Expected .venv-ocr-svtrv2 or .venv.'
}

New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

function Test-Port([int]$Port) {
    try {
        $connection = [System.Net.Sockets.TcpClient]::new()
        $task = $connection.ConnectAsync('127.0.0.1', $Port)
        $connected = $task.Wait(300) -and $connection.Connected
        $connection.Dispose()
        return $connected
    } catch {
        return $false
    }
}

function Start-EtrisProcess {
    param(
        [string]$Name,
        [int]$Port,
        [string[]]$Arguments,
        [hashtable]$Environment = @{}
    )
    if (Test-Port $Port) {
        Write-Host "[READY] $Name is already running on port $Port" -ForegroundColor Green
        return
    }
    foreach ($entry in $Environment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
    }
    $stdout = Join-Path $logDirectory "$Name.out.log"
    $stderr = Join-Path $logDirectory "$Name.err.log"
    $process = Start-Process -FilePath $python -ArgumentList $Arguments -WorkingDirectory $projectRoot `
        -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
    Write-Host "[START] $Name (PID $($process.Id), port $Port)" -ForegroundColor Cyan
}

$commonEnvironment = @{
    PYTHONPATH = $projectRoot
    YOLO_CONFIG_DIR = (Join-Path $projectRoot '.ultralytics-config')
}

$mainEnvironment = $commonEnvironment.Clone()
$mainEnvironment.ETRIS_ANPR_VIDEO = Join-Path $projectRoot 'traffic_2.mp4'
$mainEnvironment.ETRIS_ANPR_CAMERA_ID = 'CAM-DEMO-01'
Start-EtrisProcess -Name 'backend-8000' -Port 8000 `
    -Arguments @('-m', 'uvicorn', 'backend.api.app:app', '--host', '127.0.0.1', '--port', '8000') `
    -Environment $mainEnvironment

$anubhavEnvironment = $commonEnvironment.Clone()
$anubhavEnvironment.ETRIS_ANPR_VIDEO = Join-Path $projectRoot 'anubhav_vid.mp4'
$anubhavEnvironment.ETRIS_ANPR_CAMERA_ID = 'CAM-ANUBHAV'
Start-EtrisProcess -Name 'anpr-8001' -Port 8001 `
    -Arguments @('-m', 'uvicorn', 'backend.api.app:app', '--host', '127.0.0.1', '--port', '8001') `
    -Environment $anubhavEnvironment

Start-EtrisProcess -Name 'frontend-5173' -Port 5173 `
    -Arguments @('-m', 'http.server', '5173', '--directory', 'frontend')

$requiredPorts = @(8000, 8001, 5173)
foreach ($attempt in 1..30) {
    if (($requiredPorts | Where-Object { -not (Test-Port $_) }).Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
}

$missing = @($requiredPorts | Where-Object { -not (Test-Port $_) })
if ($missing.Count) {
    Write-Host "[ERROR] Services failed on ports: $($missing -join ', '). Check $logDirectory" -ForegroundColor Red
    exit 1
}

Write-Host '[READY] ETRIS is fully running at http://127.0.0.1:5173' -ForegroundColor Green
Write-Host "Logs: $logDirectory"
if (-not $NoBrowser) {
    Start-Process 'http://127.0.0.1:5173'
}
