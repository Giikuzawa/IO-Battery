# Имитация Windows-командлетов для проверки логики скриптов на Linux
$A = [guid]'11111111-1111-1111-1111-111111111111'
$B = [guid]'22222222-2222-2222-2222-222222222222'
$C = [guid]'33333333-3333-3333-3333-333333333333'
$D = [guid]'44444444-4444-4444-4444-444444444444'
$Z = [guid]'00000000-0000-0000-ffff-ffffffffffff'
$kbRoot  = 'BTHLE\DEV_C8D6A2E3B1F4\7&22E41FE3&0&C8D6A2E3B1F4'
$kbHid   = 'HID\{00001812-0000-1000-8000-00805F9B34FB}_DEV_VID&02045E_PID&0B13_REV&0903_C8D6A2E3B1F4\8&1234'
$hpRoot  = 'BTHENUM\DEV_AABBCCDDEEFF\7&3F10E0E&0&BLUETOOTHDEVICE_AABBCCDDEEFF'
$hpHfp   = 'BTHENUM\{0000111E-0000-1000-8000-00805F9B34FB}_VID&0001065A_PID&0017\7&3F10E0E&0&AABBCCDDEEFF_C00000000'
$padHid  = 'HID\{00001124-0000-1000-8000-00805F9B34FB}_VID&0000054C_PID&0CE6\9&AAAA&0&0000'
$usbRecv = 'USB\VID_3554&PID_FB40\5&1'
$sys     = 'ROOT\SYSTEM\0001'
$global:MockNames = @{ $kbRoot='IO Type68 Pro BT2'; $kbHid='Bluetooth Low Energy GATT compliant HID device'; $hpRoot='MONITOR III A.N.C.'
  $hpHfp='MONITOR III A.N.C. Hands-Free AG'; $padHid='Wireless Controller'; $usbRecv='IO receiver'; $sys='Programmable interrupt controller' }
$global:MockBat  = @{ $kbRoot=61; $kbHid=61; $hpHfp=98; $padHid=77 }
$global:MockConn = @{ $kbRoot=$false; $hpRoot=$true }
$global:MockCont = @{ $kbRoot=$A; $kbHid=$A; $hpRoot=$B; $hpHfp=$B; $padHid=$C; $usbRecv=$D; $sys=$Z }

function Get-CimInstance { param([string]$ClassName)
  foreach ($k in $global:MockNames.Keys) { [pscustomobject]@{ Name = $global:MockNames[$k]; PNPDeviceID = $k } } }

function Get-PnpDeviceProperty { param([string[]]$InstanceId, [string]$KeyName)
  foreach ($i in $InstanceId) {
    $d = $null
    if ($KeyName -like '*104EA319*') { $d = $global:MockBat[$i] }
    elseif ($KeyName -like '*83DA6326*') { $d = $global:MockConn[$i] }
    elseif ($KeyName -like '*8C7ED206*') { $d = $global:MockCont[$i] }
    [pscustomobject]@{ InstanceId = $i; KeyName = $KeyName; Data = $d }
  } }
