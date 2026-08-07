# Apply a delivered patch, run the suite, tag, push.
#   .\release.ps1 -Patch v0.2.0.patch -Tag v0.2.0
param(
  [Parameter(Mandatory = $true)][string]$Patch,
  [string]$Tag,
  [switch]$SkipTests
)
git am $Patch
if ($LASTEXITCODE -ne 0) { git am --abort; Write-Error "The patch did not apply — nothing was changed."; exit 1 }
if (-not $SkipTests) {
  npm test
  if ($LASTEXITCODE -ne 0) { Write-Error "Tests failed. The commit is applied locally but NOT pushed."; exit 1 }
}
if ($Tag) { git tag $Tag }
git push origin main --tags
