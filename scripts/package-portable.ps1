$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot 'release'))
$packageName = '飞书客户素材审核工具-win-x64'
$target = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot $packageName))
$archive = [System.IO.Path]::GetFullPath((Join-Path $releaseRoot ($packageName + '.zip')))

if (-not $target.StartsWith($releaseRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw '绿色版输出目录校验失败。'
}

Push-Location $projectRoot
try {
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Next.js 生产构建失败。' }

  & dotnet publish '.\desktop\FeishuReviewLauncher.csproj' -c Release -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=None `
    -o '.\desktop\publish'
  if ($LASTEXITCODE -ne 0) { throw '桌面启动器构建失败。' }

  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $target, (Join-Path $target 'app'), (Join-Path $target 'runtime') | Out-Null

  Copy-Item -Path '.\.next\standalone\*' -Destination (Join-Path $target 'app') -Recurse -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $target 'app\.next\static') | Out-Null
  Copy-Item -Path '.\.next\static\*' -Destination (Join-Path $target 'app\.next\static') -Recurse -Force
  if (Test-Path -LiteralPath '.\public') {
    Copy-Item -LiteralPath '.\public' -Destination (Join-Path $target 'app\public') -Recurse -Force
  }

  $nodePath = (Get-Command node).Source
  Copy-Item -LiteralPath $nodePath -Destination (Join-Path $target 'runtime\node.exe') -Force
  Copy-Item -LiteralPath '.\desktop\publish\FeishuReviewLauncher.exe' -Destination (Join-Path $target '飞书客户素材审核工具.exe') -Force
  Copy-Item -LiteralPath '.\desktop\使用说明.txt' -Destination (Join-Path $target '使用说明.txt') -Force
  Copy-Item -LiteralPath '.\desktop\THIRD_PARTY_NOTICES.txt' -Destination (Join-Path $target 'THIRD_PARTY_NOTICES.txt') -Force

  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  Compress-Archive -Path (Join-Path $target '*') -DestinationPath $archive -CompressionLevel Optimal
  Write-Output $archive
}
finally {
  Pop-Location
}
