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
#
# AppId (AUMID) matters: Windows 11 silently drops toasts shown under an AUMID
# that has no installed app/shortcut behind it, even when Show() succeeds and
# the notification count registry advances. The default therefore borrows the
# DSH Desktop app's own AUMID ("ai.deepseek.dsh.desktop"), which the installer
# registers and which Windows treats as a first-class notification source.
# The plugin's historical own AUMID "DSH.dsh-task-time" is kept only as an
# explicit opt-in (registry bootstrap below) for environments without DSH Desktop.
$ErrorActionPreference = "Stop"
# AUMID bootstrap: registry-only AppUserModelId entries are unreliable on Win11
# (toasts may be dropped without error), so only bother for our own DSH.* ids;
# never touch another app's registration.
if ($AppId.StartsWith("DSH.")) {
  try {
    $appIdKey = New-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\$AppId" -Force
    $null = $appIdKey.SetValue("DisplayName", "DSH", "String")
  } catch {
    # registry unwritable - still try to show the toast
  }
}
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
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast) | Out-Null
  exit 0
} catch {
  exit 1
}
