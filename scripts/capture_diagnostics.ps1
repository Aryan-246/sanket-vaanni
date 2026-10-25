# SANKET VAANNI — Left Glove Simultaneous Serial + BLE Capture
param(
    [string]$ComPort = "COM10",
    [int]$BaudRate = 115200,
    [int]$LineCount = 12
)

Write-Host "=== STARTING SIMULTANEOUS CAPTURE: $ComPort & Android BLE Logcat ==="
$port = New-Object System.IO.Ports.SerialPort($ComPort, $BaudRate, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$port.DtrEnable = $false
$port.RtsEnable = $false
$port.ReadTimeout = 2000

$adbPath = "C:\Users\acer\AppData\Local\Android\Sdk\platform-tools\adb.exe"

try {
    $port.Open()
    Write-Host "Opened $ComPort without DTR/RTS assertion. Capturing $LineCount lines..."

    $serialLines = [System.Collections.Generic.List[string]]::new()
    for ($i = 0; $i -lt $LineCount; $i++) {
        try {
            $raw = $port.ReadLine()
            $ts = [DateTime]::Now.ToString("HH:mm:ss.fff")
            $serialLines.Add("[$ts] SERIAL: $raw")
        } catch [System.TimeoutException] {
            Write-Host "Serial read timeout waiting for line $i"
        }
    }

    Write-Host "`n--- CAPTURED USB SERIAL FRAMES ($ComPort) ---"
    foreach ($line in $serialLines) {
        Write-Host $line
    }

} catch {
    Write-Host "Serial Error: $_"
} finally {
    if ($port.IsOpen) {
        $port.Close()
        Write-Host "Closed $ComPort safely."
    }
}

Write-Host "`n--- CAPTURED PHONE BLE FRAMES (Logcat) ---"
& $adbPath logcat -d -t 25 -s ReactNativeJS | Select-String "left"
