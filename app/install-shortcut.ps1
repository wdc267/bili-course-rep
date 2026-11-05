# 创建/删除「B站课代表」快捷方式（桌面 / 开机启动）
param(
  [switch]$Startup,
  [switch]$RemoveStartup,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$desktop = [Environment]::GetFolderPath('Desktop')
$startupDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$desktopLnk = Join-Path $desktop 'B站课代表.lnk'
$startupLnk = Join-Path $startupDir 'B站课代表.lnk'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
$launch = Join-Path $appDir 'launch.vbs'
$icon = Join-Path $appDir 'icon.ico'

function New-CourseNoteLink([string]$path, [string]$extraArgs) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($path)
  $s.TargetPath = $wscript
  $s.Arguments = '"' + $launch + '"' + $extraArgs
  $s.WorkingDirectory = $appDir
  if (Test-Path $icon) { $s.IconLocation = $icon }
  $s.Description = 'B站课代表 · B站课程实时总结'
  $s.Save()
}

if ($RemoveStartup) {
  if (Test-Path $startupLnk) { Remove-Item -LiteralPath $startupLnk -Force }
  Write-Output '已移除开机自启快捷方式'
  exit 0
}
if ($Remove) {
  if (Test-Path $desktopLnk) { Remove-Item -LiteralPath $desktopLnk -Force }
  Write-Output '已移除桌面快捷方式'
  exit 0
}
if ($Startup) {
  if (-not (Test-Path $startupDir)) { New-Item -ItemType Directory -Path $startupDir -Force | Out-Null }
  New-CourseNoteLink $startupLnk ' silent'
  Write-Output ('已创建开机自启：' + $startupLnk)
  exit 0
}
New-CourseNoteLink $desktopLnk ''
Write-Output ('已创建桌面快捷方式：' + $desktopLnk)
