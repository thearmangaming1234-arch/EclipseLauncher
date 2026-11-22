Add-Type -AssemblyName System.Drawing

$buildDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$logoPath = Join-Path (Split-Path -Parent $buildDirectory) 'assets/EclipseLogo+Name397x165.png'

function New-InstallerBitmap([int]$width, [int]$height, [string]$outputPath, [bool]$isSidebar) {
  $bitmap = [System.Drawing.Bitmap]::new($width, $height, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $background = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Rectangle]::new(0, 0, $width, $height),
    [System.Drawing.Color]::FromArgb(8, 12, 25),
    [System.Drawing.Color]::FromArgb(30, 18, 65),
    [System.Drawing.Drawing2D.LinearGradientMode]::Vertical
  )
  $graphics.FillRectangle($background, 0, 0, $width, $height)

  if ($isSidebar) {
    foreach ($star in @(@(18, 105, 2), @(145, 82, 2), @(30, 224, 1), @(137, 255, 2), @(20, 282, 1), @(122, 190, 1))) {
      $starBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(190, 216, 198, 255))
      $graphics.FillEllipse($starBrush, $star[0], $star[1], $star[2], $star[2])
      $starBrush.Dispose()
    }

    $ringGlow = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(45, 170, 82, 255), 15)
    $ring = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(230, 182, 124, 255), 3)
    $graphics.DrawArc($ringGlow, 36, 116, 92, 92, 35, 290)
    $graphics.DrawArc($ring, 38, 118, 88, 88, 35, 290)

    $logo = [System.Drawing.Image]::FromFile($logoPath)
    $graphics.DrawImage($logo, [System.Drawing.Rectangle]::new(10, 18, 144, 60))
    $logo.Dispose()

    $titleFont = [System.Drawing.Font]::new('Segoe UI Semibold', 10, [System.Drawing.FontStyle]::Bold)
    $copyFont = [System.Drawing.Font]::new('Segoe UI', 8, [System.Drawing.FontStyle]::Regular)
    $white = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(244, 242, 255))
    $lavender = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(185, 172, 220))
    $graphics.DrawString('YOUR NEXT WORLD', $titleFont, $white, 22, 229)
    $graphics.DrawString('Play. Explore. Build.', $copyFont, $lavender, 22, 249)
    $graphics.DrawString('ECLIPSE LAUNCHER', $copyFont, $lavender, 22, 287)
    $titleFont.Dispose(); $copyFont.Dispose(); $white.Dispose(); $lavender.Dispose()
    $ringGlow.Dispose(); $ring.Dispose()
  } else {
    $logo = [System.Drawing.Image]::FromFile($logoPath)
    $graphics.DrawImage($logo, [System.Drawing.Rectangle]::new(4, 1, 144, 55))
    $logo.Dispose()
  }

  $background.Dispose()
  $graphics.Dispose()
  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $bitmap.Dispose()
}

New-InstallerBitmap 164 314 (Join-Path $buildDirectory 'installerSidebar.bmp') $true
New-InstallerBitmap 150 57 (Join-Path $buildDirectory 'installerHeader.bmp') $false
