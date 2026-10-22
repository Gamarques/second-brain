export function argument(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const match = process.argv.find((value) => value.startsWith(prefix));
  return match === undefined ? fallback : match.slice(prefix.length);
}
