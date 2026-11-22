param(
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$ReadyFile,
  [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = 'Stop'
try { [System.IO.File]::AppendAllText($LogPath, "[$(Get-Date -Format o)] Helper started. Parent=$ParentPid Image=$ImagePath Ready=$ReadyFile`r`n") } catch {}
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Eclipse Launcher'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.ClientSize = New-Object System.Drawing.Size(820, 520)
$form.BackColor = [System.Drawing.Color]::FromArgb(8, 13, 25)
$form.TopMost = $true
$form.ShowInTaskbar = $true

$picture = New-Object System.Windows.Forms.PictureBox
$picture.Location = New-Object System.Drawing.Point(22, 22)
$picture.Size = New-Object System.Drawing.Size(776, 436)
$picture.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
$picture.BackColor = [System.Drawing.Color]::FromArgb(8, 13, 25)
$picture.Image = [System.Drawing.Image]::FromFile($ImagePath)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$radius = 20
$diameter = $radius * 2
$path.AddArc(0, 0, $diameter, $diameter, 180, 90)
$path.AddArc($picture.Width - $diameter, 0, $diameter, $diameter, 270, 90)
$path.AddArc($picture.Width - $diameter, $picture.Height - $diameter, $diameter, $diameter, 0, 90)
$path.AddArc(0, $picture.Height - $diameter, $diameter, $diameter, 90, 90)
$path.CloseFigure()
$picture.Region = [System.Drawing.Region]::new($path)
$form.Controls.Add($picture)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Location = New-Object System.Drawing.Point(22, 476)
$progress.Size = New-Object System.Drawing.Size(776, 16)
$progress.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
$progress.MarqueeAnimationSpeed = 24
$form.Controls.Add($progress)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$state = @{ ParentExited = $false; RelaunchedAt = $null }
$timer.Add_Tick({
  if (-not $state.ParentExited) {
    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if (-not $parent) { $state.ParentExited = $true }
    return
  }
  $running = Get-Process -Name 'Eclipse Launcher' -ErrorAction SilentlyContinue
  if ($running) {
    if (-not $state.RelaunchedAt) { $state.RelaunchedAt = Get-Date }
    elseif (((Get-Date) - $state.RelaunchedAt).TotalSeconds -ge 3) { $form.Close() }
  }
})
$form.Add_Shown({
  [System.IO.File]::WriteAllText($ReadyFile, 'ready')
  $timer.Start()
})
$form.Add_FormClosed({
  $timer.Stop()
  $timer.Dispose()
  $picture.Image.Dispose()
  $path.Dispose()
})
[void]$form.ShowDialog()
} catch {
  try { [System.IO.File]::AppendAllText($LogPath, "[$(Get-Date -Format o)] $($_ | Out-String)`r`n") } catch {}
  exit 1
}
