import esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  minify: true,
  logLevel: "info"
});
