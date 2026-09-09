import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { javaEnvironment } from './java-env.mjs';

const tasks = { dev: ['spring-boot:run'], test: ['verify'], build: ['package'] };
const args = tasks[process.argv[2]];
if (!args) throw new Error('Choose dev, test, or build.');
try {
  const child = spawn('./mvnw', args, { cwd: fileURLToPath(new URL('../backend/', import.meta.url)), env: javaEnvironment(), stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch (error) { console.error(error.message); process.exitCode = 1; }
