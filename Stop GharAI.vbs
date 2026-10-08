' Stops GharAI (whatever is serving http://localhost:8000).
CreateObject("WScript.Shell").Run "powershell -NoProfile -WindowStyle Hidden -Command ""Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }""", 0, True
MsgBox "GharAI has been stopped.", vbInformation, "GharAI"
