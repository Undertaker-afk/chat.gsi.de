/**
 * Ambient declaration for Monaco's Monarch tokenizer registration.
 *
 * It ships no types because it exports nothing -- importing it for the side
 * effect is the entire point. MonacoViewer uses it instead of the
 * `monaco-editor` barrel, which would also drag in the TypeScript/CSS/HTML/JSON
 * language services and their worker chunks (ts.worker alone is 6.7 MB).
 *
 * Kept in its own file with no imports or exports: inside app.d.ts, which is a
 * module, `declare module` is read as augmentation of an existing module rather
 * than an ambient declaration, and fails.
 */
declare module 'monaco-editor/basic-languages/monaco.contribution.js';
