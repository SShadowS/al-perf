#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build and publish the al-perf container to Docker Hub (sshadows).
.PARAMETER Tag
    Image tag. Defaults to the version from package.json.
.PARAMETER Latest
    Also tag and push as "latest". On by default.
.PARAMETER NoPush
    Build only, skip pushing to Docker Hub.
#>
param(
    [string]$Tag,
    [switch]$Latest = $true,
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'

$image = "sshadows/al-perf"

if (-not $Tag) {
    $Tag = (Get-Content ./package.json | ConvertFrom-Json).version
}

Write-Host "Building ${image}:${Tag} ..." -ForegroundColor Cyan
docker build -t "${image}:${Tag}" .
if ($LASTEXITCODE -ne 0) { throw "Docker build failed" }

if ($Latest) {
    docker tag "${image}:${Tag}" "${image}:latest"
}

if (-not $NoPush) {
    Write-Host "Pushing ${image}:${Tag} ..." -ForegroundColor Cyan
    docker push "${image}:${Tag}"
    if ($LASTEXITCODE -ne 0) { throw "Docker push failed" }

    if ($Latest) {
        Write-Host "Pushing ${image}:latest ..." -ForegroundColor Cyan
        docker push "${image}:latest"
        if ($LASTEXITCODE -ne 0) { throw "Docker push failed" }
    }

    Write-Host "Published ${image}:${Tag}" -ForegroundColor Green
} else {
    Write-Host "Built ${image}:${Tag} (push skipped)" -ForegroundColor Yellow
}
