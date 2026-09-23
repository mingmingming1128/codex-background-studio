param([switch]$Startup, [switch]$ValidateOnly)

if ($ValidateOnly) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$url = 'http://127.0.0.1:47831'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$runName = 'CodexBackgroundStudio'
$launcher = Join-Path $root 'background.vbs'
$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\CodexBackgroundStudioTray', [ref]$createdNew)
if (-not $createdNew) {
  if (-not $Startup) { Start-Process $url }
  exit
}

function Invoke-StudioApi([string]$path) {
  try { return Invoke-RestMethod -Method Post -Uri "$url$path" -TimeoutSec 15 }
  catch { return $null }
}

function Test-Studio {
  try { return Invoke-RestMethod -Uri "$url/api/status" -TimeoutSec 1 }
  catch { return $null }
}

$ownedServer = $null
if (-not (Test-Studio)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    [System.Windows.Forms.MessageBox]::Show('需要先安装 Node.js 22 或更高版本。', 'Codex Background Studio') | Out-Null
    exit
  }
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $node
  $startInfo.Arguments = 'src\server.js'
  $startInfo.WorkingDirectory = $root
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  $startInfo.EnvironmentVariables['CODEX_BG_NO_BROWSER'] = '1'
  $ownedServer = [System.Diagnostics.Process]::Start($startInfo)
  for ($i = 0; $i -lt 40 -and -not (Test-Studio); $i++) { Start-Sleep -Milliseconds 150 }
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = 'Codex Background Studio'
$notify.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add('打开控制面板')
$pauseItem = $menu.Items.Add('暂停背景')
$restoreItem = $menu.Items.Add('恢复原始界面')
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$startupItem = $menu.Items.Add('开机自动运行')
$startupItem.CheckOnClick = $true
$existingStartup = Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
if (-not $Startup -and $null -eq $existingStartup) {
  $command = "wscript.exe `"$launcher`""
  New-Item -Path $runKey -Force | Out-Null
  Set-ItemProperty -Path $runKey -Name $runName -Value $command
}
$startupItem.Checked = (Get-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue) -ne $null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$exitItem = $menu.Items.Add('退出')
$notify.ContextMenuStrip = $menu

$openAction = { Start-Process $url }
$openItem.add_Click($openAction)
$notify.add_DoubleClick($openAction)
$pauseItem.add_Click({
  $status = Test-Studio
  if ($status -and $status.enabled) { Invoke-StudioApi '/api/pause' | Out-Null }
  else { Invoke-StudioApi '/api/resume' | Out-Null }
})
$restoreItem.add_Click({ Invoke-StudioApi '/api/restore' | Out-Null })
$startupItem.add_Click({
  if ($startupItem.Checked) {
    $command = "wscript.exe `"$launcher`""
    New-Item -Path $runKey -Force | Out-Null
    Set-ItemProperty -Path $runKey -Name $runName -Value $command
  } else {
    Remove-ItemProperty -Path $runKey -Name $runName -ErrorAction SilentlyContinue
  }
})
$exitItem.add_Click({
  Invoke-StudioApi '/api/restore' | Out-Null
  $notify.Visible = $false
  if ($ownedServer -and -not $ownedServer.HasExited) { $ownedServer.Kill() }
  [System.Windows.Forms.Application]::Exit()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  $status = Test-Studio
  $pauseItem.Text = if ($status -and $status.enabled) { '暂停背景' } else { '继续背景' }
  $notify.Text = if ($status -and $status.enabled) { 'Codex Background Studio · 背景已启用' } else { 'Codex Background Studio · 已暂停' }
})
$timer.Start()

if (-not $Startup) { Start-Process $url }
[System.Windows.Forms.Application]::Run()

$timer.Stop()
$notify.Dispose()
$mutex.ReleaseMutex()
$mutex.Dispose()
