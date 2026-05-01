Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
WshShell.CurrentDirectory = FSO.GetParentFolderName(WScript.ScriptFullName)

If Not FSO.FolderExists("data") Then FSO.CreateFolder("data")
If Not FSO.FolderExists("data\logs") Then FSO.CreateFolder("data\logs")

Dim y, m, d, logFile
y = Year(Now)
m = Right("0" & Month(Now), 2)
d = Right("0" & Day(Now), 2)
logFile = "data\logs\run-" & y & "-" & m & "-" & d & ".log"

WshShell.Run "cmd /c node run-once.js >> """ & logFile & """ 2>&1", 0, True
