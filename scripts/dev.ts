/**
 * Sobe API e web juntos com saída prefixada. Se um cair, derruba o outro.
 * Substitui o `concurrently` para não carregar dependência só para isso.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'

const tasks = [
  { name: 'api', color: 36, workspace: '@notbroker/api' },
  { name: 'web', color: 35, workspace: '@notbroker/web' },
]

const children: ChildProcess[] = []

for (const task of tasks) {
  const prefix = `\x1b[${task.color}m[${task.name}]\x1b[0m `
  // Comando em string única: o shell é necessário para achar o npm.cmd no Windows.
  const child = spawn(`npm run dev -w ${task.workspace}`, {
    shell: true,
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) => {
    let buffer = ''
    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) out.write(`${prefix}${line}\n`)
    })
  }
  if (child.stdout) pipe(child.stdout, process.stdout)
  if (child.stderr) pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    process.stderr.write(`${prefix}encerrado (código ${code ?? 'sinal'})\n`)
    shutdown(code ?? 1)
  })
  children.push(child)
}

let stopping = false
function shutdown(code: number): void {
  if (stopping) return
  stopping = true
  for (const child of children) killTree(child)
  process.exit(code)
}

/** No Windows, kill() derruba só o shell e deixa o node filho órfão segurando a porta. */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    child.kill()
  }
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
