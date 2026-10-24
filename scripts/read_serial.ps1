param(
    [string]$PortName = "COM3",
    [int]$BaudRate = 115200,
    [int]$DurationSec = 3
)

$port = New-Object System.IO.Ports.SerialPort($PortName, $BaudRate, 'None', 8, 'One')
$port.ReadTimeout = 1000

try {
    $port.Open()
    Write-Host "Opened $PortName at $BaudRate baud. Reading for $DurationSec seconds..."
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt ($DurationSec * 1000)) {
        try {
            $line = $port.ReadLine()
            Write-Host $line
        } catch [System.TimeoutException] {
            # continue waiting
        }
    }
} catch {
    Write-Host "Error accessing ${PortName}: $_"
} finally {
    if ($port.IsOpen) {
        $port.Close()
        Write-Host "Closed $PortName"
    }
}
