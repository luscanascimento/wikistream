/**
 * Newline-delimited JSON files are loaded as text (see the `loader` option in
 * angular.json), so importing one gives the raw file contents.
 */
declare module '*.ndjson' {
  const contents: string;
  export default contents;
}
