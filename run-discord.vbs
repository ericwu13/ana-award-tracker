Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
WshShell.CurrentDirectory = FSO.GetParentFolderName(WScript.ScriptFullName)

If Not FSO.FolderExists("data") Then FSO.CreateFolder("data")
If Not FSO.FolderExists("data\logs") Then FSO.CreateFolder("data\logs")

' One log per month the bot was started in (keep-alive, slash commands, chat agent).
Dim logFile
logFile = "data\logs\discord-bot-" & Year(Now) & "-" & Right("0" & Month(Now), 2) & ".log"

WshShell.Run "cmd /c node discord-bot.js >> """ & logFile & """ 2>&1", 0, True
