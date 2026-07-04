5434,5435,5436,5437,5438 | ForEach-Object {
  $p = $_
  $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if (-not $c) { Write-Host "FREE $p" } else { Write-Host "BUSY $p" }
}
