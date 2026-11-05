Option Explicit
' bili-course-rep launcher: reuse a running server, otherwise start it hidden, then open the page.
Dim fso, sh, appDir, url, i, nodeExe, silent
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://127.0.0.1:8765"
silent = False
For i = 0 To WScript.Arguments.Count - 1
  If LCase(WScript.Arguments(i)) = "silent" Then silent = True
Next

Function Healthy()
  On Error Resume Next
  Dim x
  Set x = CreateObject("MSXML2.XMLHTTP")
  x.Open "GET", url & "/api/health", False
  x.Send
  If Err.Number = 0 Then
    If x.Status = 200 Then Healthy = True Else Healthy = False
  Else
    Healthy = False
  End If
  Err.Clear
End Function

If Healthy() Then
  If Not silent Then sh.Run url, 1, False
  WScript.Quit 0
End If

sh.CurrentDirectory = appDir
nodeExe = "node"
' 优先用标准安装位置的 node.exe；找不到就退回 PATH 里的 node
Dim nodePath
nodePath = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If fso.FileExists(nodePath) Then nodeExe = Chr(34) & nodePath & Chr(34)
sh.Run nodeExe & " " & Chr(34) & appDir & "\server.mjs" & Chr(34), 0, False

For i = 1 To 60
  WScript.Sleep 250
  If Healthy() Then Exit For
Next

If Not Healthy() Then
  MsgBox "bili-course-rep failed to start. Please make sure Node.js is installed.", 16, "bili-course-rep"
  WScript.Quit 1
End If
If Not silent Then sh.Run url, 1, False
