const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { exec, spawn } = require('child_process')
const path = require('path')
const fs   = require('fs')
const os   = require('os')

let mainWindow
let keepAlwaysOnTop = true

let psProc     = null   // the persistent PS child process
let psReady    = false  // true once PS has initialised UI Automation
let psQueue    = []     // pending {resolve, marker} waiting for a response
let psBuffer   = ''     // partial stdout accumulator

function flushPSQueue(result = 'TIMEOUT') {
  if (!psQueue.length) return
  const pending = psQueue.splice(0, psQueue.length)
  for (const item of pending) {
    if (item.timer) clearTimeout(item.timer)
    item.resolve(result)
  }
}

function startPersistentPS() {
  if (psProc) return

  psProc = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-NonInteractive', '-Command', '-'
  ], { stdio: ['pipe', 'pipe', 'ignore'] })

  psProc.stdout.setEncoding('utf8')
  psProc.stdout.on('data', chunk => {
    psBuffer += chunk
    let idx
    while ((idx = psBuffer.indexOf('\n')) !== -1) {
      const line = psBuffer.slice(0, idx).trimEnd()
      psBuffer   = psBuffer.slice(idx + 1)
      if (psQueue.length && line === `##DONE:${psQueue[0].marker}##`) {
        const done = psQueue.shift()
        if (done.timer) clearTimeout(done.timer)
        done.resolve(done.lines.join(' ').trim())
      } else if (psQueue.length) {
        psQueue[0].lines.push(line)
      }
    }
  })

  psProc.on('exit', () => {
    flushPSQueue('TIMEOUT')
    psProc  = null
    psReady = false
  })

  sendPS(`
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr i,int x,int y,int w,int ht,uint f);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c,string t);
}
"@
$global:root  = [System.Windows.Automation.AutomationElement]::RootElement
$global:scope = [System.Windows.Automation.TreeScope]::Children
$global:sub   = [System.Windows.Automation.TreeScope]::Subtree
$global:prop  = [System.Windows.Automation.AutomationElement]::NameProperty
$global:ctrl  = [System.Windows.Automation.AutomationElement]::ControlTypeProperty
$global:ttype = [System.Windows.Automation.ControlType]::Text
$global:capWin = $null
$global:lastCaptionText = ""
`).then(() => { psReady = true })
}

// Send one command block and return its output as a promise
let _markerN = 0
function sendPS(script, timeoutMs = 5000) {
  return new Promise(resolve => {
    if (!psProc) { resolve(''); return }
    const marker = `M${++_markerN}`
    const queueItem = { marker, resolve, lines: [], timer: null }
    psQueue.push(queueItem)
    // Append the sentinel line so we know where output ends
    psProc.stdin.write(script + `\nWrite-Output "##DONE:${marker}##"\n`)

    // Timeout to prevent hangs
    queueItem.timer = setTimeout(() => {
      const idx = psQueue.indexOf(queueItem)
      if (idx !== -1) {
        psQueue.splice(idx, 1)
        if (queueItem.timer) clearTimeout(queueItem.timer)
        console.warn('PowerShell command timed out, restarting PS process')
        stopPersistentPS()
        startPersistentPS()
        resolve('TIMEOUT')
      }
    }, timeoutMs)
  })
}

function stopPersistentPS() {
  if (!psProc) return
  try { psProc.stdin.end() } catch {}
  flushPSQueue('TIMEOUT')
  psProc = null
  psReady = false
}

// One-shot PS for launch / hide (called rarely, overhead is fine)
function runPS(script) {
  return new Promise(resolve => {
    const f = path.join(os.tmpdir(), `cap_${Date.now()}.ps1`)
    fs.writeFileSync(f, script, 'utf8')
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${f}"`,
      { timeout: 15000 },
      (err, stdout) => {
        try { fs.unlinkSync(f) } catch {}
        resolve((stdout || '').trim())
      }
    )
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 700, height: 500,
    frame: false, transparent: false,
    alwaysOnTop: true, resizable: true,
    icon: path.join(__dirname, 'assets/logo.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile('renderer/index.html')
  keepAlwaysOnTop = true
  mainWindow.setAlwaysOnTop(true, 'screen-saver')
  mainWindow.on('blur', () => {
    if (keepAlwaysOnTop) mainWindow.setAlwaysOnTop(true, 'screen-saver')
  })
}

app.whenReady().then(() => {
  startPersistentPS()
  createWindow()
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })

// Launch Live Captions
ipcMain.handle('launch-captions', async () => {
  const r = await runPS(`
$p = Get-Process -Name "LiveCaptions" -ErrorAction SilentlyContinue
if (-not $p) {
  Start-Process "LiveCaptions.exe"
  Start-Sleep -Milliseconds 2500
}
Write-Output "ok"
`)
  return r
})

ipcMain.handle('is-always-on-top', () => {
  if (!mainWindow) return false
  return mainWindow.isAlwaysOnTop()
})

// Hide caption window
ipcMain.handle('hide-caption-window', async () => {
  const hideScript = `
$found = $false
foreach ($t in @("Live captions","Live Captions","Captions","LiveCaptions")) {
  $h = [W32]::FindWindow($null,$t)
  if ($h -ne [IntPtr]::Zero) {
    [W32]::SetWindowPos($h,[IntPtr]::Zero,-9999,-9999,0,0,0x0015)
    Write-Output "hidden:$t"
    $found = $true
    break
  }
}
if (-not $found) {
  $p = Get-Process -Name "LiveCaptions" -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    [W32]::SetWindowPos($p.MainWindowHandle,[IntPtr]::Zero,-9999,-9999,0,0,0x0015)
    Write-Output "hidden:proc"
    $found = $true
  }
}
if (-not $found) { Write-Output "not_found" }
`
  if (psProc && psReady) {
    const r = await sendPS(hideScript, 3000)
    return r === 'TIMEOUT' ? 'not_found' : (r || 'not_found')
  }
  // Fallback: one-shot PS when persistent process not yet initialised
  return runPS(`Add-Type @"
using System;
using System.Runtime.InteropServices;
public class U {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr i,int x,int y,int w,int ht,uint f);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c,string t);
}
"@
$found = $false
foreach ($t in @("Live captions","Live Captions","Captions","LiveCaptions")) {
  $h = [U]::FindWindow($null,$t)
  if ($h -ne [IntPtr]::Zero) {
    [U]::SetWindowPos($h,[IntPtr]::Zero,-9999,-9999,0,0,0x0015)
    Write-Output "hidden:$t"
    $found = $true
    break
  }
}
if (-not $found) {
  $p = Get-Process -Name "LiveCaptions" -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    [U]::SetWindowPos($p.MainWindowHandle,[IntPtr]::Zero,-9999,-9999,0,0,0x0015)
    Write-Output "hidden:proc"
    $found = $true
  }
}
if (-not $found) { Write-Output "not_found" }
`)
})

// Read caption text — uses the persistent PS process
ipcMain.handle('read-caption-text', async () => {
  if (!psProc || !psReady) return 'NOT_FOUND'

  const r = await sendPS(`
$win = $global:capWin
if ($win) {
  try { $null = $win.Current.Name } catch { $win = $null; $global:capWin = $null }
}
if (-not $win) {
  foreach ($t in @("Live captions","Live Captions","Captions","LiveCaptions")) {
    $c = New-Object System.Windows.Automation.PropertyCondition($global:prop,$t)
    $w = $global:root.FindFirst($global:scope,$c)
    if ($w) { $win = $w; break }
  }
}
if (-not $win) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $child  = $walker.GetFirstChild($global:root)
  while ($child) {
    try { if ($child.Current.Name -match "(?i)caption") { $win = $child; break } } catch {}
    $child = $walker.GetNextSibling($child)
  }
}
if ($win) {
  $global:capWin = $win
  $tc  = New-Object System.Windows.Automation.PropertyCondition($global:ctrl,$global:ttype)
  $els = $win.FindAll($global:sub,$tc)
  $out = @()
  foreach ($e in $els) { $n = $e.Current.Name.Trim(); if ($n) { $out += $n } }
  if ($out.Count) {
    $txt = $out -join " "
    if ($txt -eq $global:lastCaptionText) {
      Write-Output "__SAME__"
    } else {
      $global:lastCaptionText = $txt
      Write-Output $txt
    }
  } else {
    $global:lastCaptionText = ""
    Write-Output "WINDOW_FOUND_NO_TEXT"
  }
} else {
  $global:capWin = $null
  $global:lastCaptionText = ""
  Write-Output "NOT_FOUND"
}
`, 2000)
  if (r === 'TIMEOUT') return 'NOT_FOUND'
  return r || 'NOT_FOUND'
})

// Show caption window (restore from hidden position)
ipcMain.handle('show-caption-window', async () => {
  const showScript = `
$found = $false
foreach ($t in @("Live captions","Live Captions","Captions","LiveCaptions")) {
  $h = [W32]::FindWindow($null,$t)
  if ($h -ne [IntPtr]::Zero) {
    [W32]::SetWindowPos($h,[IntPtr]::Zero,100,100,800,200,0x0040)
    Write-Output "shown:$t"
    $found = $true
    break
  }
}
if (-not $found) {
  $p = Get-Process -Name "LiveCaptions" -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    [W32]::SetWindowPos($p.MainWindowHandle,[IntPtr]::Zero,100,100,800,200,0x0040)
    Write-Output "shown:proc"
    $found = $true
  }
}
if (-not $found) { Write-Output "not_found" }
`
  if (psProc && psReady) {
    const r = await sendPS(showScript, 3000)
    return r === 'TIMEOUT' ? 'not_found' : (r || 'not_found')
  }
  return runPS(`Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WindowHelper {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr i,int x,int y,int w,int ht,uint f);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c,string t);
}
"@
$found = $false
foreach ($t in @("Live captions","Live Captions","Captions","LiveCaptions")) {
  $h = [WindowHelper]::FindWindow($null,$t)
  if ($h -ne [IntPtr]::Zero) {
    [WindowHelper]::SetWindowPos($h,[IntPtr]::Zero,100,100,800,200,0x0040)
    Write-Output "shown:$t"
    $found = $true
    break
  }
}
if (-not $found) {
  $p = Get-Process -Name "LiveCaptions" -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) {
    [WindowHelper]::SetWindowPos($p.MainWindowHandle,[IntPtr]::Zero,100,100,800,200,0x0040)
    Write-Output "shown:proc"
    $found = $true
  }
}
if (-not $found) { Write-Output "not_found" }
`)
})

// Scan all text elements in the caption window (alternative read method)
ipcMain.handle('read-caption-scan', async () => {
  if (!psProc || !psReady) return 'NOT_FOUND'

  const r = await sendPS(`
$win = $null
foreach ($t in @("Live captions","Live Captions","Captions","LiveCaptions")) {
  $c = New-Object System.Windows.Automation.PropertyCondition($global:prop,$t)
  $w = $global:root.FindFirst($global:scope,$c)
  if ($w) { $win = $w; break }
}
if (-not $win) {
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $child  = $walker.GetFirstChild($global:root)
  while ($child) {
    try { if ($child.Current.Name -match "(?i)caption") { $win = $child; break } } catch {}
    $child = $walker.GetNextSibling($child)
  }
}
if ($win) {
  $tc  = New-Object System.Windows.Automation.PropertyCondition($global:ctrl,$global:ttype)
  $els = $win.FindAll($global:sub,$tc)
  $out = @()
  foreach ($e in $els) { try { $n = $e.Current.Name.Trim(); if ($n) { $out += $n } } catch {} }
  if ($out.Count) { Write-Output ($out -join " ") } else { Write-Output "WINDOW_FOUND_NO_TEXT" }
} else {
  Write-Output "NOT_FOUND"
}
`, 2000)
  if (r === 'TIMEOUT') return 'NOT_FOUND'
  return r || 'NOT_FOUND'
})

// List all top-level windows (diagnostic helper)
ipcMain.handle('list-windows', async () => {
  if (!psProc || !psReady) return []

  const r = await sendPS(`
$walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
$child  = $walker.GetFirstChild($global:root)
$names  = @()
while ($child) {
  try { $n = $child.Current.Name; if ($n) { $names += $n } } catch {}
  $child = $walker.GetNextSibling($child)
}
Write-Output ($names -join "||")
`, 3000)
  if (!r || r === 'TIMEOUT') return []
  return r.split('||').map(s => s.trim()).filter(Boolean)
})

// Summarize text (basic extractive summary — no external API required)
ipcMain.handle('summarize', async (e, text) => {
  if (!text || !text.trim()) return ''
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text]
  const maxSentences = 3
  if (sentences.length <= maxSentences) return text.trim()
  // Return first sentence + last (maxSentences-1) sentences as a simple summary
  const summary = [
    sentences[0],
    ...sentences.slice(-(maxSentences - 1))
  ].join(' ').trim()
  return summary
})

// Export
ipcMain.handle('export-transcript', async (e, text, title) => {
  const safe = (title || 'Untitled recording')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 80)
  const fp = path.join(os.homedir(), 'Downloads', `${safe}.txt`)
  fs.writeFileSync(fp, text, 'utf8')
  return fp
})

ipcMain.handle('open-file', async (e, fp) => { shell.openPath(fp); return 'ok' })
ipcMain.on('minimize', () => mainWindow.minimize())
ipcMain.on('maximize', () => {
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize()
  } else {
    mainWindow.maximize()
  }
})
ipcMain.on('close', () => {
  stopPersistentPS()
  exec('taskkill /IM LiveCaptions.exe /F', () => mainWindow.close())
})

app.on('before-quit', () => {
  stopPersistentPS()
  exec('taskkill /IM LiveCaptions.exe /F')
})
