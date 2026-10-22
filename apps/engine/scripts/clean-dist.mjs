import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
rmSync(path.join(packageRoot, "dist"), { recursive: true, force: true });
