' Starts the VPN watchdog hidden (no window). Put a copy in the Startup folder:
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\vpn-watchdog.vbs
' A second start is harmless: the new copy sees the lock port is taken and exits.
CreateObject("WScript.Shell").Run """C:\Users\Sajjad\AppData\Local\Programs\Python\Python313\python.exe"" ""C:\Users\Sajjad\tools\vpn-watchdog\watchdog.py""", 0, False
