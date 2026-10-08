' Starts GharAI in the background (no command window) and opens it in your browser.
' If GharAI is already running, it just opens the page.
Option Explicit
Const URL = "http://localhost:8000/"
Dim sh, fso, appDir, py, q, i
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
py = appDir & "\.venv\Scripts\python.exe"
q = Chr(34)

Function IsRunning()
    Dim http
    IsRunning = False
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
    http.setTimeouts 1000, 1000, 1000, 1000
    http.Open "GET", URL, False
    http.Send
    If Err.Number = 0 Then
        If http.Status = 200 Then IsRunning = True
    End If
    Err.Clear
    On Error GoTo 0
End Function

If Not IsRunning() Then
    If Not fso.FileExists(py) Then
        MsgBox "Can't find Python at:" & vbCrLf & py, vbExclamation, "GharAI"
        WScript.Quit 1
    End If
    sh.CurrentDirectory = appDir
    ' window style 0 = hidden; output goes to server_log.txt for troubleshooting
    sh.Run "cmd /c " & q & q & py & q & " -m uvicorn backend.main:app --port 8000 > server_log.txt 2>&1" & q, 0, False
    For i = 1 To 60
        WScript.Sleep 500
        If IsRunning() Then Exit For
    Next
    If Not IsRunning() Then
        MsgBox "GharAI didn't start. Details are in server_log.txt in:" & vbCrLf & appDir, vbExclamation, "GharAI"
        WScript.Quit 1
    End If
End If
sh.Run URL
