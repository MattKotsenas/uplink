/** Render shell command output as a terminal-styled block. */
export function renderShellOutput(
  command: string,
  stdout: string,
  stderr: string,
  exitCode: number,
): HTMLElement {
  const container = document.createElement('div');
  container.className = 'shell-output';

  const header = document.createElement('div');
  header.className = 'command';
  header.textContent = `$ ${command}`;
  container.appendChild(header);

  if (stdout) {
    const out = document.createElement('pre');
    out.className = 'stdout';
    out.textContent = stdout;
    container.appendChild(out);
  }

  if (stderr) {
    const err = document.createElement('pre');
    err.className = 'stderr';
    err.textContent = stderr;
    container.appendChild(err);
  }

  if (exitCode !== 0) {
    const code = document.createElement('div');
    code.className = 'exit-code';
    code.textContent = `exit code ${exitCode}`;
    container.appendChild(code);
  }

  return container;
}
