Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile("C:\Users\arvis\.gemini\antigravity-ide\brain\2da45c41-ef82-4067-a90e-f03d86a6186e\.tempmediaStorage\left_tab_tapped.png")

$minX = 9999; $maxX = 0; $minY = 9999; $maxY = 0

for ($y = 1550; $y -lt 1900; $y += 3) {
    for ($x = 400; $x -lt 900; $x += 3) {
        $c = $bmp.GetPixel($x, $y)
        if ($c.G -gt 120 -and $c.G -gt ($c.R * 1.3) -and $c.G -gt ($c.B * 1.3)) {
            if ($x -lt $minX) { $minX = $x }
            if ($x -gt $maxX) { $maxX = $x }
            if ($y -lt $minY) { $minY = $y }
            if ($y -gt $maxY) { $maxY = $y }
        }
    }
}
$bmp.Dispose()
Write-Output "Apply Button exact bounds: X=[$minX, $maxX], Y=[$minY, $maxY]"
Write-Output "Apply Button center: X=$([int](($minX+$maxX)/2)), Y=$([int](($minY+$maxY)/2))"
