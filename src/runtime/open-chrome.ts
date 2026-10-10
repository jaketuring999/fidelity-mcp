import { spawn } from 'node:child_process';

export function openChrome(): Promise<void> {
  return new Promise((resolve, reject) => {
    // Existing Chrome owns its normal profile. No remote debugging flags.
    const child =
      process.platform === 'darwin'
        ? spawn('open', ['-a', 'Google Chrome'], { stdio: 'ignore' })
        : spawn('google-chrome', [], { stdio: 'ignore', detached: true });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
