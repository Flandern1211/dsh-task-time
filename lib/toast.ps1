param(
  [string]$Title = "DSH",
  [string]$Message = "",
  [switch]$Silent
)
# dsh-task-time Windows WinRT toast (PowerShell 5.1+).
# NOTE: keep this file pure ASCII (no non-ASCII comments) - Windows PowerShell 5.1
# decodes BOM-less UTF-8 as ANSI/GBK, and stray CJK bytes corrupt block parsing.
# Fails silently (exit 1); never blocks the caller.
# -Silent appends <audio silent="true"/> to the toast XML.
$ErrorActionPreference = "Stop"
# AUMID bootstrap: without HKCU AppUserModelId registration, Win10/11 silently
# drops toasts. Write idempotently (no admin needed); failure does not block.
try {
  $appIdKey = New-Item -Path "HKCU:\SOFTWARE\Classes\AppUserModelId\DSH.dsh-task-time" -Force
  $null = $appIdKey.SetValue("DisplayName", "DSH", "String")
} catch {
  # registry unwritable - still try to show the toast
}
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  $null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $texts = $template.GetElementsByTagName("text")
  $texts.Item(0).AppendChild($template.CreateTextNode($Title)) | Out-Null
  $texts.Item(1).AppendChild($template.CreateTextNode($Message)) | Out-Null
  if ($Silent) {
    $audioNode = $template.CreateElement("audio")
    $null = $audioNode.SetAttribute("silent", "true")
    $null = $template.DocumentElement.AppendChild($audioNode)
  }
  $toast = New-Object Windows.UI.Notifications.ToastNotification $template
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("DSH.dsh-task-time").Show($toast) | Out-Null
  exit 0
} catch {
  exit 1
}
