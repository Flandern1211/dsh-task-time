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
# Fails silently (exit 0); never blocks the caller.
#
# Fire-and-forget: shows the toast immediately and exits. The click-to-focus
# path is handled by DSH Desktop's second-instance (Electron) and the client's
# document.hasFocus() polling + auto-jump.
#
# AppId (AUMID) matters: Windows 11 silently drops toasts under an AUMID with
# no installed app/shortcut. Default borrows DSH Desktop's "ai.deepseek.dsh.desktop".
$ErrorActionPreference = "Stop"
if ($AppId.StartsWith("DSH.")) {
  try {
    $appIdKey = New-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\$AppId" -Force
    $null = $appIdKey.SetValue("DisplayName", "DSH", "String")
  } catch { }
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
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  exit 0
} catch {
  exit 0  # Always exit 0
}