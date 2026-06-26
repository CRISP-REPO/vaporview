/**
 * Stub for `vscode-shiki-bridge` in the standalone host build.
 *
 * The real package reads the user's VSCode color theme (for syntax-highlighted
 * tooltips and the signal color palette). It is `require`d at the top of
 * viewer_provider.ts and pulls in `shiki` + `jsonc-parser` (UMD modules that
 * don't bundle cleanly). The standalone host supplies its own constant color
 * palette and never calls into the theme bridge, so we alias the package to
 * these no-ops and drop the whole shiki/jsonc dependency from the bundle.
 */
export function getUserTheme(): undefined {
	return undefined;
}

export default { getUserTheme };
