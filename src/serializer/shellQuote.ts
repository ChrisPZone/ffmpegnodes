// Shell quoting for the command preview only. Execution passes argv directly, without a shell.

export type ShellFlavor = "posix" | "powershell";

const SAFE = /^[A-Za-z0-9_\-+=.,/:@%^]+$/;

export function quoteArg(arg: string, flavor: ShellFlavor): string {
  if (arg !== "" && SAFE.test(arg)) return arg;
  if (flavor === "posix") {
    if (!/["$`\\!]/.test(arg)) return `"${arg}"`;
    return `'${arg.replace(/'/g, `'\\''`)}'`;
  }
  // PowerShell: double quotes expand $ and `, single quotes are literal ('' escapes ').
  if (!/["$`]/.test(arg)) return `"${arg}"`;
  return `'${arg.replace(/'/g, "''")}'`;
}

export function formatCommand(program: string, args: string[], flavor: ShellFlavor): string {
  return [program, ...args].map((a) => quoteArg(a, flavor)).join(" ");
}

export function defaultFlavor(): ShellFlavor {
  return typeof navigator !== "undefined" && /Win/i.test(navigator.platform || navigator.userAgent) ? "powershell" : "posix";
}
