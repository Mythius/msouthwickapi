const PYTHON = process.env.NOTIFY_PYTHON || "python3";
const SCRIPT = process.env.NOTIFY_SCRIPT || "/home/matthias/Github/gchat/discord.py";

export default async function notify(message: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([PYTHON, SCRIPT, message], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error(`notify failed (exit ${code}):`, await new Response(proc.stderr).text());
      return false;
    }
    return true;
  } catch (err) {
    // Bun.spawn throws synchronously if the executable isn't found
    console.error("notify failed to spawn:", err);
    return false;
  }
}
