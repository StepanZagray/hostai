import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function javaEnvironment() {
  // Use an explicit JDK first. This optional Linux location is a local discovery,
  // never an installation or change to the user's system-wide Java selection.
  const home = process.env.JAVA_HOME || (existsSync('/usr/lib/jvm/java-26-openjdk/bin/java') ? '/usr/lib/jvm/java-26-openjdk' : undefined);
  const executable = home ? resolve(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8' });
  const version = `${result.stdout || ''}${result.stderr || ''}`.match(/version "(\d+)/)?.[1];
  if (result.error || result.status !== 0 || version !== '26') throw new Error('HostAI requires JDK 26. Set JAVA_HOME to your JDK 26 directory.');
  return { ...process.env, ...(home ? { JAVA_HOME: home } : {}) };
}
