' Starts smart-proxy hidden (no window). Put a copy in the Startup folder:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\smart-proxy.vbs
' A second start is harmless: the new copy sees its lock port is taken and exits.
CreateObject("WScript.Shell").Run """C:\Users\Sajjad\AppData\Local\Programs\Python\Python313\python.exe"" ""C:\Users\Sajjad\tools\smart-proxy\smart_proxy.py"" run", 0, False
