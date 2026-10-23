Add-Type -AssemblyName System.Drawing
$assetDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../desktop/assets'))
[System.IO.Directory]::CreateDirectory($assetDir) | Out-Null
$bitmap = New-Object System.Drawing.Bitmap 256,256
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$green = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#07ad69'))
$white = [System.Drawing.Brushes]::White
$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$shape.AddArc(4,4,64,64,180,90)
$shape.AddArc(188,4,64,64,270,90)
$shape.AddArc(188,188,64,64,0,90)
$shape.AddArc(4,188,64,64,90,90)
$shape.CloseFigure()
$graphics.FillPath($green,$shape)
$graphics.FillEllipse($white,47,55,162,132)
$points = [System.Drawing.Point[]]@((New-Object System.Drawing.Point 67,155),(New-Object System.Drawing.Point 62,204),(New-Object System.Drawing.Point 110,177))
$graphics.FillPolygon($white,$points)
foreach ($x in @(83,120,157)) { $graphics.FillEllipse($green,$x,112,17,17) }
$memory = New-Object System.IO.MemoryStream
$bitmap.Save($memory,[System.Drawing.Imaging.ImageFormat]::Png)
$png = $memory.ToArray()
[System.IO.File]::WriteAllBytes((Join-Path $assetDir 'icon.png'),$png)
$stream = [System.IO.File]::Create((Join-Path $assetDir 'icon.ico'))
$writer = New-Object System.IO.BinaryWriter $stream
$writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
$writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([byte]0)
$writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$png.Length); $writer.Write([uint32]22)
$writer.Write($png)
$writer.Dispose(); $memory.Dispose(); $graphics.Dispose(); $bitmap.Dispose(); $green.Dispose(); $shape.Dispose()
