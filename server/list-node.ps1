Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Select-Object ProcessId, @{n='Cmd'; e = { $_.CommandLine }} |
    Format-Table -AutoSize -Wrap
