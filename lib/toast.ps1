param(
  [string]$Title = "DSH",
  [string]$Message = "",
  [string]$AppId = "ai.deepseek.dsh.desktop",
  [switch]$Silent,
  [string]$Launch = "",
  [string]$Tag = "",
  [string]$Sound = ""
)
# dsh-task-time Windows WinRT toast (PowerShell 5.1+).
# NOTE: keep this file pure ASCII (no non-ASCII comments) - Windows PowerShell 5.1
# decodes BOM-less UTF-8 as ANSI/GBK, and stray CJK bytes corrupt block parsing.
# Fails silently (exit 1); never blocks the caller.
# -Silent appends <audio silent="true"/> to the toast XML.
# -Sound sets a custom audio source, e.g. "ms-winsoundevent:Notification.Reminder"
#   or "ms-winsoundevent:Notification.Looping.Alarm" (overrides -Silent).
# -Launch sets the toast activation argument (e.g. dshjump:<sessionId>).
#
# This script stays alive after showing the toast and listens for the user's
# click via the Activated event. When clicked, it writes the jump file to
# $env:USERPROFILE\.dsh\dsh-task-time-pending-jump.json and brings DSH to
# foreground, bypassing Electron's second-instance event chain entirely.
# Exits after 60s or when the toast is dismissed/fails, whichever comes first.
#
# AppId (AUMID) matters: Windows 11 silently drops toasts shown under an AUMID
# that has no installed app/shortcut behind it, even when Show() succeeds and
# the notification count registry advances. The default therefore borrows the
# DSH Desktop app's own AUMID ("ai.deepseek.dsh.desktop"), which the installer
# registers and which Windows treats as a first-class notification source.
$ErrorActionPreference = "Stop"
if ($AppId.StartsWith("DSH.")) {
  try {
    $appIdKey = New-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\$AppId" -Force
    $null = $appIdKey.SetValue("DisplayName", "DSH", "String")
  } catch { }
}
# Extract sessionId from Launch (dshjump:<sessionId>)
$sessionId = ""
if ($Launch -match '^dshjump:(.+)$') { $sessionId = $Matches[1] }
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName("text")
  $texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
  $texts.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
  if ($Sound -and $Sound.Trim() -ne "") {
    $audioNode = $template.CreateElement("audio")
    $null = $audioNode.SetAttribute("src", $Sound.Trim())
    $null = $template.DocumentElement.AppendChild($audioNode)
  } elseif ($Silent) {
    $audioNode = $template.CreateElement("audio")
    $null = $audioNode.SetAttribute("silent", "true")
    $null = $template.DocumentElement.AppendChild($audioNode)
  }
  if ($Launch) {
    $toastNode = $template.SelectSingleNode("/toast")
    $null = $toastNode.SetAttribute("launch", $Launch)
  }
  $toast = New-Object Windows.UI.Notifications.ToastNotification $template
  if ($Tag) { $toast.Tag = $Tag }
  # ---------- Event-driven activation ----------
  # Stay alive and wait for the user to click/dismiss the toast.
  # When clicked: write jump file + bring DSH to foreground.
  # Exits after 60s timeout or on dismiss/fail.
  $doneEvent = New-Object System.Threading.ManualResetEvent $false
  $global:TT_ACTIVATED = $false
  $global:TT_SESSION_ID = $sessionId
  # Use Register-ObjectEvent for reliable WinRT event handling in PowerShell 5.1
  $activatedHandler = Register-ObjectEvent -InputObject $toast -EventName Activated -MessageData $doneEvent -Action {
    $global:TT_ACTIVATED = $true
    [System.Threading.ManualResetEvent]$Event.MessageData.Set()
  }
  $doneHandler = Register-ObjectEvent -InputObject $toast -EventName Dismissed -MessageData $doneEvent -Action {
    [System.Threading.ManualResetEvent]$Event.MessageData.Set()
  }
  $failedHandler = Register-ObjectEvent -InputObject $toast -EventName Failed -MessageData $doneEvent -Action {
    [System.Threading.ManualResetEvent]$Event.MessageData.Set()
  }
  # Show the toast
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  # Wait for user interaction or timeout (60 seconds)
  $doneEvent.WaitOne(60000) | Out-Null
  # Clean up event subscriptions
  try { Unregister-Event -SourceIdentifier $activatedHandler.Name -ErrorAction SilentlyContinue } catch { }
  try { Unregister-Event -SourceIdentifier $doneHandler.Name -ErrorAction SilentlyContinue } catch { }
  try { Unregister-Event -SourceIdentifier $failedHandler.Name -ErrorAction SilentlyContinue } catch { }
  # If user clicked the toast, write jump file and foreground DSH
  if ($global:TT_ACTIVATED -and $global:TT_SESSION_ID) {
    $jumpDir = Join-Path $env:USERPROFILE ".dsh"
    $null = New-Item -Path $jumpDir -ItemType Directory -Force -ErrorAction SilentlyContinue
    $jumpFile = Join-Path $jumpDir "dsh-task-time-pending-jump.json"
    $jumpData = @{ sessionId = $global:TT_SESSION_ID; ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }
    $jumpText = $jumpData | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($jumpFile, $jumpText)
    # Bring DSH Desktop to foreground
    try {
      $dshProcess = Get-Process | Where-Object { $_.MainWindowTitle -like "*DSH*" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
      if ($dshProcess) {
        Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@ -Name Win32 -Namespace Toast -ErrorAction SilentlyContinue
        if ([Toast.Win32]::ShowWindowAsync($dshProcess.MainWindowHandle, 9)) { # SW_RESTORE
          [Toast.Win32]::SetForegroundWindow($dshProcess.MainWindowHandle) | Out-Null
        }
      }
    } catch {
      # Fallback: try Shell.Application
      try {
        $shell = New-Object -ComObject "Shell.Application"
        $shell.Windows() | Where-Object { $_.LocationName -like "*DSH*" } | ForEach-Object { $_.Visible = $true }
      } catch { }
    }
  }
  exit 0
} catch {
  exit 1
}