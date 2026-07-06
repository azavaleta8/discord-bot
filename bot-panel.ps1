# Discord Bot control panel (Windows / WinForms).
# Start / Stop / Restart the bot and see whether it is running.
# Closing this window leaves the bot running; reopening re-attaches via bot.pid.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$RepoRoot = $PSScriptRoot
$Entry    = Join-Path $RepoRoot 'dist\index.js'
$PidFile  = Join-Path $RepoRoot 'bot.pid'
$OutLog   = Join-Path $RepoRoot 'bot.log'
$ErrLog   = Join-Path $RepoRoot 'bot.err.log'

# --- Bot process helpers -----------------------------------------------------

# Returns the running bot Process, or $null. Treats a stale/recycled PID as gone.
function Get-BotProcess {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    $procId = 0
    if (-not [int]::TryParse(($raw -as [string]), [ref]$procId)) { return $null }
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($null -eq $p) { return $null }
    if ($p.ProcessName -ne 'node') { return $null }   # PID recycled to something else
    return $p
}

function Start-Bot {
    if (Get-BotProcess) { return }   # already running

    if (-not (Test-Path $Entry)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Build not found:`n$Entry`n`nRun 'npm install' then 'npm run build' first.",
            'Discord Bot', 'OK', 'Warning') | Out-Null
        return
    }

    try {
        $p = Start-Process -FilePath 'node' -ArgumentList 'dist\index.js' `
            -WorkingDirectory $RepoRoot -WindowStyle Hidden `
            -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog `
            -PassThru
        Set-Content -Path $PidFile -Value $p.Id -Encoding ascii
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Could not start the bot. Is Node.js installed and on PATH?`n`n$($_.Exception.Message)",
            'Discord Bot', 'OK', 'Error') | Out-Null
    }
}

function Stop-Bot {
    $p = Get-BotProcess
    if ($p) {
        # /T kills child processes too (e.g. an ffmpeg spawned mid-clip).
        & taskkill.exe /PID $p.Id /T /F 2>$null | Out-Null
    }
    Remove-Item $PidFile -ErrorAction SilentlyContinue
}

function Restart-Bot {
    Stop-Bot
    Start-Sleep -Milliseconds 400
    Start-Bot
}

# --- UI ----------------------------------------------------------------------

$form = New-Object System.Windows.Forms.Form
$form.Text            = 'Discord Bot'
$form.Size            = New-Object System.Drawing.Size(340, 250)
$form.StartPosition   = 'CenterScreen'
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox     = $false

$status = New-Object System.Windows.Forms.Label
$status.Location  = New-Object System.Drawing.Point(20, 20)
$status.Size      = New-Object System.Drawing.Size(300, 30)
$status.Font      = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$form.Controls.Add($status)

$btnStart = New-Object System.Windows.Forms.Button
$btnStart.Text     = 'Start'
$btnStart.Location = New-Object System.Drawing.Point(20, 70)
$btnStart.Size     = New-Object System.Drawing.Size(90, 40)
$btnStart.Add_Click({ Start-Bot; Update-Ui })
$form.Controls.Add($btnStart)

$btnStop = New-Object System.Windows.Forms.Button
$btnStop.Text     = 'Stop'
$btnStop.Location = New-Object System.Drawing.Point(120, 70)
$btnStop.Size     = New-Object System.Drawing.Size(90, 40)
$btnStop.Add_Click({ Stop-Bot; Update-Ui })
$form.Controls.Add($btnStop)

$btnRestart = New-Object System.Windows.Forms.Button
$btnRestart.Text     = 'Restart'
$btnRestart.Location = New-Object System.Drawing.Point(220, 70)
$btnRestart.Size     = New-Object System.Drawing.Size(90, 40)
$btnRestart.Add_Click({ Restart-Bot; Update-Ui })
$form.Controls.Add($btnRestart)

$btnLog = New-Object System.Windows.Forms.Button
$btnLog.Text     = 'Open log'
$btnLog.Location = New-Object System.Drawing.Point(20, 125)
$btnLog.Size     = New-Object System.Drawing.Size(290, 30)
$btnLog.Add_Click({
    if (Test-Path $OutLog) { Invoke-Item $OutLog }
    if ((Test-Path $ErrLog) -and (Get-Item $ErrLog).Length -gt 0) { Invoke-Item $ErrLog }
    if (-not (Test-Path $OutLog)) {
        [System.Windows.Forms.MessageBox]::Show('No log yet — start the bot first.',
            'Discord Bot', 'OK', 'Information') | Out-Null
    }
})
$form.Controls.Add($btnLog)

$btnSetup = New-Object System.Windows.Forms.Button
$btnSetup.Text     = 'Install / Build deps'
$btnSetup.Location = New-Object System.Drawing.Point(20, 160)
$btnSetup.Size     = New-Object System.Drawing.Size(290, 30)
$btnSetup.Add_Click({
    # Runs setup.bat in a visible console: checks Node, installs FFmpeg via
    # winget if missing, then 'npm install' + 'npm run build'. Pauses at the end.
    $setup = Join-Path $RepoRoot 'setup.bat'
    if (Test-Path $setup) {
        Start-Process -FilePath $setup -WorkingDirectory $RepoRoot
    } else {
        [System.Windows.Forms.MessageBox]::Show("setup.bat not found in`n$RepoRoot",
            'Discord Bot', 'OK', 'Warning') | Out-Null
    }
})
$form.Controls.Add($btnSetup)

function Update-Ui {
    $p = Get-BotProcess
    if ($p) {
        $status.Text      = ('  Running  (PID {0})' -f $p.Id)
        $status.ForeColor = [System.Drawing.Color]::ForestGreen
        $btnStart.Enabled = $false
        $btnStop.Enabled  = $true
        $btnRestart.Enabled = $true
    } else {
        $status.Text      = '  Stopped'
        $status.ForeColor = [System.Drawing.Color]::Firebrick
        $btnStart.Enabled = $true
        $btnStop.Enabled  = $false
        $btnRestart.Enabled = $false
    }
}

# Poll every 2s so the panel also notices the bot crashing on its own.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Update-Ui })
$timer.Start()

Update-Ui
[System.Windows.Forms.Application]::EnableVisualStyles()
[void]$form.ShowDialog()
$timer.Stop()
