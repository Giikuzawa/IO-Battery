# Protocols

How IO Battery reads battery level from the devices it supports. Everything here was reconstructed from observed traffic and from the client-side code of the manufacturer's public WebHID configurator, for interoperability with hardware the author owns. Nothing is copied from vendor code. Where a detail is a guess rather than an observation, it says so.

All three sources are **read-only**: the app only sends "report battery / device info" requests.

- [Transport](#transport)
- [Compx (mice)](#compx-mice)
- [HFD (keyboards)](#hfd-keyboards)
- [Bluetooth (Windows property)](#bluetooth-windows-property)
- [Device tables](#device-tables)
- [Verification status and unknowns](#verification-status-and-unknowns)

## Transport

Mice and keyboards are read through **WebHID** (`navigator.hid`, built into Chromium/Electron):

- Requests: `device.sendReport(reportId, data)`.
- Replies: the `inputreport` event. `event.data` is the payload **without** the report ID byte; `event.reportId` carries the ID.
- The device is opened only for the duration of an exchange. Each request is retried up to 3 times (500 ms timeout, 150 ms pause); the reply is matched by command and, where applicable, address.

Interfaces are picked from the HID report descriptor, not by index. A single physical device appears as several `HIDDevice` objects, one per top-level collection. Example from a real log:

```
0x3554:0xFB40 «IO Aurora Pro 8K Receiver»
   page 0xFF05 usage 0x0000 in=[16:7]  out=[]      feat=[]
   page 0xFF03 usage 0x0000 in=[2:7]   out=[]      feat=[]
   page 0x000C usage 0x0001 in=[5:2]   out=[]      feat=[]
   page 0xFF02 usage 0x0002 in=[8:16]  out=[8:16]  feat=[]     <- the one we use
   page 0xFF04 usage 0x0002 in=[]      out=[]      feat=[6:7]
```

(`in=[id:size]` lists input reports as report ID and payload size in bytes.)

## Compx (mice)

Used by IO Aurora / Nova and Red Square Kiro mice (vendor IDs `0x3554`, `0x25A7`).

**Interface:** the collection that has both an input and an output report with **ID 8** (vendor page `0xFF02`, usage `2` on the Aurora receiver). Payload size is 16 bytes.

### Frame layout (request and reply)

| Byte | Meaning |
|---|---|
| 0 | command |
| 1 | `0` in requests; status in replies (`0` ok, `1` "command not supported") |
| 2-3 | address (unused for battery, `0`) |
| 4 | data length |
| 5-14 | data |
| 15 | checksum |

`checksum = (0x55 − (reportId + Σ bytes[0..14])) & 0xFF`, with `reportId = 8`. All replies observed so far carry a valid checksum, but the parser does not enforce it (a mismatch in some firmware would otherwise hide a valid reading).

### Commands used

| Command | Code | Request | Reply |
|---|---|---|---|
| ONLINE | `0x03` | `03 00 … 4A` | byte 5 = `1` if the mouse is awake and linked through the receiver |
| BATTERY | `0x04` | `04 00 … 49` | see below |

The ONLINE check is only sent to 2.4G receivers. A sleeping mouse can still return its last cached battery value; the app then marks it as "asleep" and treats the value as stale.

### BATTERY reply

| Byte | Meaning |
|---|---|
| 5 | percent (0-100) |
| 6 | `1` = charging |
| 7-8 | battery voltage in mV, big endian |
| 9 | if `1`, the percent is in byte 10 instead |
| 10 | alternative percent field |

Real exchange (Aurora Pro 8K, 2.4G):

```
→ 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49
← 04 00 00 00 02 5a 00 0f d2 00 00 00 00 00 00 0c
          byte5 = 0x5a = 90 %, byte6 = 0 (not charging), bytes 7-8 = 0x0fd2 = 4050 mV
```

If the device reports `0 %` with a non-zero voltage, the percent is estimated from a generic Li-Po voltage table (approximate; this fallback was never triggered on the author's hardware). `0 %` with no voltage and no charging is shown as "no data", not as an empty battery.

## HFD (keyboards)

Used by IO Type 68 / 84 and related keyboards (vendor IDs `0x0C45`, `0x05AC`, `0x342D`).

**Interface:** a collection on a vendor usage page from `[0xFF68, 0xFF80, 0xFF60, 0xFF00, 0xFF01, 0xFF1B]` that has both an input and an output report. The frame size equals the **output report payload size** of that collection, so it differs between devices:

- 2.4G dongle `0C45:FEFE`: page `0xFF60`, usage `0x61`, report ID `0`, **32 bytes**.
- The same dongle also exposes a 64-byte interface on page `0xFF59`. That page is not in the list above and is not used.

### Frame layout

Request, `frameSize` bytes, sent with the output report ID of the collection (`0` here):

| Byte | Meaning |
|---|---|
| 0 | `0xAA` |
| 1 | command |
| 2 | data length in this packet |
| 3-4 | address, little endian |
| 5 | `0` |
| 6 | `1` on the last packet of a request, else `0` |
| 7 | `0` |
| 8… | data |

Reply: byte 0 = `0x55`, byte 1 = command, bytes 3-4 = address (little endian), bytes 8… = data.

### GET_DEVICE_INFO (`0x10`)

The device-info block is 48 bytes. It is fetched in packets of `frameSize − 8` bytes:

| Frame size | Packets |
|---|---|
| 64 | 1 (address `0`, length 48, last-packet flag set) |
| 32 | 2 (address `0` length 24; address `24` length 24, last-packet flag set) |

Each reply is matched by command `0x10` and the **address** echoed in bytes 3-4. The data parts (bytes 8…) are concatenated into the 48-byte block.

### Info block layout

| Offset | Size | Meaning |
|---|---|---|
| 4 | u16 LE | vendor ID reported by the keyboard itself |
| 6 | u16 LE | product ID reported by the keyboard itself |
| 8 | 2 bytes | firmware version, `((lo & 15) + ((lo >> 4) * 10) + hi * 100) / 100` |
| 16 | u8 | work mode (meaning not decoded) |
| **17** | u8 | **battery level, 0-100** |
| **18** | u8 | **charge status, `1` = charging** |
| 19 | u8 | current profile |

Real exchange (IO Type 68 Pro, 2.4G dongle, frame size 32):

```
→ aa 10 18 00 00 00 00 00 00 00 …            (address 0, length 24)
← 55 10 18 00 00 00 00 00 40 00 00 0c ac 05 4f 02 63 01 ff ff 07 00 02 00 …
                                    └─────┘ └─────┘ └─────┘
                          vendor 0x05AC   product 0x024F   firmware 1.63
→ aa 10 18 18 00 00 01 00 00 00 …            (address 24, length 24, last packet)
← 55 10 18 18 00 00 01 00 …
info: level = 62, charge = 0
```

(The keyboard identifies itself inside the block as `05AC:024F`, while the USB dongle that carries it is `0C45:FEFE`.)

### Battery rules

- `level` outside 0-100: no data.
- `level = 0` and `charge = 0`: no data (the app never draws a fake 0 %).
- `level = 0`, `charge = 1` over USB: charging, level unknown.
- Otherwise: `percent = level`, `charging = (charge == 1)`.

A keyboard that is asleep may not answer (the app shows its last known value) or may return a cached level.

## Bluetooth (Windows property)

Bluetooth devices are not spoken to directly. Windows stores the battery level that a device reports (over the GATT Battery Service or the HFP battery indicator) in a device-node property, and the same value is shown in *Settings → Bluetooth & devices*.

| Property | Key |
|---|---|
| Battery level (0-100) | `DEVPKEY_Bluetooth_Battery` = `{104EA319-6EE2-4701-BD47-8DDBF425BBE5}, 2` |
| Is connected | `{83DA6326-97A6-4088-9453-A1923F573B29}, 15` |
| Container ID (groups nodes of one physical device) | `{8C7ED206-3F8A-4827-B3AB-AE9E1FAEFC6C}, 2` |

One physical device has several nodes (root `BTHLE\DEV_…` or `BTHENUM\DEV_…`, service nodes such as `BTHENUM\{0000111E-…}` for Hands-Free, and child `HID\{…}` nodes of BLE keyboards). The battery property can sit on any of them. The app:

1. enumerates PnP entities (`Win32_PnPEntity`) and reads the battery property for all of them in one batched call;
2. groups nodes by container ID and takes the display name from the root node of the group (the service node's own name is typically "<device> Hands-Free AG");
3. combines the connection state of all nodes in the group.

This runs as a **full scan** (10-20 s) rarely, and as a **quick poll** of the already-found nodes otherwise. The scripts are in `bt-scripts.js` and are executed by the system Windows PowerShell 5.1 (`powershell.exe`). The quick script intentionally avoids `ConvertFrom-Json`, whose handling of arrays differs between PowerShell 5.1 and 7.

The same property can also be read without PowerShell through the Configuration Manager API (`CM_Get_DevNode_PropertyW`); see the README for why that is the planned improvement.

## Device tables

### Compx (mice)

| VID | PID | Link | Notes |
|---|---|---|---|
| 0x3554 | 0xFB40 | 2.4G | IO Aurora Pro 8K receiver (**verified**) |
| 0x3554 | 0xF511, 0xFB09, 0xFB3F, 0xF57D | USB | from the vendor's model table, unverified |
| 0x3554 | 0xF5D5, 0xFB08, 0xFB5A, 0xF57C, 0xF57E | 2.4G | from the vendor's model table, unverified |
| 0x25A7 | any | by name | listed as a Compx vendor ID, unverified |

### HFD (keyboards)

| VID | PID | Link |
|---|---|---|
| 0x0C45 | 0xFEFE | 2.4G dongle, IO Type 68 Pro (**verified**) |
| 0x0C45 | 0x0256, 0x8016, 0x8009, 0x80D6, 0x80CA, 0x80C9, 0x80D9, 0x80D7 | USB, unverified |
| 0x0C45 | 0x80CC, 0x80AC, 0x80AF, 0x80A2 | USB (Red Square), unverified |
| 0x05AC | 0x0256, 0x024F | USB, unverified |

Devices outside the tables are also considered if their VID is in the list above and their product name looks like one of the families (`IO …`, `Type …`, `Typex`, `Alumix`, `RSQ`).

## Verification status and unknowns

| Item | Status |
|---|---|
| Compx ONLINE and BATTERY on an Aurora Pro 8K 2.4G receiver | observed on real hardware; the reply parses cleanly with a valid checksum and 90 % is consistent with the reported 4050 mV. Not cross-checked against another tool at the same moment (a different monitor had shown 45 % on an earlier occasion) |
| HFD GET_DEVICE_INFO on a Type 68 Pro 2.4G dongle (32-byte frames) | observed on real hardware; level drifts slowly over an hour (64 → 63 → 62 %) and is close to the 61 % that Windows reports for the same keyboard over Bluetooth |
| HFD over a 64-byte interface or over USB cable | not tested |
| Charging flags (`byte 6` in Compx, `offset 18` in HFD) | decoded from the vendor's configurator logic, never observed set |
| Work mode, profile and other info-block fields | not decoded or used |
| Reply checksum in Compx | valid in all observed replies, deliberately not enforced |

Contributions and logs from other models are welcome.
