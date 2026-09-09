const { app, BrowserWindow, Menu, dialog, shell } = require('electron')
const { mkdirSync } = require('node:fs')

// The renderer is exactly the browser app. It receives no Node or Electron API.
const address = new URL(process.env.HOSTAI_UI_URL || 'http://127.0.0.1:3000')
if (address.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) || address.username || address.password) {
  throw new Error('HostAI desktop can only load a local HTTP workspace.')
}
if (process.env.HOSTAI_DESKTOP_USER_DATA) {
  mkdirSync(process.env.HOSTAI_DESKTOP_USER_DATA, { recursive: true, mode: 0o700 })
  app.setPath('userData', process.env.HOSTAI_DESKTOP_USER_DATA)
}
app.setName('HostAI')
if (process.env.HOSTAI_SOFTWARE_RENDERING === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-dev-shm-usage')
}
// npm's development binary has no root-owned SUID helper. Use Chromium's
// unprivileged user-namespace sandbox on Linux; renderer sandboxing stays on.
if (process.platform === 'linux' && !app.isPackaged) app.commandLine.appendSwitch('disable-setuid-sandbox')
const allowedExternalHosts = new Set(['docs.ollama.com', 'ollama.com', 'github.com'])
let mainWindow

function openDocumentation(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && allowedExternalHosts.has(url.hostname) && !url.username && !url.password) void shell.openExternal(url.href)
  } catch { /* Ignore invalid navigation. */ }
}
async function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'HostAI', width: 1380, height: 940, minWidth: 360, minHeight: 600,
    backgroundColor: '#f5f7fa', show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, spellcheck: false },
  })
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  mainWindow.webContents.session.setPermissionCheckHandler(() => false)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { openDocumentation(url); return { action: 'deny' } })
  mainWindow.webContents.on('will-navigate', (event, value) => {
    if (new URL(value).origin !== address.origin) { event.preventDefault(); openDocumentation(value) }
  })
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
  await mainWindow.loadURL(address.href)
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'Workspace', submenu: [
      { label: 'Open in browser', click: () => void shell.openExternal(address.href) },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
  ]))
  await createWindow()
}).catch(error => { dialog.showErrorBox('Could not open HostAI', `${error.message}\nStart the workspace with pnpm desktop:dev.`); app.quit() })
app.on('window-all-closed', () => app.quit())
