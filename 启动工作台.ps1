param([int]$Port=4177,[string]$DataDir,[string]$WorkDir)
$ErrorActionPreference='Stop'
Set-Location -LiteralPath $PSScriptRoot
if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw '请先安装 Node.js 20 或更高版本：https://nodejs.org'}
if(-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules/playwright/package.json'))){
 & npm.cmd install --no-audit --no-fund
 if($LASTEXITCODE -ne 0){throw '依赖安装失败，请检查网络后重试。'}
}
$guiArgs=@((Join-Path $PSScriptRoot 'server.mjs'),'--port',"$Port")
if($DataDir){$guiArgs+=@('--data-dir',$DataDir)}
if($WorkDir){$guiArgs+=@('--work-dir',$WorkDir)}
& node @guiArgs
exit $LASTEXITCODE
