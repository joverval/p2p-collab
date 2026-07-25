import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: false,
  // ponytail: dts:false + tsc --emitDeclarationOnly (tsup's rollup-plugin-dts doesn't support TS 7 yet)
  //          switch to dts:true when tsup ships TS 7-compatible rollup-plugin-dts
  sourcemap: true,
  clean: true,
});