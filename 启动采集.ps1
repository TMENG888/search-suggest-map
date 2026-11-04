param([string]$Seed,[ValidateSet('douyin','xiaohongshu','both')][string]$Platform='douyin',[int]$Depth=3,[string]$Resume,[switch]$Login)
$ErrorActionPreference='Stop'
$scriptFile=Join-Path $PSScriptRoot 'collect.mjs'
if($Login){ & node $scriptFile login --platform $Platform }
elseif($Resume){ & node $scriptFile crawl --resume $Resume }
elseif($Seed){ & node $scriptFile crawl --seed $Seed --platform $Platform --depth $Depth }
else { & node $scriptFile }
exit $LASTEXITCODE
