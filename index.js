// V2 loader resolves file://<dir> to <dir>/index.js (ignores package.json main),
// so re-export the built plugin definition here (same pattern as opencode-pty).
export { default } from "./dist/index.js";
