Option Explicit

Dim shell, fso, root, http, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)

If Not ResumeBackground() Then
  shell.Run "wscript.exe """ & root & "\background.vbs""", 0, False
  For i = 1 To 20
    WScript.Sleep 150
    If ResumeBackground() Then Exit For
  Next
End If

Function ResumeBackground()
  On Error Resume Next
  Set http = CreateObject("MSXML2.XMLHTTP.6.0")
  http.Open "POST", "http://127.0.0.1:47831/api/resume", False
  http.Send
  ResumeBackground = (Err.Number = 0 And http.Status >= 200 And http.Status < 300)
  Err.Clear
  On Error GoTo 0
End Function
