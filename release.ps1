# Apply a delivered patch, run the suite, tag, push.
#   .\release.ps1 -Patch api-v0.2.1.patch -Tag v0.2.1
#
# ASCII only, on purpose: Windows PowerShell 5.1 reads BOM-less files in the
# system codepage, where UTF-8 punctuation decays into bytes it treats as
# QUOTES - an em dash in a string literal parsed as the string's terminator.
param(
  [Parameter(Mandatory = $true)][string]$Patch,
  [string]$Tag,
  [switch]$SkipTests
)
git am $Patch
if ($LASTEXITCODE -ne 0) {
  git am --abort
  Write-Error "The patch did not apply - nothing was changed."
  exit 1
}
if (-not $SkipTests) {
  npm test
  if ($LASTEXITCODE -ne 0) {
    Write-Error "Tests failed. The commit is applied locally but NOT pushed."
    exit 1
  }
}
if ($Tag) { git tag $Tag }
git push origin main --tags
