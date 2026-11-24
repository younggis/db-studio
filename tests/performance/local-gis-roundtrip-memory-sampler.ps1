[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$EvidencePath,
  [string]$ContainerName = "db-studio-postgis-test",
  [int]$ProcessSampleIntervalMs = 250,
  [int]$ContainerSampleIntervalMs = 5000
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$batchScript = Join-Path $repoRoot "tests/integration/local-gis-roundtrip-batch.mjs"
$batchReportPath = $env:DBSTUDIO_LOCAL_GIS_ROUNDTRIP_REPORT
if (-not $batchReportPath) {
  throw "Set DBSTUDIO_LOCAL_GIS_ROUNDTRIP_REPORT to the batch JSON report path."
}
if ($ProcessSampleIntervalMs -lt 50 -or $ContainerSampleIntervalMs -lt 1000) {
  throw "Sampling intervals are too short. Use at least 50 ms for processes and 1000 ms for the container."
}

$batchReportPath = [IO.Path]::GetFullPath((Join-Path $repoRoot $batchReportPath))
$evidencePath = [IO.Path]::GetFullPath((Join-Path $repoRoot $EvidencePath))
$logDirectory = Join-Path $repoRoot ".cache"
[IO.Directory]::CreateDirectory($logDirectory) | Out-Null
$stdoutPath = Join-Path $logDirectory "local-gis-roundtrip-memory-sampler.stdout.log"
$stderrPath = Join-Path $logDirectory "local-gis-roundtrip-memory-sampler.stderr.log"
$nodePath = (Get-Command node -ErrorAction Stop).Source

function Convert-MemoryTextToBytes([string]$value) {
  $match = [regex]::Match($value, "(?i)(?<amount>\d+(?:\.\d+)?)\s*(?<unit>KiB|MiB|GiB|KB|MB|GB|B)")
  if (-not $match.Success) { return $null }
  $amount = [double]::Parse($match.Groups["amount"].Value, [Globalization.CultureInfo]::InvariantCulture)
  $unit = $match.Groups["unit"].Value.ToUpperInvariant()
  $factor = switch ($unit) {
    "KIB" { 1024 }
    "MIB" { 1MB }
    "GIB" { 1GB }
    "KB" { 1000 }
    "MB" { 1000 * 1000 }
    "GB" { 1000 * 1000 * 1000 }
    "B" { 1 }
  }
  return [long][math]::Round($amount * $factor)
}

$baselinePids = [Collections.Generic.HashSet[int]]::new()
Get-Process | ForEach-Object { [void]$baselinePids.Add($_.Id) }
$trackedPids = [Collections.Generic.HashSet[int]]::new()
$startedAt = [DateTimeOffset]::UtcNow
$timer = [Diagnostics.Stopwatch]::StartNew()
$processSampleCount = 0
$containerSampleCount = 0
$peakCombinedWorkingSetBytes = 0L
$peakNodeWorkingSetBytes = 0L
$peakGdalWorkingSetBytes = 0L
$peakContainerWorkingSetBytes = $null
$lastContainerSample = [timespan]::FromSeconds(-10)

$process = Start-Process -FilePath $nodePath `
  -ArgumentList @($batchScript) `
  -WorkingDirectory $repoRoot `
  -PassThru `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath

try {
  while ($true) {
    $process.Refresh()
    if ($process.HasExited) { break }

    $nodeWorkingSetBytes = 0L
    $gdalWorkingSetBytes = 0L
    foreach ($sampledProcess in Get-Process -ErrorAction SilentlyContinue) {
      if ($baselinePids.Contains($sampledProcess.Id)) { continue }
      if ($sampledProcess.ProcessName -notmatch "^(node|ogr2ogr|ogrinfo|gdal[a-z0-9_]*)$") { continue }
      [void]$trackedPids.Add($sampledProcess.Id)
      if ($sampledProcess.ProcessName -eq "node") {
        $nodeWorkingSetBytes += $sampledProcess.WorkingSet64
      } else {
        $gdalWorkingSetBytes += $sampledProcess.WorkingSet64
      }
    }
    $processSampleCount += 1
    $combinedWorkingSetBytes = $nodeWorkingSetBytes + $gdalWorkingSetBytes
    $peakCombinedWorkingSetBytes = [math]::Max($peakCombinedWorkingSetBytes, $combinedWorkingSetBytes)
    $peakNodeWorkingSetBytes = [math]::Max($peakNodeWorkingSetBytes, $nodeWorkingSetBytes)
    $peakGdalWorkingSetBytes = [math]::Max($peakGdalWorkingSetBytes, $gdalWorkingSetBytes)

    if (($timer.Elapsed - $lastContainerSample).TotalMilliseconds -ge $ContainerSampleIntervalMs) {
      $containerOutput = & docker stats --no-stream --format "{{.MemUsage}}" $ContainerName 2>$null
      $containerBytes = Convert-MemoryTextToBytes ([string]$containerOutput)
      if ($null -ne $containerBytes) {
        $containerSampleCount += 1
        if ($null -eq $peakContainerWorkingSetBytes -or $containerBytes -gt $peakContainerWorkingSetBytes) {
          $peakContainerWorkingSetBytes = $containerBytes
        }
      }
      $lastContainerSample = $timer.Elapsed
    }

    Start-Sleep -Milliseconds $ProcessSampleIntervalMs
  }
  $process.WaitForExit()
} finally {
  $timer.Stop()
}

$batchExitCode = $process.ExitCode
$batchReport = $null
$batchReportWrittenAtUtc = $null
$batchReportWriteElapsedSeconds = $null
if (Test-Path -LiteralPath $batchReportPath) {
  $batchReportFile = Get-Item -LiteralPath $batchReportPath
  $batchReportWrittenAtUtc = [DateTimeOffset]::new($batchReportFile.LastWriteTimeUtc).ToString("o")
  $batchReportWriteElapsedSeconds = [math]::Round(($batchReportFile.LastWriteTimeUtc - $startedAt.UtcDateTime).TotalSeconds, 3)
  $batchReport = Get-Content -LiteralPath $batchReportPath -Raw | ConvertFrom-Json
}
$evidence = [ordered]@{
  date = $startedAt.ToString("yyyy-MM-dd")
  feature = "Concurrent local GIS PostGIS roundtrip resource sample"
  startedAtUtc = $startedAt.ToString("o")
  elapsedSeconds = [math]::Round($timer.Elapsed.TotalSeconds, 3)
  batchReportWrittenAtUtc = $batchReportWrittenAtUtc
  batchReportWriteElapsedSeconds = $batchReportWriteElapsedSeconds
  processSampling = [ordered]@{
    intervalMs = $ProcessSampleIntervalMs
    sampleCount = $processSampleCount
    trackedProcessCount = $trackedPids.Count
    processClasses = @("node", "ogr2ogr", "ogrinfo", "gdal*")
    peakCombinedWorkingSetBytes = $peakCombinedWorkingSetBytes
    peakNodeWorkingSetBytes = $peakNodeWorkingSetBytes
    peakGdalWorkingSetBytes = $peakGdalWorkingSetBytes
  }
  postgisSampling = [ordered]@{
    container = $ContainerName
    intervalMs = $ContainerSampleIntervalMs
    sampleCount = $containerSampleCount
    peakMemoryBytes = $peakContainerWorkingSetBytes
  }
  batchExitCode = $batchExitCode
  batchReportPath = [IO.Path]::GetRelativePath($repoRoot, $batchReportPath).Replace("\", "/")
  roundtripSummary = if ($batchReport) {
    [ordered]@{
      concurrency = $batchReport.roundtripConcurrency
      eligibleLayers = $batchReport.eligibleLayerCount
      passedLayers = $batchReport.passedLayerCount
      featureCounts = @($batchReport.successfulLayers | ForEach-Object { $_.featureCount })
      geometryMatches = @($batchReport.successfulLayers | ForEach-Object { $_.geometryVerification.matchedFeatures })
      textValuesChecked = @($batchReport.successfulLayers | ForEach-Object { $_.textPreviewVerification.checkedTextValueCount })
      failureCount = $batchReport.failureCount
      skipped = $batchReport.skipped
      postgisTemporaryTablesCleaned = $batchReport.postgisTemporaryTablesCleaned
      exportDirectoryCleaned = $batchReport.exportDirectoryCleaned
      externalDataSent = $batchReport.externalDataSent
    }
  } else { $null }
  logs = [ordered]@{
    stdoutPath = [IO.Path]::GetRelativePath($repoRoot, $stdoutPath).Replace("\", "/")
    stderrPath = [IO.Path]::GetRelativePath($repoRoot, $stderrPath).Replace("\", "/")
  }
}

[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($evidencePath)) | Out-Null
$json = $evidence | ConvertTo-Json -Depth 12
[IO.File]::WriteAllText($evidencePath, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Write-Output ($evidence | ConvertTo-Json -Depth 8)

if ($batchExitCode -ne 0 -or -not $batchReport -or $batchReport.failureCount -ne 0) {
  throw "The GIS roundtrip batch failed; inspect the sanitized evidence and sampler logs."
}
