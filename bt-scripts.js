'use strict';
/*
 * Заряд Bluetooth-устройств, который Windows уже знает сама (тот же, что в «Параметры → Bluetooth и устройства»).
 * Источник: свойство DEVPKEY_Bluetooth_Battery {104EA319-6EE2-4701-BD47-8DDBF425BBE5},2 на узлах устройства.
 *
 * Два скрипта:
 *  FULL  — полный обзор всех узлов PnP: находит всё, что сообщает заряд, группирует узлы по «контейнеру»
 *          (физическое устройство) и берёт понятное имя у корневого узла BTHLE/BTHENUM. Тяжёлый, зовётся редко.
 *  QUICK — читает только найденные узлы (на вход приходит JSON), занимает доли секунды.
 */

const PREAMBLE = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$bat = '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2'
$con = '{83DA6326-97A6-4088-9453-A1923F573B29} 15'
$cid = '{8C7ED206-3F8A-4827-B3AB-AE9E1FAEFC6C} 2'
function Get-Conn($ids) {
  $cs = @(Get-PnpDeviceProperty -InstanceId $ids -KeyName $con | Where-Object { $null -ne $_.Data })
  if ($cs.Count -eq 0) { return $null }
  return [bool](@($cs | Where-Object { $_.Data -eq $true }).Count -gt 0)
}
`;

const FULL = `${PREAMBLE}
$all = @(Get-CimInstance Win32_PnPEntity)
$byId = @{}
foreach ($x in $all) { if ($x.PNPDeviceID) { $byId[$x.PNPDeviceID] = $x } }
$ids = @($byId.Keys)
$out = @()
if ($ids.Count -gt 0) {
  $bp = @(Get-PnpDeviceProperty -InstanceId $ids -KeyName $bat | Where-Object { $null -ne $_.Data })
  $cont = @{}
  foreach ($p in @(Get-PnpDeviceProperty -InstanceId $ids -KeyName $cid)) {
    if ($null -ne $p.Data) { $cont[$p.InstanceId] = "$($p.Data)".ToLower() }
  }
  $byCont = @{}
  foreach ($k in $cont.Keys) {
    $c = $cont[$k]
    if (-not $byCont.ContainsKey($c)) { $byCont[$c] = New-Object System.Collections.ArrayList }
    [void]$byCont[$c].Add($k)
  }
  $zero = '00000000-0000-0000-ffff-ffffffffffff'
  foreach ($p in $bp) {
    $id = $p.InstanceId
    $pct = [int]$p.Data
    if ($pct -lt 0 -or $pct -gt 100) { continue }
    $c = $cont[$id]
    $sib = @($id)
    if ($c -and $c -ne $zero -and $byCont.ContainsKey($c)) { $sib = @($byCont[$c]) }
    $name = $null
    foreach ($s in $sib) {
      if ($s -match '^(BTHLE|BTHENUM)\\\\DEV_' -and $byId[$s].Name) { $name = $byId[$s].Name; break }
    }
    if (-not $name) { $name = $byId[$id].Name }
    $out += [pscustomobject]@{ name = $name; id = $id; pct = $pct; connected = (Get-Conn $sib); ids = $sib }
  }
}
ConvertTo-Json -Compress -Depth 4 -InputObject @($out)
exit 0
`;

// Вместо __ENTRIES_B64__ подставляется base64 текста: по строке на устройство,
// поля через табуляцию: «id узла батареи <TAB> id узла 1 <TAB> id узла 2 …».
// Без ConvertFrom-Json: в Windows PowerShell 5.1 он отдаёт массив одним объектом, и разбор ломается.
const QUICK = `${PREAMBLE}
$text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__ENTRIES_B64__'))
$out = @()
foreach ($line in ($text -split [char]10)) {
  $line = $line.TrimEnd([char]13)
  if (-not $line.Trim()) { continue }
  $parts = @($line -split [char]9)
  $id = $parts[0]
  $ids = @($id)
  if ($parts.Count -gt 1) { $ids = @($parts[1..($parts.Count - 1)]) }
  $b = (Get-PnpDeviceProperty -InstanceId $id -KeyName $bat).Data
  if ($null -eq $b) { continue }
  $pct = [int]$b
  if ($pct -lt 0 -or $pct -gt 100) { continue }
  $out += [pscustomobject]@{ id = $id; pct = $pct; connected = (Get-Conn $ids) }
}
ConvertTo-Json -Compress -Depth 3 -InputObject @($out)
exit 0
`;

module.exports = { FULL, QUICK, PREAMBLE };
