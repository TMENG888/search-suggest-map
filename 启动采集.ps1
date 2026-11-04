param([string]$Seed,[ValidateSet('douyin','xiaohongshu','both')][string]$Platform='douyin',[int]$Depth=3,[int]$MaxQueries=0,[string]$Resume,[switch]$Login)
$ErrorActionPreference='Stop'
$scriptFile=Join-Path $PSScriptRoot 'collect.mjs'
if($Login){ & node $scriptFile login --platform $Platform }
elseif($Resume){ & node $scriptFile crawl --resume $Resume --max-queries $MaxQueries }
elseif($Seed){ & node $scriptFile crawl --seed $Seed --platform $Platform --depth $Depth --max-queries $MaxQueries }
else { & node $scriptFile }
exit $LASTEXITCODE
