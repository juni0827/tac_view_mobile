import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Builder, By, until } from 'selenium-webdriver';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const appBinary = path.join(rootDir, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'tac_view.exe' : 'tac_view');

function spawnChecked(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
      ...options,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAppRoot(driver, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const appRoots = await driver.findElements(By.css('[data-testid="app-root"]'));
    if (appRoots.length > 0) {
      return appRoots[0];
    }

    const bodies = await driver.findElements(By.css('body'));
    if (bodies.length > 0) {
      await driver.actions().move({ origin: bodies[0], x: 8, y: 8 }).click().perform().catch(() => {});
    }

    await delay(1_000);
  }

  throw new Error('Timed out waiting for the TAC_VIEW app root');
}

async function cleanupDesktopProcesses() {
  if (process.platform !== 'win32') {
    return;
  }

  const commands = [
    'taskkill /IM tac_view.exe /T /F',
    'taskkill /IM tac_view-sidecar.exe /T /F',
    'taskkill /IM tac_view-sidecar-*.exe /T /F',
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq \'node.exe\' -and $_.CommandLine -like \'*tac_view-sidecar.cjs*\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
  ];

  for (const command of commands) {
    await new Promise((resolve) => {
      const child = spawn(command, {
        cwd: rootDir,
        stdio: 'ignore',
        shell: true,
      });
      child.on('exit', () => resolve());
    });
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(command, fallbacks = []) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  for (const candidate of fallbacks) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function main() {
  await cleanupDesktopProcesses();

  const cargoPath = await resolveCommand('cargo', [
    'C:\\Windows\\Temp\\cargo-bin\\cargo.exe',
    path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'cargo.exe'),
  ]);
  if (!cargoPath) {
    throw new Error('cargo is required for desktop smoke tests');
  }

  const tauriDriverPath = await resolveCommand('tauri-driver', [
    'C:\\Windows\\Temp\\cargo-bin\\tauri-driver.exe',
    path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'tauri-driver.exe'),
  ]);
  if (!tauriDriverPath) {
    throw new Error('tauri-driver is required for desktop smoke tests');
  }

  const nativeDriverPath = await resolveCommand('msedgedriver', [
    path.join(
      process.env.LOCALAPPDATA ?? '',
      'Microsoft',
      'WinGet',
      'Packages',
      'Microsoft.EdgeDriver_Microsoft.Winget.Source_8wekyb3d8bbwe',
      'msedgedriver.exe',
    ),
  ]);
  if (!nativeDriverPath) {
    throw new Error('msedgedriver is required for desktop smoke tests');
  }

  await spawnChecked('npx', ['tauri', 'build', '--debug', '--no-bundle'], {
    env: {
      ...process.env,
      PATH: [path.dirname(cargoPath), process.env.PATH].filter(Boolean).join(path.delimiter),
    },
  });
  await access(appBinary);

  const tauriDriver = spawn(tauriDriverPath, ['--native-driver', nativeDriverPath], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });

  let driver;
  try {
    await delay(3000);

    driver = await new Builder()
      .usingServer('http://127.0.0.1:4444/')
      .withCapabilities({
        browserName: 'wry',
        'tauri:options': {
          application: appBinary,
        },
      })
      .build();

    await waitForAppRoot(driver);

    await driver.wait(until.elementLocated(By.css('[data-testid="operations-panel"]')), 60_000);
    await driver.wait(until.elementLocated(By.css('[data-testid="cctv-panel"]')), 60_000);
    await driver.wait(until.elementLocated(By.css('[data-testid="audio-toggle"]')), 60_000);

    const operationsText = await driver.findElement(By.css('[data-testid="operations-panel"]')).getText();
    if (!operationsText.includes('GOOGLE 3D') || !operationsText.includes('RESET VIEW')) {
      throw new Error('operations panel did not render expected controls');
    }

    await driver.findElement(By.xpath("//*[contains(text(), 'CRT')]")).click();
    await driver.findElement(By.xpath("//*[contains(text(), 'OSM')]")).click();
    await driver.findElement(By.css('[data-testid="audio-toggle"]')).click();
  } finally {
    if (driver) {
      await driver.quit().catch(() => {});
    }
    tauriDriver.kill();
    await cleanupDesktopProcesses();
  }
}

main().catch((error) => {
  console.error('[desktop-smoke] failed:', error);
  process.exitCode = 1;
});
