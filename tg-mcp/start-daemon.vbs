' Starts the tg-mcp daemon hidden (no window). Make a SHORTCUT to this file (not a copy) in the Startup folder:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
' It finds daemon.mjs next to itself and runs it with the 'node' on your PATH (a full path to node.exe works too: edit NODE below).
' A second start is harmless: the new copy sees the port is taken and exits.
Dim fso, dir, NODE
NODE = "node"
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run NODE & " """ & dir & "\daemon.mjs""", 0, False
