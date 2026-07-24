import { resolve } from "node:path";

export function resolveDataRoot(dataRoot = process.env.NARRALUME_DATA_DIR ?? "data") {
  return resolve(dataRoot);
}
