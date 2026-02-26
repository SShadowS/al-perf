const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export async function withStatus<T>(message: string, fn: () => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) return fn();

  let i = 0;
  const interval = setInterval(() => {
    process.stderr.write(`\r\x1b[K${frames[i++ % frames.length]} ${message}`);
  }, 80);

  try {
    return await fn();
  } finally {
    clearInterval(interval);
    process.stderr.write("\r\x1b[K");
  }
}
